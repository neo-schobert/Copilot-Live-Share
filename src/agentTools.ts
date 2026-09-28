import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentQuestion, ApprovalKind, ApprovalRequest } from './protocol';
import { detectSandbox, resetSandbox, sandboxCommand, sandboxRuntime } from './sandbox';

/**
 * Outils donnés au modèle pour travailler dans l'espace de travail de l'hôte.
 *
 * L'agent est confiné au dossier ouvert : chemins réels vérifiés (pas de sortie
 * par lien symbolique), fichiers sensibles invisibles, commandes exécutées dans
 * un bac à sable bubblewrap (projet en écriture, pas de dossier personnel, pas
 * de réseau). Une commande qui doit sortir de ce cadre ne peut être validée que
 * par l'hôte.
 */

export type AgentMode = 'full' | 'readOnly' | 'off';

/** Demande de validation préparée par un outil, avec le diff complet pour l'hôte. */
export interface PreparedApproval extends ApprovalRequest {
  diff?: { uri: vscode.Uri; original: string; modified: string };
}

export interface PreparedCall {
  title: string;
  approval?: PreparedApproval;
  /** Outil interactif : l'agent pose une question au lieu d'agir. */
  question?: Pick<AgentQuestion, 'text' | 'options'>;
  /** Exécute l'action ; renvoie le résultat pour le modèle et un résumé pour le chat. */
  execute(signal: AbortSignal): Promise<{ result: string; summary?: string }>;
}

interface AgentTool {
  definition: vscode.LanguageModelChatTool;
  /** true : écriture ou exécution, exclue en lecture seule. */
  sensitive: boolean;
  prepare(input: Record<string, unknown>): Promise<PreparedCall>;
}

