import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Outils donnés au modèle pour travailler dans l'espace de travail de l'hôte.
 * Les outils de lecture s'exécutent directement ; toute écriture ou commande
 * doit être validée par l'hôte dans VS Code.
 */

export type AgentMode = 'full' | 'readOnly' | 'off';

/** Préparation d'un appel : titre affiché et, pour les actions sensibles, demande de validation. */
export interface PreparedCall {
  title: string;
  approval?: {
    /** Détail affiché dans la demande de validation (commande, fichier…). */
    detail: string;
    /** Modification proposée, affichable sous forme de diff. */
    diff?: { uri: vscode.Uri; original: string; modified: string };
  };
  /** Exécute l'action ; renvoie le résultat pour le modèle et un résumé pour le chat. */
  execute(signal: AbortSignal): Promise<{ result: string; summary?: string }>;
}

interface AgentTool {
  definition: vscode.LanguageModelChatTool;
  /** true : écriture ou exécution, soumise à validation et exclue en lecture seule. */
  sensitive: boolean;
  prepare(input: Record<string, unknown>): Promise<PreparedCall>;
}

const MAX_READ_CHARS = 60_000;
const MAX_READ_LINES = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_OUTPUT = 20_000;
const COMMAND_TIMEOUT_MS = 120_000;
const EXCLUDE_GLOB = '**/{node_modules,.git,dist,out,build,.venv,__pycache__}/**';

export const PROPOSAL_SCHEME = 'shared-copilot-proposal';

/** Fournit le contenu des fichiers « proposés » pour l'affichage des diffs. */
export class ProposalContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private next = 1;

  register(content: string, fileName: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/${this.next++}/${fileName}` });
    this.contents.set(uri.toString(), content);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  clear(): void {
    this.contents.clear();
  }
}

export class WorkspaceTools {
  private readonly tools: AgentTool[];

  constructor(
    private readonly proposals: ProposalContentProvider,
    output: vscode.OutputChannel,
  ) {
    this.tools = [
      listDirectoryTool(),
      findFilesTool(),
      readFileTool(),
      searchTextTool(),
      diagnosticsTool(),
      editFileTool(),
      createFileTool(),
      runCommandTool(output),
    ];
  }

  /** Mode effectif : un espace de travail non approuvé ou sans dossier limite les outils. */
  effectiveMode(): AgentMode {
    const configured = vscode.workspace.getConfiguration('sharedCopilotChat').get<AgentMode>('agentMode', 'full');
    if (configured === 'off' || !vscode.workspace.workspaceFolders?.length) {
      return 'off';
    }
    return vscode.workspace.isTrusted ? configured : 'readOnly';
  }

  definitions(): vscode.LanguageModelChatTool[] {
    const mode = this.effectiveMode();
    if (mode === 'off') {
      return [];
    }
    return this.tools.filter((t) => mode === 'full' || !t.sensitive).map((t) => t.definition);
  }

  /** Consignes pour le prompt système, décrivant l'espace de travail et les règles d'usage des outils. */
  instructions(): string {
    const mode = this.effectiveMode();
    if (mode === 'off') {
      return "Tu n'as pas accès aux fichiers de l'hôte : réponds à partir de la conversation et du contexte partagé.";
    }
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => `« ${f.name} »`).join(', ');
    const lines = [
      `Tu as accès à l'espace de travail VS Code de l'hôte (dossiers : ${folders}) via des outils.`,
      'Les chemins sont relatifs à la racine du dossier ; en multi-dossier, préfixe-les par le nom du dossier.',
      'Avant de répondre sur le code, explore-le : liste, cherche et lis les fichiers utiles plutôt que de supposer leur contenu.',
    ];
    if (mode === 'full') {
      lines.push(
        "Tu peux modifier ou créer des fichiers et lancer des commandes : chaque action est soumise à la validation de l'hôte, qui peut refuser.",
        'Pour modifier un fichier, lis-le d\'abord puis utilise edit_file avec un extrait exact et unique du contenu actuel.',
        "N'effectue une modification ou une commande que si la demande le justifie clairement.",
      );
    } else {
      lines.push('Tu es en lecture seule : propose les modifications dans ta réponse, sans les appliquer.');
    }
    return lines.join('\n');
  }

  async prepare(name: string, input: unknown): Promise<PreparedCall & { sensitive: boolean }> {
    const tool = this.tools.find((t) => t.definition.name === name);
    const mode = this.effectiveMode();
    if (!tool || mode === 'off' || (tool.sensitive && mode !== 'full')) {
      throw new Error(`Outil « ${name} » indisponible.`);
    }
    const args = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    const prepared = await tool.prepare(args);
    return { ...prepared, sensitive: tool.sensitive };
  }

  /**
   * Demande à l'hôte de valider une action. Pour une modification de fichier,
   * propose d'afficher le diff avant de décider.
   */
  async requestApproval(call: PreparedCall, author: string): Promise<boolean> {
    const approval = call.approval;
    if (!approval) {
      return true;
    }
    const allow = 'Autoriser';
    const showDiff = 'Voir les modifications';
    const buttons = approval.diff ? [allow, showDiff] : [allow];
    const choice = await vscode.window.showWarningMessage(
      `Shared Copilot — question de ${author} : ${call.title}`,
      { modal: true, detail: approval.detail },
      ...buttons,
    );
    if (choice === allow) {
      return true;
    }
    if (choice !== showDiff || !approval.diff) {
      return false;
    }
    const { uri, original, modified } = approval.diff;
    const name = path.basename(uri.path);
    const left = this.proposals.register(original, name);
    const right = this.proposals.register(modified, name);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${name} : modification proposée (Shared Copilot)`, {
      preview: true,
    });
    // Non modale, pour pouvoir parcourir le diff avant de répondre.
    const decision = await vscode.window.showWarningMessage(
      `Shared Copilot — appliquer la modification proposée pour ${author} : ${call.title} ?`,
      allow,
      'Refuser',
    );
    return decision === allow;
  }
}

