import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as vscode from 'vscode';
import { PROPOSAL_SCHEME, ProposalContentProvider, WorkspaceTools } from './agentTools';
import type { ApprovalDecision } from './protocol';
import { ChatRoom, LOCAL_HOST_CLIENT_ID, PendingApproval, PendingQuestion } from './chatRoom';
import { CopilotBackend, defaultModelId, listCopilotModels } from './copilotBackend';
import { NativeChatBridge } from './nativeChat';
import { consumePendingStart, prepareEnvironment } from './wslSetup';
import { ChatServer } from './server';

const CONFIG = 'sharedCopilotChat';
/** Au-delà, le partage de contexte demande confirmation (le modèle a une fenêtre limitée). */
const LARGE_CONTEXT_CHARS = 60_000;

class Session {
  private panel: vscode.WebviewPanel | undefined;
  /** URL publique du tunnel saisie par l'hôte, gardée en mémoire seulement. */
  publicUrl: string | undefined;
  /** Intégration au panneau Chat natif, si l'API proposée est disponible. */
  nativeChat: NativeChatBridge | undefined;

  constructor(
    readonly server: ChatServer,
    readonly room: ChatRoom,
    readonly guestToken: string,
    readonly hostToken: string,
  ) {}

  get localUrl(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  async openChat(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    // asExternalUri gère le cas où l'extension tourne à distance (SSH, Codespaces).
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(`${this.localUrl}/`));
    const src = new URL(external.toString(true));
    src.searchParams.set('token', this.hostToken);
    src.searchParams.set('name', hostName());

    const panel = vscode.window.createWebviewPanel('sharedCopilotChat', 'Shared Copilot Chat', vscode.ViewColumn.Beside, {
      enableScripts: true,
      // Garde la connexion WebSocket ouverte quand l'onglet est masqué.
      retainContextWhenHidden: true,
    });
    panel.webview.html = webviewHtml(src);
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
      }
    });
    this.panel = panel;
  }

  async stop(): Promise<void> {
    this.nativeChat?.dispose();
    this.nativeChat = undefined;
    this.panel?.dispose();
    this.panel = undefined;
    this.room.dispose("L'hôte a arrêté la session.");
    await this.server.stop('Session ended');
  }
}

let session: Session | undefined;
let starting = false;
let statusBar: vscode.StatusBarItem | undefined;
/** Dernier éditeur texte actif : activeTextEditor est vide quand la webview a le focus. */
let lastTextEditor: vscode.TextEditor | undefined;
let output: vscode.OutputChannel;
let proposals: ProposalContentProvider;
let tools: WorkspaceTools;
/** Détection du bac à sable des commandes (bubblewrap, ou WSL sous Windows). */
let sandboxReady: Promise<unknown> = Promise.resolve();
const log = (message: string) => output?.appendLine(message);

/** API interne renvoyée par activate(), utilisée par les tests d'intégration. */
export interface SharedCopilotApi {
  readonly tools: WorkspaceTools;
  readonly nativeChatActive: () => boolean;
  /** Résolue quand la détection du bac à sable est terminée. */
  readonly sandboxReady: Promise<unknown>;
}