const MAX_READ_CHARS = 60_000;
const MAX_READ_LINES = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_OUTPUT = 20_000;
const MAX_PREVIEW_LINES = 40;
const COMMAND_TIMEOUT_MS = 120_000;
const SEARCH_EXCLUDE_GLOB = '**/{node_modules,.git,dist,out,build,.venv,__pycache__}/**';

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
  /** Catégories autorisées par l'hôte pour toute la session (« Autoriser pour la session »). */
  private readonly grants = new Set<ApprovalKind>();
  /** Diffs des actions en attente, par id d'action, pour « Voir les modifications ». */
  private readonly diffs = new Map<string, NonNullable<PreparedApproval['diff']>>();

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
      askUserTool(),
      editFileTool(),
      createFileTool(),
      runCommandTool(output),
    ];
  }

  /** Mode effectif : un espace de travail non approuvé ou sans dossier limite les outils. */
  effectiveMode(): AgentMode {
    const configured = config().get<AgentMode>('agentMode', 'full');
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
      `Tu travailles dans l'espace de travail VS Code de l'hôte (dossiers : ${folders}) via des outils, comme l'agent GitHub Copilot.`,
      "Tu es confiné à ce projet : aucun fichier extérieur n'est accessible, et certains fichiers sensibles (.env, clés, .git…) sont protégés.",
      'Les chemins sont relatifs à la racine du dossier ; en multi-dossier, préfixe-les par le nom du dossier.',
      'Avant de répondre sur le code, explore-le : liste, cherche et lis les fichiers utiles plutôt que de supposer leur contenu.',
      "Si la demande est ambiguë ou qu'un choix important revient aux utilisateurs, pose la question avec ask_user plutôt que de deviner : tous les participants la voient et le premier qui répond l'emporte.",
    ];
    if (mode === 'full') {
      lines.push(
        "Tu peux modifier ou créer des fichiers et lancer des commandes : chaque action est validée par l'auteur de la demande ou par l'hôte, qui peuvent refuser.",
        "Pour modifier un fichier, lis-le d'abord puis utilise edit_file avec un extrait exact et unique du contenu actuel.",
        sandboxRuntime()
          ? `Les commandes s'exécutent dans un bac à sable ${sandboxRuntime()!.description} avec /bin/sh (syntaxe Linux) : projet seul, sans réseau ni dossier personnel. ` +
            `Si une commande a besoin du réseau ou de fichiers hors du projet (installation de dépendances, etc.), relance-la avec outsideProject: true : elle s'exécute alors sur la machine de l'hôte (${hostShellDescription()}) et seul l'hôte peut la valider.`
          : `Les commandes s'exécutent sans bac à sable sur la machine de l'hôte (${hostShellDescription()}, utilise cette syntaxe) : seul l'hôte peut les valider.`,
        "N'effectue une modification ou une commande que si la demande le justifie clairement.",
      );
    } else {
      lines.push('Tu es en lecture seule : propose les modifications dans ta réponse, sans les appliquer.');
    }
    return lines.join('\n');
  }

  async prepare(name: string, input: unknown): Promise<PreparedCall> {
    const tool = this.tools.find((t) => t.definition.name === name);
    const mode = this.effectiveMode();
    if (!tool || mode === 'off' || (tool.sensitive && mode !== 'full')) {
      throw new Error(`Outil « ${name} » indisponible.`);
    }
    const args = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    return tool.prepare(args);
  }

  /** Détecte le bac à sable (bubblewrap natif, ou via WSL sous Windows). */
  initSandbox(log: (message: string) => void, force = false): Promise<unknown> {
    if (force) {
      resetSandbox();
    }
    return detectSandbox({
      extraReadOnly: config().get<string[]>('sandboxReadOnlyPaths', []),
      useWsl: config().get<boolean>('wslSandbox', true),
      wslDistro: config().get<string>('wslDistro', '').trim(),
      log,
    });
  }

  /** Description du bac à sable des commandes, ou undefined s'il n'y en a pas. */
  sandboxDescription(): string | undefined {
    return sandboxRuntime()?.description;
  }

  /** true si l'hôte a déjà autorisé cette catégorie d'action pour la session (jamais pour une action hors du projet). */
  isGranted(approval: PreparedApproval): boolean {
    return !approval.hostOnly && this.grants.has(approval.kind);
  }

  grant(kind: ApprovalKind): void {
    this.grants.add(kind);
  }

  /** Réinitialise l'état propre à une session (autorisations, diffs). */
  resetSession(): void {
    this.grants.clear();
    this.diffs.clear();
    this.proposals.clear();
  }

  rememberDiff(toolId: string, diff: NonNullable<PreparedApproval['diff']>): void {
    this.diffs.set(toolId, diff);
  }

  forgetDiff(toolId: string): void {
    this.diffs.delete(toolId);
  }

  /** Ouvre dans VS Code le diff complet d'une modification proposée. Renvoie false si elle n'existe plus. */
  async showDiff(toolId: string): Promise<boolean> {
    const diff = this.diffs.get(toolId);
    if (!diff) {
      return false;
    }
    const name = path.basename(diff.uri.path);
    const left = this.proposals.register(diff.original, name);
    const right = this.proposals.register(diff.modified, name);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${name} : modification proposée (Shared Copilot)`, {
      preview: true,
    });
    return true;
  }
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('sharedCopilotChat');
}

// ---- Confinement : chemins et fichiers protégés ----

function workspaceFolders(): readonly vscode.WorkspaceFolder[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    throw new Error("Aucun dossier n'est ouvert dans VS Code chez l'hôte.");
  }
  return folders;
}

interface Resolved {
  uri: vscode.Uri;
  folder: vscode.WorkspaceFolder;
  /** Chemin relatif au dossier, séparateurs « / ». */
  rel: string;
}

/** Résolution purement textuelle d'un chemin donné par le modèle, sans sortie du dossier. */
function resolveLexical(raw: unknown): Resolved {
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
  return { uri: vscode.Uri.file(full), folder, rel: toPosix(path.relative(folder.uri.fsPath, full)) };
}

/**
 * Résout un chemin et vérifie qu'il reste dans l'espace de travail une fois les
 * liens symboliques suivis, et qu'il n'est pas protégé.
 */
async function resolveSafe(raw: unknown): Promise<Resolved> {
  const resolved = resolveLexical(raw);
  if (isProtected(resolved.rel)) {
    throw new Error(`Fichier protégé, non accessible à l'agent : ${resolved.rel}`);
  }
  const root = await fs.promises.realpath(resolved.folder.uri.fsPath);
  // Pour un fichier à créer, on vérifie le plus proche parent existant.
  let probe = resolved.uri.fsPath;
  let real: string | undefined;
  while (real === undefined) {
    try {
      real = await fs.promises.realpath(probe);
    } catch (err) {
      const parent = path.dirname(probe);
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || parent === probe) {
        throw err;
      }
      // Lien symbolique cassé : écrire à travers lui créerait un fichier ailleurs.
      if (await fs.promises.lstat(probe).then((st) => st.isSymbolicLink(), () => false)) {
        throw new Error(`Lien symbolique non suivi : ${resolved.rel}`);
      }
      probe = parent;
    }
  }
  if (!isInside(root, real)) {
    throw new Error(`Chemin hors de l'espace de travail (lien symbolique) : ${resolved.rel}`);
  }
  // Un lien interne peut pointer vers un fichier protégé (ex. config -> .env).
  if (isProtected(toPosix(path.relative(root, real)))) {
    throw new Error(`Fichier protégé, non accessible à l'agent : ${resolved.rel}`);
  }
  return resolved;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