// ---- Résolution des chemins ----

function workspaceFolders(): readonly vscode.WorkspaceFolder[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    throw new Error("Aucun dossier n'est ouvert dans VS Code chez l'hôte.");
  }
  return folders;
}

/** Convertit un chemin donné par le modèle en URI, en refusant tout ce qui sort de l'espace de travail. */
function resolvePath(raw: unknown): vscode.Uri {
  const folders = workspaceFolders();
  const input = typeof raw === 'string' && raw.trim() ? raw.trim() : '.';
  let folder = folders[0];
  let rel = input;

  if (path.isAbsolute(input)) {
    const owner = folders.find((f) => isInside(f.uri.fsPath, input));
    if (!owner) {
      throw new Error(`Chemin hors de l'espace de travail : ${input}`);
    }
    folder = owner;
    rel = path.relative(owner.uri.fsPath, input);
  } else if (folders.length > 1) {
    const [head, ...rest] = input.split(/[\\/]/);
    const named = folders.find((f) => f.name === head);
    if (named) {
      folder = named;
      rel = rest.join('/') || '.';
    }
  }
  const full = path.resolve(folder.uri.fsPath, rel);
  if (!isInside(folder.uri.fsPath, full)) {
    throw new Error(`Chemin hors de l'espace de travail : ${input}`);
  }
  return vscode.Uri.file(full);
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function display(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : undefined;
}

async function readText(uri: vscode.Uri): Promise<string> {
  // Un document ouvert peut contenir des modifications non enregistrées : on lit celles-là.
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    return open.getText();
  }
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type & vscode.FileType.Directory) {
    throw new Error(`${display(uri)} est un dossier.`);
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`${display(uri)} est trop volumineux (${Math.round(stat.size / 1024)} Ko).`);
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.subarray(0, 8000).includes(0)) {
    throw new Error(`${display(uri)} est un fichier binaire.`);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

// ---- Outils de lecture ----

function listDirectoryTool(): AgentTool {
  return {
    sensitive: false,
    definition: {
      name: 'list_directory',
      description: "Liste le contenu d'un dossier de l'espace de travail (les sous-dossiers se terminent par /).",
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Dossier relatif à la racine ; « . » pour la racine.' } },
      },
    },
    async prepare(input) {
      const uri = resolvePath(input.path);
      return {
        title: `Liste de ${display(uri) || '.'}`,
        async execute() {
          const entries = await vscode.workspace.fs.readDirectory(uri);
          entries.sort(([a, ta], [b, tb]) => (tb & vscode.FileType.Directory) - (ta & vscode.FileType.Directory) || a.localeCompare(b));
          const lines = entries.slice(0, 500).map(([name, type]) => (type & vscode.FileType.Directory ? `${name}/` : name));
          if (entries.length > 500) {
            lines.push(`… ${entries.length - 500} entrées de plus`);
          }
          return { result: lines.join('\n') || '(dossier vide)', summary: `${entries.length} entrée(s)` };
        },
      };
    },
  };
}