export function activate(context: vscode.ExtensionContext): SharedCopilotApi {
  output = vscode.window.createOutputChannel('Shared Copilot');
  proposals = new ProposalContentProvider();
  tools = new WorkspaceTools(proposals, output);
  sandboxReady = tools.initSandbox(log);
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'sharedCopilotChat.copyInviteLink';
  lastTextEditor = vscode.window.activeTextEditor;

  log(`Extension activée : ${describeEnvironment(context)}`);

  context.subscriptions.push(
    output,
    vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, proposals),
    statusBar,
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e) {
        lastTextEditor = e;
      }
    }),
    vscode.commands.registerCommand('sharedCopilotChat.startSession', () => startSession(context)),
    vscode.commands.registerCommand('sharedCopilotChat.copyInviteLink', withSession(copyInviteLink)),
    vscode.commands.registerCommand('sharedCopilotChat.openChat', withSession((s) => s.openChat())),
    vscode.commands.registerCommand('sharedCopilotChat.shareSelection', withSession(shareSelection)),
    vscode.commands.registerCommand('sharedCopilotChat.cancelResponse', withSession(cancelResponse)),
    vscode.commands.registerCommand('sharedCopilotChat.stopSession', withSession(stopSession)),
    vscode.commands.registerCommand('sharedCopilotChat.selectModel', selectDefaultModel),
    // Commandes internes, utilisées par les boutons du chat natif.
    vscode.commands.registerCommand('sharedCopilotChat.resolveApproval', (entryId: string, toolId: string, decision: ApprovalDecision) => {
      if (!session?.room.resolveApproval(entryId, toolId, decision, hostName())) {
        void vscode.window.showInformationMessage("Shared Copilot : cette action n'attend plus de validation.");
      }
    }),
    vscode.commands.registerCommand('sharedCopilotChat.showDiff', async (toolId: string) => {
      if (!(await tools.showDiff(toolId))) {
        void vscode.window.showInformationMessage("Shared Copilot : cette modification n'est plus en attente.");
      }
    }),
    vscode.commands.registerCommand('sharedCopilotChat.answerQuestion', async (entryId: string, toolId: string, text?: string) => {
      const answer = text ?? (await vscode.window.showInputBox({ title: "Réponse à l'agent", ignoreFocusOut: true }));
      if (answer && !session?.room.answerQuestion(entryId, toolId, answer, hostName())) {
        void vscode.window.showInformationMessage("Shared Copilot : cette question n'attend plus de réponse.");
      }
    }),
    vscode.lm.onDidChangeChatModels(() => void refreshModels()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG}.modelFamily`) || e.affectsConfiguration(`${CONFIG}.allowGuestModelChoice`)) {
        void refreshModels();
      }
      if (['wslSandbox', 'wslDistro', 'sandboxReadOnlyPaths'].some((k) => e.affectsConfiguration(`${CONFIG}.${k}`))) {
        sandboxReady = tools.initSandbox(log, true);
      }
    }),
  );
  // Fenêtre rouverte dans WSL à la demande de « Start Session » : la session reprend d'elle-même.
  if (consumePendingStart(context)) {
    setTimeout(() => {
      void vscode.commands.executeCommand('sharedCopilotChat.startSession').then(() =>
        session ? vscode.commands.executeCommand('sharedCopilotChat.openChat') : undefined,
      );
    }, 1000);
  }

  return {
    tools,
    nativeChatActive: () => !!session?.nativeChat,
    get sandboxReady() {
      return sandboxReady;
    },
  };
}

export async function deactivate(): Promise<void> {
  await stopSession();
}

// ---- Commandes ----

async function startSession(context: vscode.ExtensionContext): Promise<void> {
  if (session) {
    void showSessionNotification(session, 'Une session est déjà en cours');
    return;
  }
  if (starting) {
    void vscode.window.showInformationMessage('Shared Copilot : démarrage de la session déjà en cours…');
    return;
  }
  starting = true;
  log(`Start Session : ${describeEnvironment(context)}`);
  try {
    // Windows + WSL : proposition de rouvrir dans WSL, installation de ce qui manque.
    const setup = await prepareEnvironment(context, log);
    log(`Préparation de l'environnement : ${setup.outcome}${setup.redetect ? ' (nouvelle détection du bac à sable)' : ''}`);
    if (setup.outcome === 'cancelled') {
      void vscode.window.showInformationMessage('Shared Copilot : démarrage de la session annulé.');
      return;
    }
    if (setup.outcome === 'reopening') {
      return;
    }
    // Bac à sable absent jusqu'ici (ex. bubblewrap installé entre-temps) : nouvelle détection.
    if (setup.redetect || !tools.sandboxDescription()) {
      sandboxReady = tools.initSandbox(log, true);
    }
    await createSession(context);
    const started = session as Session | undefined; // modifiée par createSession
    log(started ? `Session démarrée sur ${started.localUrl}` : 'Session non démarrée.');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Erreur au démarrage de la session : ${err instanceof Error && err.stack ? err.stack : message}`);
    void showError(`impossible de démarrer la session (${message}).`);
  } finally {
    starting = false;
  }
}

/** Contexte d'exécution, pour le journal : système, fenêtre locale ou distante, mode de l'extension. */
function describeEnvironment(context: vscode.ExtensionContext): string {
  const mode = { 1: 'installée', 2: 'développement (F5)', 3: 'test' }[context.extensionMode] ?? String(context.extensionMode);
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? 'aucun dossier';
  return `${process.platform}, fenêtre ${vscode.env.remoteName ? `distante (${vscode.env.remoteName})` : 'locale'}, extension ${mode}, VS Code ${vscode.version}, dossier ${folder}`;
}

/** Message d'erreur avec accès direct au journal. */
async function showError(message: string): Promise<void> {
  const logs = 'Voir le journal';
  if ((await vscode.window.showErrorMessage(`Shared Copilot : ${message}`, logs)) === logs) {
    output.show(true);
  }
}

async function createSession(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG);
  const port = config.get<number>('port', 3717);

  let indexHtml: string;
  let clientJs: Buffer;
  let styleCss: Buffer;
  let codiconCss: Buffer;
  try {
    const file = (...p: string[]) => vscode.Uri.joinPath(context.extensionUri, ...p).fsPath;
    [indexHtml, clientJs, styleCss, codiconCss] = await Promise.all([
      fs.readFile(file('media', 'index.html'), 'utf8'),
      fs.readFile(file('dist', 'web', 'client.js')),
      fs.readFile(file('media', 'style.css')),
      fs.readFile(file('dist', 'web', 'codicon.css')),
    ]);
  } catch (err) {
    void vscode.window.showErrorMessage(`Shared Copilot : fichiers de la page introuvables (${String(err)}). Lancez « npm run compile ».`);
    return;
  }

  const guestToken = crypto.randomBytes(24).toString('base64url');
  const hostToken = crypto.randomBytes(24).toString('base64url');
  const room = new ChatRoom(new CopilotBackend(tools), {
    historyLength: () => vscode.workspace.getConfiguration(CONFIG).get<number>('historyLength', 20),
    hostName: hostName(),
    onParticipantsChanged: (p) => updateStatusBar(p.length),
    extraInstructions: () => tools.instructions(),
    onApprovalRequested: (pending) => void notifyApproval(pending),
    onQuestionAsked: (pending) => void askLocalHost(pending),
    onShowDiff: (_entryId, toolId) => void tools.showDiff(toolId),
  });
  const server = new ChatServer(
    {
      port,
      guestToken,
      hostToken,
      indexHtml,
      assets: {
        '/client.js': { contentType: 'text/javascript; charset=utf-8', body: clientJs },
        '/style.css': { contentType: 'text/css; charset=utf-8', body: styleCss },
        '/codicon.css': { contentType: 'text/css; charset=utf-8', body: codiconCss },
      },
    },
    room,
  );

  try {
    await server.start();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const detail =
      code === 'EADDRINUSE'
        ? `le port ${port} est déjà utilisé. Changez le paramètre « sharedCopilotChat.port ».`
        : String(err);
    void vscode.window.showErrorMessage(`Shared Copilot : impossible de démarrer le serveur, ${detail}`);
    return;
  }

  // Les consignes du modèle et les validations dépendent du bac à sable : on attend sa détection.
  await sandboxReady;
  tools.resetSession();
  session = new Session(server, room, guestToken, hostToken);
  if (config.get<boolean>('nativeChat', true)) {
    session.nativeChat = NativeChatBridge.tryCreate(room, hostName, (m) => output.appendLine(m));
  }
  await vscode.commands.executeCommand('setContext', 'sharedCopilotChat.active', true);
  updateStatusBar(0);
  void refreshModels();
  void showSessionNotification(session, 'Session démarrée');
}

/**
 * Notifie l'hôte d'une action à valider. La notification n'est pas modale : la
 * décision peut aussi venir de la page web ou du chat natif, la première l'emporte.
 */
async function notifyApproval(pending: PendingApproval): Promise<void> {
  const room = session?.room;
  const { tool, entryId, author } = pending;
  const allow = 'Autoriser';
  const allowSession = 'Autoriser pour la session';
  const diff = 'Voir les modifications';
  const deny = 'Refuser';
  const buttons = [allow, ...(tool.approval.hostOnly ? [] : [allowSession]), ...(tool.approval.canShowDiff ? [diff] : []), deny];
  const scope = tool.approval.hostOnly ? ' (hors du projet — vous seul pouvez décider)' : '';
  for (;;) {
    const choice = await vscode.window.showWarningMessage(
      `Shared Copilot — ${author} : ${tool.title}${scope}\n${tool.approval.preview.split('\n').slice(0, 6).join('\n')}`,
      ...buttons,
    );
    if (!room || !room.pendingApproval(entryId, tool.id)) {
      return; // Déjà décidé ailleurs ou session terminée.
    }
    if (choice === diff) {
      await tools.showDiff(tool.id);
      continue;
    }
    const decision: ApprovalDecision | undefined =
      choice === allow ? 'once' : choice === allowSession ? 'session' : choice === deny ? 'deny' : undefined;
    if (decision) {
      room.resolveApproval(entryId, tool.id, decision, hostName());
    }
    return;
  }
}

/** Question de l'agent posée à l'hôte depuis le chat natif : réponse dans VS Code. */
async function askLocalHost(pending: PendingQuestion): Promise<void> {
  const { tool, entryId } = pending;
  if (tool.question.requesterClientId !== LOCAL_HOST_CLIENT_ID) {
    return; // Question née d'une demande web : les participants répondent depuis la page.
  }
  const free = '$(edit) Autre réponse…';
  let answer: string | undefined;
  if (tool.question.options.length) {
    const picked = await vscode.window.showQuickPick([...tool.question.options, free], {
      title: `Shared Copilot — question de l'agent`,
      placeHolder: tool.question.text,
      ignoreFocusOut: true,
    });
    answer = picked === free ? undefined : picked;
    if (picked === undefined) {
      return;
    }
  }
  answer ??= await vscode.window.showInputBox({ title: "Shared Copilot — question de l'agent", prompt: tool.question.text, ignoreFocusOut: true });
  if (answer) {
    session?.room.answerQuestion(entryId, tool.id, answer, hostName());
  }
}