const DEFAULT_PROTECTED = [
  '**/.git',
  '**/.git/**',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/.npmrc',
  '**/.pypirc',
  '**/.netrc',
  '**/.aws/**',
  '**/.ssh/**',
];

let protectedCache: { source: string; patterns: RegExp[] } | undefined;

/** Fichiers invisibles pour l'agent : liste par défaut + paramètre `protectedFiles`. */
function isProtected(rel: string): boolean {
  if (!rel || rel === '.') {
    return false;
  }
  const extra = config().get<string[]>('protectedFiles', []);
  const source = JSON.stringify(extra);
  if (protectedCache?.source !== source) {
    protectedCache = { source, patterns: [...DEFAULT_PROTECTED, ...extra].map(globToRegExp) };
  }
  return protectedCache.patterns.some((re) => re.test(rel));
}

/** Convertit un glob (**, *, ?, {a,b}) en expression régulière sur un chemin relatif « / ». */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) {
        re += '\\{';
      } else {
        re += `(?:${glob.slice(i + 1, end).split(',').map(escapeRegExp).join('|')})`;
        i = end;
      }
    } else {
      re += escapeRegExp(c);
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function display(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
}

/** Chemin relatif au dossier d'appartenance, ou undefined si l'URI est hors de l'espace de travail. */
function workspaceRel(uri: vscode.Uri): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return folder && uri.scheme === 'file' ? toPosix(path.relative(folder.uri.fsPath, uri.fsPath)) : undefined;
}