function findFilesTool(): AgentTool {
  return {
    sensitive: false,
    definition: {
      name: 'find_files',
      description: 'Trouve des fichiers par motif glob (ex. « **/*.ts », « src/**/config*.json »). Ignore node_modules, .git, dist…',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Motif glob relatif aux dossiers de l\'espace de travail.' },
          maxResults: { type: 'number', description: 'Nombre maximal de résultats (défaut 200).' },
        },
        required: ['pattern'],
      },
    },
    async prepare(input) {
      workspaceFolders();
      const pattern = str(input.pattern);
      if (!pattern) {
        throw new Error('Paramètre « pattern » manquant.');
      }
      const max = Math.min(int(input.maxResults) ?? 200, 1000);
      return {
        title: `Recherche de fichiers « ${pattern} »`,
        async execute() {
          const uris = await vscode.workspace.findFiles(pattern, EXCLUDE_GLOB, max);
          const lines = uris.map(display).sort();
          return { result: lines.join('\n') || 'Aucun fichier trouvé.', summary: `${uris.length} fichier(s)` };
        },
      };
    },
  };
}

function readFileTool(): AgentTool {
  return {
    sensitive: false,
    definition: {
      name: 'read_file',
      description: `Lit un fichier texte de l'espace de travail, éventuellement une plage de lignes (numérotées à partir de 1). Au plus ${MAX_READ_LINES} lignes par appel.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Chemin du fichier.' },
          startLine: { type: 'number', description: 'Première ligne (incluse).' },
          endLine: { type: 'number', description: 'Dernière ligne (incluse).' },
        },
        required: ['path'],
      },
    },
    async prepare(input) {
      const uri = resolvePath(input.path);
      const start = Math.max(1, int(input.startLine) ?? 1);
      const requestedEnd = int(input.endLine);
      return {
        title: `Lecture de ${display(uri)}${requestedEnd || start > 1 ? ` (lignes ${start}-${requestedEnd ?? 'fin'})` : ''}`,
        async execute() {
          const lines = (await readText(uri)).split(/\r?\n/);
          const end = Math.min(lines.length, requestedEnd ?? lines.length, start + MAX_READ_LINES - 1);
          let body = lines.slice(start - 1, end).join('\n');
          let truncated = end < (requestedEnd ?? lines.length);
          if (body.length > MAX_READ_CHARS) {
            body = body.slice(0, MAX_READ_CHARS);
            truncated = true;
          }
          const header = `${display(uri)} — lignes ${start}-${end} sur ${lines.length}${truncated ? ' (tronqué : relis la suite avec startLine)' : ''}`;
          return { result: `${header}\n${body}`, summary: `lignes ${start}-${end} sur ${lines.length}` };
        },
      };
    },
  };
}

function searchTextTool(): AgentTool {
  return {
    sensitive: false,
    definition: {
      name: 'search_text',
      description: "Cherche un texte ou une expression régulière dans les fichiers de l'espace de travail. Renvoie chemin:ligne: contenu.",
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Texte ou expression régulière à chercher.' },
          isRegex: { type: 'boolean', description: 'true si query est une expression régulière (défaut false).' },
          includePattern: { type: 'string', description: 'Glob pour limiter les fichiers (ex. « src/**/*.ts »).' },
          maxResults: { type: 'number', description: 'Nombre maximal de lignes (défaut 100).' },
        },
        required: ['query'],
      },
    },
    async prepare(input) {
      const folders = workspaceFolders();
      const query = str(input.query);
      if (!query) {
        throw new Error('Paramètre « query » manquant.');
      }
      const isRegex = input.isRegex === true;
      const include = str(input.includePattern);
      const max = Math.min(int(input.maxResults) ?? 100, 500);
      return {
        title: `Recherche de « ${query.length > 40 ? `${query.slice(0, 39)}…` : query} »`,
        async execute(signal) {
          const rg = findRipgrep();
          const hits = rg
            ? await searchWithRipgrep(rg, folders, query, isRegex, include, max, signal)
            : await searchWithScan(query, isRegex, include, max);
          return {
            result: hits.length ? hits.join('\n') : 'Aucun résultat.',
            summary: `${hits.length}${hits.length >= max ? '+' : ''} résultat(s)`,
          };
        },
      };
    },
  };
}

function diagnosticsTool(): AgentTool {
  return {
    sensitive: false,
    definition: {
      name: 'get_diagnostics',
      description: "Renvoie les erreurs et avertissements (compilateur, linter) connus de VS Code, pour un fichier ou tout l'espace de travail.",
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Fichier à examiner ; absent : tout l\'espace de travail.' } },
      },
    },
    async prepare(input) {
      const uri = input.path ? resolvePath(input.path) : undefined;
      return {
        title: uri ? `Diagnostics de ${display(uri)}` : 'Diagnostics de l’espace de travail',
        async execute() {
          const all: [vscode.Uri, readonly vscode.Diagnostic[]][] = uri
            ? [[uri, vscode.languages.getDiagnostics(uri)]]
            : vscode.languages.getDiagnostics();
          const severity = ['erreur', 'avertissement', 'info', 'suggestion'];
          const lines: string[] = [];
          for (const [file, diags] of all) {
            for (const d of diags) {
              if (d.severity <= vscode.DiagnosticSeverity.Warning) {
                lines.push(`${display(file)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${severity[d.severity]} : ${d.message}`);
              }
            }
          }
          return {
            result: lines.slice(0, 300).join('\n') || 'Aucune erreur ni avertissement.',
            summary: `${lines.length} problème(s)`,
          };
        },
      };
    },
  };
}

// ---- Outils d'écriture (validés par l'hôte) ----

function editFileTool(): AgentTool {
  return {
    sensitive: true,
    definition: {
      name: 'edit_file',
      description:
        "Remplace dans un fichier existant un extrait exact (oldText, qui doit apparaître une seule fois) par newText. Lis le fichier avant. L'hôte valide chaque modification.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Chemin du fichier.' },
          oldText: { type: 'string', description: 'Extrait exact du contenu actuel, avec suffisamment de contexte pour être unique.' },
          newText: { type: 'string', description: 'Texte de remplacement.' },
        },
        required: ['path', 'oldText', 'newText'],
      },
    },
    async prepare(input) {
      const uri = resolvePath(input.path);
      const oldText = str(input.oldText);
      const newText = str(input.newText);
      if (!oldText || newText === undefined) {
        throw new Error('Paramètres « oldText » et « newText » requis.');
      }
      const original = await readText(uri);
      const eol = original.includes('\r\n') ? '\r\n' : '\n';
      const find = oldText.replace(/\r?\n/g, eol);
      const first = original.indexOf(find);
      if (first < 0) {
        throw new Error(`Extrait introuvable dans ${display(uri)} : relis le fichier et recopie le texte exact.`);
      }
      if (original.indexOf(find, first + 1) >= 0) {
        throw new Error(`Extrait présent plusieurs fois dans ${display(uri)} : ajoute du contexte pour le rendre unique.`);
      }
      const replacement = newText.replace(/\r?\n/g, eol);
      const modified = original.slice(0, first) + replacement + original.slice(first + find.length);
      return {
        title: `Modification de ${display(uri)}`,
        approval: {
          detail: `Fichier : ${display(uri)}\n${countLines(find)} ligne(s) remplacée(s) par ${countLines(replacement)}.`,
          diff: { uri, original, modified },
        },
        async execute() {
          const doc = await vscode.workspace.openTextDocument(uri);
          if (doc.getText() !== original) {
            throw new Error(`${display(uri)} a changé entre-temps : relis-le avant de réessayer.`);
          }
          const edit = new vscode.WorkspaceEdit();
          edit.replace(uri, new vscode.Range(doc.positionAt(first), doc.positionAt(first + find.length)), replacement);
          if (!(await vscode.workspace.applyEdit(edit))) {
            throw new Error("VS Code a refusé la modification.");
          }
          await doc.save();
          return { result: `Modification appliquée à ${display(uri)}.`, summary: 'appliquée' };
        },
      };
    },
  };
}

function createFileTool(): AgentTool {
  return {
    sensitive: true,
    definition: {
      name: 'create_file',
      description: "Crée un nouveau fichier (le fichier ne doit pas exister ; utilise edit_file sinon). L'hôte valide chaque création.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Chemin du nouveau fichier.' },
          content: { type: 'string', description: 'Contenu complet du fichier.' },
        },
        required: ['path', 'content'],
      },
    },
    async prepare(input) {
      const uri = resolvePath(input.path);
      const content = str(input.content);
      if (content === undefined) {
        throw new Error('Paramètre « content » requis.');
      }
      if (await exists(uri)) {
        throw new Error(`${display(uri)} existe déjà : utilise edit_file pour le modifier.`);
      }
      return {
        title: `Création de ${display(uri)}`,
        approval: {
          detail: `Nouveau fichier : ${display(uri)} (${countLines(content)} ligne(s)).`,
          diff: { uri, original: '', modified: content },
        },
        async execute() {
          await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
          return { result: `Fichier créé : ${display(uri)}.`, summary: 'créé' };
        },
      };
    },
  };
}

function runCommandTool(output: vscode.OutputChannel): AgentTool {
  return {
    sensitive: true,
    definition: {
      name: 'run_command',
      description: `Exécute une commande shell dans un dossier de l'espace de travail et renvoie sa sortie (délai max ${COMMAND_TIMEOUT_MS / 1000} s, pas d'interaction). L'hôte valide chaque commande.`,
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Commande à exécuter.' },
          cwd: { type: 'string', description: 'Dossier de travail relatif (défaut : racine).' },
        },
        required: ['command'],
      },
    },
    async prepare(input) {
      const command = str(input.command)?.trim();
      if (!command) {
        throw new Error('Paramètre « command » manquant.');
      }
      const cwd = resolvePath(input.cwd);
      const short = command.length > 60 ? `${command.slice(0, 59)}…` : command;
      return {
        title: `Commande : ${short}`,
        approval: { detail: `Dossier : ${display(cwd) || '.'}\n\n${command}` },
        execute: (signal) => runShell(command, cwd.fsPath, signal, output),
      };
    },
  };
}