/** Envoie aux participants la liste des modèles Copilot et le modèle par défaut. */
async function refreshModels(): Promise<void> {
  const s = session;
  if (!s) {
    return;
  }
  let available: Awaited<ReturnType<typeof listCopilotModels>> = [];
  try {
    available = await listCopilotModels();
  } catch {
    // Copilot absent ou pas encore prêt : liste vide, le chat affichera l'erreur à la première question.
  }
  if (session !== s) {
    return;
  }
  s.room.setModels({
    available,
    defaultId: defaultModelId(available),
    guestsCanChoose: vscode.workspace.getConfiguration(CONFIG).get<boolean>('allowGuestModelChoice', true),
  });
}

async function selectDefaultModel(): Promise<void> {
  const models = await listCopilotModels();
  if (!models.length) {
    void vscode.window.showErrorMessage(
      'Shared Copilot : aucun modèle Copilot disponible. Vérifiez que GitHub Copilot Chat est installé et connecté.',
    );
    return;
  }
  const currentId = defaultModelId(models);
  const picked = await vscode.window.showQuickPick(
    models.map((m) => ({
      label: m.id === currentId ? `$(check) ${m.name}` : m.name,
      description: m.family,
      model: m,
    })),
    { title: 'Modèle par défaut de la session partagée', placeHolder: 'Utilisé quand un participant ne choisit pas de modèle' },
  );
  if (!picked) {
    return;
  }
  // Le paramètre est stocké par famille ; on respecte le niveau (espace de travail ou utilisateur) déjà utilisé.
  const config = vscode.workspace.getConfiguration(CONFIG);
  const target =
    config.inspect('modelFamily')?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await config.update('modelFamily', picked.model.family, target);
  vscode.window.setStatusBarMessage(`Shared Copilot : modèle par défaut → ${picked.model.name}`, 3000);
}