/** Fichier du projet accessible à l'agent : dans un dossier ouvert, non protégé, et sans sortie par lien symbolique. */
function visible(uri: vscode.Uri): boolean {
  const rel = workspaceRel(uri);
  if (rel === undefined || isProtected(rel)) {
    return false;
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri)!;
  try {
    const root = fs.realpathSync(folder.uri.fsPath);
    const real = fs.realpathSync(uri.fsPath);
    return isInside(root, real) && !isProtected(toPosix(path.relative(root, real)));
  } catch {
    return false;
  }
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

function preview(prefix: string, text: string): string[] {
  const lines = text.split(/\r?\n/);
  const shown = lines.slice(0, MAX_PREVIEW_LINES).map((l) => `${prefix}${l}`);
  if (lines.length > MAX_PREVIEW_LINES) {
    shown.push(`  … ${lines.length - MAX_PREVIEW_LINES} ligne(s) de plus`);
  }
  return shown;
}

function countLines(text: string): number {
  return text ? text.split(/\r?\n/).length : 0;
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
      const { uri, rel } = await resolveSafe(input.path);
      return {
        title: `Liste de ${rel || '.'}`,
        async execute() {
          const entries = (await vscode.workspace.fs.readDirectory(uri)).filter(
            ([name]) => !isProtected(rel && rel !== '.' ? `${rel}/${name}` : name),
          );
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
          pattern: { type: 'string', description: "Motif glob relatif aux dossiers de l'espace de travail." },
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
          const uris = (await vscode.workspace.findFiles(pattern, SEARCH_EXCLUDE_GLOB, max * 2)).filter(visible).slice(0, max);
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
      const { uri, rel } = await resolveSafe(input.path);
      const start = Math.max(1, int(input.startLine) ?? 1);
      const requestedEnd = int(input.endLine);
      return {
        title: `Lecture de ${rel}${requestedEnd || start > 1 ? `, lignes ${start} à ${requestedEnd ?? 'la fin'}` : ''}`,
        async execute() {
          const lines = (await readText(uri)).split(/\r?\n/);
          const end = Math.min(lines.length, requestedEnd ?? lines.length, start + MAX_READ_LINES - 1);
          let body = lines.slice(start - 1, end).join('\n');
          let truncated = end < (requestedEnd ?? lines.length);
          if (body.length > MAX_READ_CHARS) {
            body = body.slice(0, MAX_READ_CHARS);
            truncated = true;
          }
          const header = `${rel} — lignes ${start}-${end} sur ${lines.length}${truncated ? ' (tronqué : relis la suite avec startLine)' : ''}`;
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
        properties: { path: { type: 'string', description: "Fichier à examiner ; absent : tout l'espace de travail." } },
      },
    },
    async prepare(input) {
      const target = input.path ? await resolveSafe(input.path) : undefined;
      return {
        title: target ? `Problèmes dans ${target.rel}` : 'Problèmes du projet',
        async execute() {
          const all: [vscode.Uri, readonly vscode.Diagnostic[]][] = target
            ? [[target.uri, vscode.languages.getDiagnostics(target.uri)]]
            : vscode.languages.getDiagnostics();
          const severity = ['erreur', 'avertissement', 'info', 'suggestion'];
          const lines: string[] = [];
          for (const [file, diags] of all) {
            // Seulement les fichiers du projet : VS Code connaît aussi des fichiers ouverts ailleurs.
            if (!visible(file)) {
              continue;
            }
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

function askUserTool(): AgentTool {
  return {
    sensitive: false,
    definition: {
      name: 'ask_user',
      description:
        "Pose une question aux participants du chat et attend la première réponse (choix entre options ou réponse libre). Tous voient la question et n'importe qui peut répondre. À utiliser quand la demande est ambiguë ou qu'une décision revient aux utilisateurs.",
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'La question, courte et précise.' },
          options: { type: 'array', items: { type: 'string' }, description: 'Réponses proposées (2 à 6), facultatif.' },
        },
        required: ['question'],
      },
    },
    async prepare(input) {
      const text = str(input.question)?.trim();
      if (!text) {
        throw new Error('Paramètre « question » manquant.');
      }
      const options = Array.isArray(input.options)
        ? input.options.filter((o): o is string => typeof o === 'string' && !!o.trim()).map((o) => o.trim().slice(0, 120)).slice(0, 6)
        : [];
      return {
        title: 'Question',
        question: { text: text.slice(0, 1000), options },
        async execute() {
          return { result: '' };
        },
      };
    },
  };
}

// ---- Outils d'écriture (validés) ----

function editFileTool(): AgentTool {
  return {
    sensitive: true,
    definition: {
      name: 'edit_file',
      description:
        "Remplace dans un fichier existant un extrait exact (oldText, qui doit apparaître une seule fois) par newText. Lis le fichier avant. Chaque modification est validée.",
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
      const { uri, rel } = await resolveSafe(input.path);
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
        throw new Error(`Extrait introuvable dans ${rel} : relis le fichier et recopie le texte exact.`);
      }
      if (original.indexOf(find, first + 1) >= 0) {
        throw new Error(`Extrait présent plusieurs fois dans ${rel} : ajoute du contexte pour le rendre unique.`);
      }
      const replacement = newText.replace(/\r?\n/g, eol);
      const modified = original.slice(0, first) + replacement + original.slice(first + find.length);
      const line = original.slice(0, first).split(/\r?\n/).length;
      return {
        title: `Modifier ${rel}`,
        approval: {
          kind: 'write',
          hostOnly: false,
          canShowDiff: true,
          preview: [`@@ ${rel}, ligne ${line}`, ...preview('- ', oldText), ...preview('+ ', newText)].join('\n'),
          diff: { uri, original, modified },
        },
        async execute() {
          const doc = await vscode.workspace.openTextDocument(uri);
          if (doc.getText() !== original) {
            throw new Error(`${rel} a changé entre-temps : relis-le avant de réessayer.`);
          }
          const edit = new vscode.WorkspaceEdit();
          edit.replace(uri, new vscode.Range(doc.positionAt(first), doc.positionAt(first + find.length)), replacement);
          if (!(await vscode.workspace.applyEdit(edit))) {
            throw new Error('VS Code a refusé la modification.');
          }
          await doc.save();
          return {
            result: `Modification appliquée à ${rel}.`,
            summary: `+${countLines(replacement)} −${countLines(find)}`,
          };
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
      description: "Crée un nouveau fichier (le fichier ne doit pas exister ; utilise edit_file sinon). Chaque création est validée.",
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
      const { uri, rel } = await resolveSafe(input.path);
      const content = str(input.content);
      if (content === undefined) {
        throw new Error('Paramètre « content » requis.');
      }
      if (await exists(uri)) {
        throw new Error(`${rel} existe déjà : utilise edit_file pour le modifier.`);
      }
      return {
        title: `Créer ${rel}`,
        approval: {
          kind: 'write',
          hostOnly: false,
          canShowDiff: true,
          preview: [`@@ nouveau fichier ${rel}`, ...preview('+ ', content)].join('\n'),
          diff: { uri, original: '', modified: content },
        },
        async execute() {
          await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
          return { result: `Fichier créé : ${rel}.`, summary: `+${countLines(content)}` };
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
      description:
        `Exécute une commande shell dans un dossier du projet et renvoie sa sortie (délai max ${COMMAND_TIMEOUT_MS / 1000} s, pas d'interaction). ` +
        'Par défaut, la commande tourne dans un bac à sable : seul le projet est visible et modifiable, sans réseau. ' +
        "Mets outsideProject à true si elle a besoin du réseau ou d'éléments hors du projet : seul l'hôte peut alors la valider.",
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Commande à exécuter.' },
          cwd: { type: 'string', description: 'Dossier de travail relatif (défaut : racine).' },
          outsideProject: {
            type: 'boolean',
            description: "true si la commande doit accéder au réseau ou à des fichiers hors du projet (validation par l'hôte uniquement).",
          },
        },
        required: ['command'],
      },
    },
    async prepare(input) {
      const command = str(input.command)?.trim();
      if (!command) {
        throw new Error('Paramètre « command » manquant.');
      }
      const { uri: cwd, rel } = await resolveSafe(input.cwd);
      const rt = sandboxRuntime();
      const sandboxed = input.outsideProject !== true && !!rt && rt.toSandbox(cwd.fsPath) !== undefined;
      const where = sandboxed
        ? `bac à sable ${rt!.description} : projet seul, sans réseau`
        : rt
          ? `HORS bac à sable (${hostShellDescription()}) : accès au réseau et à toute la machine`
          : `sans bac à sable (${hostShellDescription()}) : accès à toute la machine`;
      return {
        title: sandboxed ? 'Exécuter dans le terminal' : 'Exécuter hors du projet',
        approval: {
          kind: 'command',
          hostOnly: !sandboxed,
          canShowDiff: false,
          preview: `$ ${command}\n# dossier : ${rel || '.'} — ${where}`,
        },
        execute: (signal) => runShell(command, cwd.fsPath, sandboxed, signal, output),
      };
    },
  };
}

// ---- Exécution des commandes ----

/** Arrête un processus et ses descendants (taskkill sous Windows, groupe de processus ailleurs). */
function killTree(pid: number | undefined, fallback: () => void): void {
  if (pid === undefined) {
    fallback();
    return;
  }
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', fallback);
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  } catch {
    fallback();
  }
}

/** true si les commandes peuvent être confinées au projet. */
export function sandboxAvailable(): boolean {
  return sandboxRuntime() !== undefined;
}

/** Shell des commandes hors bac à sable, décrit au modèle pour qu'il en respecte la syntaxe. */
function hostShellDescription(): string {
  if (process.platform === 'win32') {
    return 'Windows, PowerShell';
  }
  return `${process.platform === 'darwin' ? 'macOS' : 'Linux'}, /bin/sh`;
}

/**
 * Fichiers et dossiers protégés présents dans un dossier du projet (parcours borné,
 * sans suivre les liens ni descendre dans node_modules). Dans .git, seul config
 * est masqué pour que git reste utilisable.
 */
function protectedEntries(root: string): { path: string; dir: boolean }[] {
  const found: { path: string; dir: boolean }[] = [];
  let budget = 20_000;
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (--budget < 0) {
        return;
      }
      const full = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, full));
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory() && entry.name === '.git') {
        const config = path.join(full, 'config');
        if (fs.existsSync(config)) {
          found.push({ path: config, dir: false });
        }
        continue;
      }
      if (isProtected(rel)) {
        found.push({ path: full, dir: entry.isDirectory() });
        continue;
      }
      if (entry.isDirectory() && entry.name !== 'node_modules' && depth < 8) {
        walk(full, depth + 1);
      }
    }
  };
  walk(root, 0);
  return found;
}