function runShell(
  command: string,
  cwd: string,
  signal: AbortSignal,
  output: vscode.OutputChannel,
): Promise<{ result: string; summary: string }> {
  return new Promise((resolve) => {
    output.appendLine(`\n$ ${command}   (dans ${cwd})`);
    const child = spawn(command, { cwd, shell: true, env: process.env });
    let out = '';
    const collect = (d: Buffer) => {
      const text = d.toString();
      output.append(text);
      out += text;
      if (out.length > MAX_COMMAND_OUTPUT * 2) {
        out = out.slice(-MAX_COMMAND_OUTPUT);
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const kill = () => child.kill();
    const timer = setTimeout(kill, COMMAND_TIMEOUT_MS);
    signal.addEventListener('abort', kill, { once: true });
    const finish = (code: number | null, error?: string) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      const tail = out.length > MAX_COMMAND_OUTPUT ? `…(début tronqué)\n${out.slice(-MAX_COMMAND_OUTPUT)}` : out;
      const status = error ?? (code === null ? 'interrompue' : `code de sortie ${code}`);
      output.appendLine(`[${status}]`);
      resolve({ result: `${status}\n${tail || '(aucune sortie)'}`, summary: status });
    };
    child.on('error', (err) => finish(null, `échec : ${err.message}`));
    child.on('close', (code) => finish(code));
  });
}

function countLines(text: string): number {
  return text ? text.split(/\r?\n/).length : 0;
}

// ---- Recherche de texte ----

let ripgrepPath: string | null | undefined;

/** ripgrep est livré avec VS Code, mais son emplacement varie selon les versions. */
function findRipgrep(): string | undefined {
  if (ripgrepPath !== undefined) {
    return ripgrepPath ?? undefined;
  }
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const arch = `${process.platform}-${process.arch}`;
  const candidates: string[] = [];
  for (const modules of ['node_modules.asar.unpacked', 'node_modules']) {
    for (const pkg of ['@vscode/ripgrep', '@vscode/ripgrep-universal']) {
      candidates.push(path.join(vscode.env.appRoot, modules, pkg, 'bin', exe));
      candidates.push(path.join(vscode.env.appRoot, modules, pkg, 'bin', arch, exe));
    }
  }
  ripgrepPath = candidates.find((c) => fs.existsSync(c)) ?? null;
  return ripgrepPath ?? undefined;
}

function searchWithRipgrep(
  rg: string,
  folders: readonly vscode.WorkspaceFolder[],
  query: string,
  isRegex: boolean,
  include: string | undefined,
  max: number,
  signal: AbortSignal,
): Promise<string[]> {
  const multi = folders.length > 1;
  return folders.reduce<Promise<string[]>>(async (accPromise, folder) => {
    const acc = await accPromise;
    if (acc.length >= max || signal.aborted) {
      return acc;
    }
    const args = ['--line-number', '--no-heading', '--color', 'never', '--max-columns', '300', '--max-count', '20', '--hidden', '-g', '!.git'];
    if (!isRegex) {
      args.push('--fixed-strings');
    }
    if (include) {
      args.push('-g', include);
    }
    args.push('-e', query, '--', '.');
    const lines = await new Promise<string[]>((resolve) => {
      const child = spawn(rg, args, { cwd: folder.uri.fsPath });
      let buf = '';
      const found: string[] = [];
      const kill = () => child.kill();
      signal.addEventListener('abort', kill, { once: true });
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        for (const line of parts) {
          if (found.length + acc.length < max) {
            const clean = line.replace(/^\.[\\/]/, '');
            found.push(multi ? `${folder.name}/${clean}` : clean);
          } else {
            child.kill();
          }
        }
      });
      child.on('error', () => resolve(found));
      child.on('close', () => {
        signal.removeEventListener('abort', kill);
        resolve(found);
      });
    });
    return acc.concat(lines);
  }, Promise.resolve([]));
}

/** Repli sans ripgrep : parcours des fichiers texte de taille raisonnable. */
async function searchWithScan(query: string, isRegex: boolean, include: string | undefined, max: number): Promise<string[]> {
  const matcher = isRegex ? new RegExp(query) : undefined;
  const uris = await vscode.workspace.findFiles(include ?? '**/*', EXCLUDE_GLOB, 3000);
  const hits: string[] = [];
  for (const uri of uris) {
    let text: string;
    try {
      text = await readText(uri);
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && hits.length < max; i++) {
      if (matcher ? matcher.test(lines[i]) : lines[i].includes(query)) {
        hits.push(`${display(uri)}:${i + 1}:${lines[i].slice(0, 300)}`);
      }
    }
    if (hits.length >= max) {
      break;
    }
  }
  return hits;
}