async function showSessionNotification(s: Session, title: string): Promise<void> {
  const copy = "Copier le lien d'invitation";
  const open = 'Ouvrir le chat';
  const choice = await vscode.window.showInformationMessage(
    `Shared Copilot : ${title} sur ${s.localUrl} (127.0.0.1 uniquement — exposez ce port avec un tunnel pour inviter).`,
    copy,
    open,
  );
  if (choice === copy) {
    await copyInviteLink(s);
  } else if (choice === open) {
    await s.openChat();
  }
}

async function copyInviteLink(s: Session): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: "Lien d'invitation",
    prompt: `URL publique du tunnel vers le port ${s.server.port} (ngrok, port forwarding VS Code…). Laissez l'URL locale pour tester sur cette machine.`,
    value: s.publicUrl ?? s.localUrl,
    ignoreFocusOut: true,
    validateInput: (v) => (parseHttpUrl(v) ? undefined : 'URL http(s) invalide'),
  });
  if (input === undefined) {
    return;
  }
  const url = parseHttpUrl(input);
  if (!url) {
    return;
  }
  s.publicUrl = input.trim();
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  url.search = '';
  url.hash = '';
  url.searchParams.set('token', s.guestToken);
  await vscode.env.clipboard.writeText(url.toString());
  void vscode.window.showInformationMessage("Shared Copilot : lien d'invitation copié. Toute personne qui l'a peut rejoindre le chat.");
}