function runShell(
  command: string,
  cwd: string,
  sandboxed: boolean,
  signal: AbortSignal,
  output: vscode.OutputChannel,
): Promise<{ result: string; summary: string }> {
  return new Promise((resolve) => {
    output.appendLine(`\n$ ${command}   (dans ${cwd}${sandboxed ? ', bac à sable' : ', HORS bac à sable'})`);
    const rt = sandboxRuntime();
    let sandboxArgs: string[] | undefined;
    if (sandboxed) {
      try {
        const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
        sandboxArgs = sandboxCommand(rt!, { folders, hidden: folders.flatMap(protectedEntries), cwd }, command);
      } catch (err) {
        resolve({ result: `échec : ${(err as Error).message}`, summary: 'échec' });
        return;
      }
    }
    const child = sandboxArgs
      ? spawn(rt!.launcher, sandboxArgs, { cwd, env: rt!.env, windowsHide: true })
      : process.platform === 'win32'
        ? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
            cwd,
            env: process.env,
            windowsHide: true,
          })
        : // Groupe de processus dédié, pour pouvoir arrêter la commande et tous ses sous-processus.
          spawn(command, { cwd, shell: true, env: process.env, detached: true });
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
    const kill = () => killTree(child.pid, () => child.kill());
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
    // Pas de --follow : ripgrep ne suit pas les liens symboliques, donc ne sort pas du dossier.
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
          const clean = line.replace(/^\.[\\/]/, '');
          const file = clean.slice(0, clean.indexOf(':'));
          if (isProtected(toPosix(file))) {
            continue;
          }
          if (found.length + acc.length < max) {
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
  const uris = (await vscode.workspace.findFiles(include ?? '**/*', SEARCH_EXCLUDE_GLOB, 3000)).filter(visible);
  const hits: string[] = [];
  for (const uri of uris) {
    let text: string;
    try {
      await resolveSafe(uri.fsPath);
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
