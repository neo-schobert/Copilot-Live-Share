import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as vscode from 'vscode';
import { ChatRoom } from './chatRoom';
import { CopilotBackend, defaultModelId, listCopilotModels } from './copilotBackend';
import { ChatServer } from './server';

const CONFIG = 'sharedCopilotChat';
/** Au-delà, le partage de contexte demande confirmation (le modèle a une fenêtre limitée). */
const LARGE_CONTEXT_CHARS = 60_000;

class Session {
  private panel: vscode.WebviewPanel | undefined;
  /** URL publique du tunnel saisie par l'hôte, gardée en mémoire seulement. */
  publicUrl: string | undefined;

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

export function activate(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'sharedCopilotChat.copyInviteLink';
  lastTextEditor = vscode.window.activeTextEditor;

  context.subscriptions.push(
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
    vscode.lm.onDidChangeChatModels(() => void refreshModels()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG}.modelFamily`) || e.affectsConfiguration(`${CONFIG}.allowGuestModelChoice`)) {
        void refreshModels();
      }
    }),
  );
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
    return;
  }
  starting = true;
  try {
    await createSession(context);
  } finally {
    starting = false;
  }
}

async function createSession(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG);
  const port = config.get<number>('port', 3717);

  let indexHtml: string;
  let clientJs: Buffer;
  let styleCss: Buffer;
  try {
    const file = (...p: string[]) => vscode.Uri.joinPath(context.extensionUri, ...p).fsPath;
    [indexHtml, clientJs, styleCss] = await Promise.all([
      fs.readFile(file('media', 'index.html'), 'utf8'),
      fs.readFile(file('dist', 'web', 'client.js')),
      fs.readFile(file('media', 'style.css')),
    ]);
  } catch (err) {
    void vscode.window.showErrorMessage(`Shared Copilot : fichiers de la page introuvables (${String(err)}). Lancez « npm run compile ».`);
    return;
  }

  const guestToken = crypto.randomBytes(24).toString('base64url');
  const hostToken = crypto.randomBytes(24).toString('base64url');
  const room = new ChatRoom(new CopilotBackend(), {
    historyLength: () => vscode.workspace.getConfiguration(CONFIG).get<number>('historyLength', 20),
    onParticipantsChanged: (p) => updateStatusBar(p.length),
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

  session = new Session(server, room, guestToken, hostToken);
  await vscode.commands.executeCommand('setContext', 'sharedCopilotChat.active', true);
  updateStatusBar(0);
  void refreshModels();
  void showSessionNotification(session, 'Session démarrée');
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
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${attr(src.origin)}; style-src 'unsafe-inline';">
<style>html, body, iframe { margin: 0; padding: 0; border: 0; width: 100%; height: 100%; overflow: hidden; }</style>
</head>
<body><iframe src="${attr(src.toString())}" allow="clipboard-write; clipboard-read" title="Shared Copilot Chat"></iframe></body>
</html>`;
}