async function shareSelection(s: Session): Promise<void> {
  const editor = vscode.window.activeTextEditor ?? lastTextEditor;
  if (!editor || editor.document.isClosed) {
    void vscode.window.showWarningMessage('Shared Copilot : aucun éditeur actif à partager.');
    return;
  }
  const doc = editor.document;
  const sel = editor.selection;
  const hasSelection = !sel.isEmpty;
  const code = hasSelection ? doc.getText(sel) : doc.getText();
  if (!code.trim()) {
    void vscode.window.showWarningMessage('Shared Copilot : rien à partager (sélection ou fichier vide).');
    return;
  }
  if (code.length > LARGE_CONTEXT_CHARS) {
    const ok = await vscode.window.showWarningMessage(
      `Ce contexte fait ${code.length.toLocaleString()} caractères et sera renvoyé au modèle à chaque question. Partager quand même ?`,
      { modal: true },
      'Partager',
    );
    if (ok !== 'Partager') {
      return;
    }
  }
  const endLine = hasSelection && sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  const context = {
    author: hostName(),
    fileName: vscode.workspace.asRelativePath(doc.uri, false),
    languageId: doc.languageId,
    range: hasSelection ? `lignes ${sel.start.line + 1}-${endLine}` : undefined,
    code,
  };
  const conversationId = await pickTargetConversation(s);
  if (!conversationId) {
    return;
  }
  if (!s.room.addContext(conversationId, context)) {
    void vscode.window.showWarningMessage("Shared Copilot : cette discussion n'existe plus.");
    return;
  }
  const title = s.room.conversationList.find((c) => c.id === conversationId)?.title;
  vscode.window.setStatusBarMessage(`Shared Copilot : contexte partagé dans « ${title} »`, 3000);
}

/** Discussion ouverte dans la webview de l'hôte, la seule existante, ou choisie dans une liste. */
async function pickTargetConversation(s: Session): Promise<string | undefined> {
  const viewing = s.room.hostViewing;
  if (viewing) {
    return viewing;
  }
  const conversations = s.room.conversationList;
  if (conversations.length === 1) {
    return conversations[0].id;
  }
  const picked = await vscode.window.showQuickPick(
    [...conversations].reverse().map((c) => ({ label: c.title, description: `créée par ${c.createdBy}`, id: c.id })),
    { title: 'Partager dans quelle discussion ?' },
  );
  return picked?.id;
}

function cancelResponse(s: Session): void {
  if (!s.room.cancelCurrent()) {
    void vscode.window.showInformationMessage('Shared Copilot : aucune réponse en cours.');
  }
}

async function stopSession(): Promise<void> {
  const s = session;
  if (!s) {
    return;
  }
  session = undefined;
  tools.resetSession();
  statusBar?.hide();
  await vscode.commands.executeCommand('setContext', 'sharedCopilotChat.active', false);
  await s.stop();
}

// ---- Utilitaires ----

function withSession(fn: (s: Session) => unknown): () => Promise<void> {
  return async () => {
    if (!session) {
      const start = 'Démarrer une session';
      const choice = await vscode.window.showWarningMessage('Shared Copilot : aucune session en cours.', start);
      if (choice === start) {
        await vscode.commands.executeCommand('sharedCopilotChat.startSession');
      }
      return;
    }
    await fn(session);
  };
}

function updateStatusBar(participants: number): void {
  if (!statusBar || !session) {
    return;
  }
  statusBar.text = `$(broadcast) Shared Copilot · ${participants}`;
  statusBar.tooltip = `Session partagée sur ${session.localUrl} — ${participants} participant(s). Cliquer pour copier le lien d'invitation.`;
  statusBar.show();
}

function hostName(): string {
  const configured = vscode.workspace.getConfiguration(CONFIG).get<string>('hostName', '').trim();
  if (configured) {
    return configured;
  }
  try {
    return os.userInfo().username || 'Hôte';
  } catch {
    return 'Hôte';
  }
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function webviewHtml(src: URL): string {
  const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const nonce = crypto.randomBytes(16).toString('base64');
  // La page du chat est dans une iframe (autre origine) : on lui transmet les variables de thème de VS Code.
  const script = `
    const frame = document.querySelector('iframe');
    const target = ${JSON.stringify(src.origin)};
    function sendTheme() {
      // VS Code place les variables du thème dans l'attribut style de <html>.
      const style = document.documentElement.style;
      const vars = {};
      for (let i = 0; i < style.length; i++) {
        const name = style[i];
        if (name.startsWith('--vscode-')) vars[name] = style.getPropertyValue(name).trim();
      }
      const kind = document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light') ? 'light' : 'dark';
      frame.contentWindow.postMessage({ type: 'scc-theme', kind, vars }, target);
    }
    frame.addEventListener('load', sendTheme);
    new MutationObserver(sendTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    new MutationObserver(sendTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  `;
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${attr(src.origin)}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>html, body, iframe { margin: 0; padding: 0; border: 0; width: 100%; height: 100%; overflow: hidden; }</style>
</head>
<body><iframe src="${attr(src.toString())}" allow="clipboard-write; clipboard-read" title="Shared Copilot Chat"></iframe>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}
