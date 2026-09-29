import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as vscode from 'vscode';
import { PROPOSAL_SCHEME, ProposalContentProvider, WorkspaceTools } from './agentTools';
import type { ApprovalDecision, ServerMessage, SessionPolicy } from './protocol';
import { NotificationLevel, SessionNotifier } from './notifications';
import { ChatRoom, InviteResult, LOCAL_HOST_CLIENT_ID, PendingQuestion } from './chatRoom';
import { CopilotBackend, defaultModelId, listCopilotModels } from './copilotBackend';
import { ChatController, ChatViewProvider, ConnectionTarget, inviteTarget, ViewState } from './chatView';
import { NativeChatBridge } from './nativeChat';
import { consumePendingStart, prepareEnvironment } from './wslSetup';
import { ChatServer } from './server';

const CONFIG = 'promptShare';
/** Au-delà, le partage de contexte demande confirmation (le modèle a une fenêtre limitée). */
const LARGE_CONTEXT_CHARS = 60_000;

class Session {
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

  async stop(): Promise<void> {
    this.nativeChat?.dispose();
    this.nativeChat = undefined;
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
/** Dernières lignes du journal (diagnostic des tests d'intégration). */
const recentLogs: string[] = [];
const log = (message: string) => {
  output?.appendLine(message);
  recentLogs.push(message);
  recentLogs.splice(0, recentLogs.length - 100);
};
let chatView: ChatViewProvider | undefined;
let notifier: SessionNotifier;
/** Dernier nombre de participants connu (barre d'état). */
let participantCount = 0;
/** Derniers évènements de la vue (diagnostic, tests). */
const viewEvents: string[] = [];
/** Session rejointe (invité) depuis la vue, avec sa cible de connexion. */
let guest: { link: string; target: ConnectionTarget } | undefined;
/** Message affiché sur l'accueil de la vue (démarrage, erreur). */
let viewStatus: { status?: string; error?: boolean } = {};

/** API interne renvoyée par activate(), utilisée par les tests d'intégration. */
export interface PromptShareApi {
  readonly tools: WorkspaceTools;
  readonly nativeChatActive: () => boolean;
  /** Résolue quand la détection du bac à sable est terminée. */
  readonly sandboxReady: Promise<unknown>;
  /** Session hébergée : lien d'invitation local et pseudos des participants connectés. */
  readonly hostedSession: () => { inviteLink: string; participants: string[]; awaitingReview: string[] } | undefined;
  /** Rejoint une session comme le ferait l'accueil de la vue. */
  readonly join: (link: string, name: string) => Promise<void>;
  readonly viewState: () => ViewState;
  /** Discussions ouvertes dans un onglet d'éditeur. */
  readonly openTabs: () => string[];
  readonly openTab: (conversationId: string) => void;
  readonly conversations: () => { id: string; title: string }[];
  /** Invité : envoie un message à la session, comme le ferait la page. */
  readonly sendToSession: (msg: object) => boolean;
  /** Nombre de décisions qui attendent ce participant (pastille). */
  readonly pendingDecisions: () => number;
  readonly viewEvents: () => string[];
  readonly logs: () => string[];
}

export function activate(context: vscode.ExtensionContext): PromptShareApi {
  output = vscode.window.createOutputChannel('Prompt Share');
  proposals = new ProposalContentProvider();
  tools = new WorkspaceTools(proposals, output);
  sandboxReady = tools.initSandbox(log);
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'promptShare.openChat';
  lastTextEditor = vscode.window.activeTextEditor;
  chatView = new ChatViewProvider(context.extensionUri, viewController(context), (m) => {
    log(m);
    viewEvents.push(m);
  });
  notifier = createNotifier();
  chatView.onServerMessage = (data) => {
    // Invité dans VS Code : les messages de la session passent par la vue et les onglets.
    if (guest && !session) {
      try {
        notifier.feed(JSON.parse(data) as ServerMessage);
      } catch {
        // Message illisible : ignoré.
      }
    }
  };
  updateStatusBar(0);

  log(`Extension activée : ${describeEnvironment(context)}`);

  context.subscriptions.push(
    output,
    chatView,
    // La vue garde sa connexion quand elle est masquée (changement d'onglet de la barre latérale).
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chatView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, proposals),
    statusBar,
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e) {
        lastTextEditor = e;
      }
    }),
    vscode.commands.registerCommand('promptShare.startSession', () => hostSession(context)),
    vscode.commands.registerCommand('promptShare.host', () => hostSession(context)),
    vscode.commands.registerCommand('promptShare.join', () => joinFromCommand()),
    vscode.commands.registerCommand('promptShare.leave', () => viewController(context).leave(false)),
    vscode.commands.registerCommand('promptShare.copyInviteLink', withSession(copyInviteLink)),
    vscode.commands.registerCommand('promptShare.openChat', () => chatView?.reveal()),
    vscode.commands.registerCommand('promptShare.openConversationTab', openConversationTabCommand),
    vscode.commands.registerCommand('promptShare.shareSelection', withSession(shareSelection)),
    vscode.commands.registerCommand('promptShare.cancelResponse', withSession(cancelResponse)),
    vscode.commands.registerCommand('promptShare.stopSession', withSession(stopSession)),
    vscode.commands.registerCommand('promptShare.selectModel', selectDefaultModel),
    // Commandes internes, utilisées par les boutons du chat natif.
    vscode.commands.registerCommand('promptShare.resolveApproval', (entryId: string, toolId: string, decision: ApprovalDecision) => {
      if (!session?.room.resolveApproval(entryId, toolId, decision, hostName())) {
        void vscode.window.showInformationMessage("Prompt Share : cette action n'attend plus de validation.");
      }
    }),
    vscode.commands.registerCommand('promptShare.reviewQuestion', (entryId: string, accept: boolean) => {
      if (!session?.room.reviewQuestion(entryId, accept, hostName())) {
        void vscode.window.showInformationMessage("Prompt Share : cette question n'attend plus votre accord.");
      }
    }),
    vscode.commands.registerCommand('promptShare.showDiff', async (toolId: string) => {
      if (!(await tools.showDiff(toolId))) {
        void vscode.window.showInformationMessage("Prompt Share : cette modification n'est plus en attente.");
      }
    }),
    vscode.commands.registerCommand('promptShare.answerQuestion', async (entryId: string, toolId: string, text?: string) => {
      const answer = text ?? (await vscode.window.showInputBox({ title: "Réponse à l'agent", ignoreFocusOut: true }));
      if (answer && !session?.room.answerQuestion(entryId, toolId, answer, hostName())) {
        void vscode.window.showInformationMessage("Prompt Share : cette question n'attend plus de réponse.");
      }
    }),
    vscode.lm.onDidChangeChatModels(() => void refreshModels()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG}.modelFamily`) || e.affectsConfiguration(`${CONFIG}.allowGuestModelChoice`)) {
        void refreshModels();
      }
      if (e.affectsConfiguration(`${CONFIG}.reviewGuestQuestions`) || e.affectsConfiguration(`${CONFIG}.guestQuestionsPerHour`)) {
        session?.room.broadcastPolicy();
      }
      if (['wslSandbox', 'wslDistro', 'sandboxReadOnlyPaths'].some((k) => e.affectsConfiguration(`${CONFIG}.${k}`))) {
        sandboxReady = tools.initSandbox(log, true);
      }
    }),
  );
  // Fenêtre rouverte dans WSL à la demande de « Start Session » : la session reprend d'elle-même.
  if (consumePendingStart(context)) {
    setTimeout(() => void hostSession(context), 1000);
  }

  return {
    tools,
    nativeChatActive: () => !!session?.nativeChat,
    logs: () => [...recentLogs],
    openTabs: () => chatView?.openTabs ?? [],
    openTab: (id) => openConversationTab(id),
    conversations: () => conversationsOfSession(),
    sendToSession: (msg) => !!chatView?.sendToSession(msg),
    pendingDecisions: () => notifier.pendingCount,
    get sandboxReady() {
      return sandboxReady;
    },
    hostedSession: () =>
      session && {
        inviteLink: inviteLink(session, session.localUrl) ?? '',
        participants: session.room.participantList.map((p) => p.name),
        awaitingReview: session.room.awaitingReviewIds,
      },
    join: async (link, name) => {
      await chatView?.reveal();
      await joinSession(name, link);
    },
    viewState: () => viewController(context).state(),
    viewEvents: () => [...viewEvents],
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
    void vscode.window.showInformationMessage('Prompt Share : démarrage de la session déjà en cours…');
    return;
  }
  if (!(await acknowledgeHostNotice(context))) {
    setViewStatus('Démarrage annulé.');
    return;
  }
  starting = true;
  setViewStatus('Démarrage de la session…');
  log(`Start Session : ${describeEnvironment(context)}`);
  try {
    // Windows + WSL : proposition de rouvrir dans WSL, installation de ce qui manque.
    const setup = await prepareEnvironment(context, log);
    log(`Préparation de l'environnement : ${setup.outcome}${setup.redetect ? ' (nouvelle détection du bac à sable)' : ''}`);
    if (setup.outcome === 'cancelled') {
      setViewStatus('Démarrage annulé.');
      void vscode.window.showInformationMessage('Prompt Share : démarrage de la session annulé.');
      return;
    }
    if (setup.outcome === 'reopening') {
      setViewStatus('Réouverture du projet dans WSL…');
      return;
    }
    // Bac à sable absent jusqu'ici (ex. bubblewrap installé entre-temps) : nouvelle détection.
    if (setup.redetect || !tools.sandboxDescription()) {
      sandboxReady = tools.initSandbox(log, true);
    }
    await createSession(context);
    const started = session as Session | undefined; // modifiée par createSession
    log(started ? `Session démarrée sur ${started.localUrl}` : 'Session non démarrée.');
    setViewStatus(started ? undefined : 'La session n’a pas pu démarrer (détails dans le canal de sortie « Prompt Share »).', !started);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Erreur au démarrage de la session : ${err instanceof Error && err.stack ? err.stack : message}`);
    setViewStatus(`Impossible de démarrer la session : ${message}`, true);
    void showError(`impossible de démarrer la session (${message}).`);
  } finally {
    starting = false;
    chatView?.postState();
  }
}

const HOST_NOTICE_KEY = 'promptShare.hostNoticeAccepted';
const HOST_NOTICE_VERSION = 1;
const GITHUB_TERMS = 'https://docs.github.com/en/site-policy/github-terms/github-terms-of-service';

/**
 * Avant la première session hébergée : ce que partager son accès implique (compte GitHub,
 * quota, lecture du projet par les invités). Doit être accepté une fois.
 */
async function acknowledgeHostNotice(context: vscode.ExtensionContext): Promise<boolean> {
  if (context.globalState.get<number>(HOST_NOTICE_KEY) === HOST_NOTICE_VERSION) {
    return true;
  }
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    log("Avertissement de l'hôte ignoré (tests).");
    return true;
  }
  const { reviewGuestQuestions, guestQuestionsPerHour } = sessionPolicy();
  const safeguards = [
    reviewGuestQuestions ? 'vous validez chaque question d’invité avant son envoi au modèle' : undefined,
    guestQuestionsPerHour > 0 ? `les invités sont limités à ${guestQuestionsPerHour} questions par heure` : undefined,
  ].filter(Boolean);
  const accept = 'J’ai compris, héberger';
  const terms = 'Conditions de GitHub';
  for (;;) {
    const choice = await vscode.window.showWarningMessage(
      'Prompt Share : avant d’héberger une session',
      {
        modal: true,
        detail: [
          '• Les questions des invités sont envoyées aux modèles GitHub Copilot avec votre compte et comptent dans votre quota, requêtes premium comprises.',
          '• Vous restez responsable de l’usage de votre compte. Les conditions de GitHub réservent un compte à une seule personne et interdisent d’exploiter ou de revendre l’accès au service. Hébergez des sessions de travail avec des personnes de confiance, en restant présent : Prompt Share n’est pas un moyen de partager un abonnement.',
          safeguards.length
            ? `• Protections actives : ${safeguards.join(' ; ')} (réglages « promptShare »).`
            : '• Attention : vous avez désactivé la validation des questions et la limite horaire (réglages « promptShare »).',
          '• Par l’agent, les invités peuvent lire le projet ouvert (sauf les fichiers protégés : .env, clés, .git…). Ne donnez le lien d’invitation qu’aux personnes concernées.',
          '',
          'Prompt Share est un projet indépendant, non affilié à GitHub ni à Microsoft.',
        ].join('\n'),
      },
      accept,
      terms,
    );
    if (choice === terms) {
      await vscode.env.openExternal(vscode.Uri.parse(GITHUB_TERMS));
      continue;
    }
    if (choice !== accept) {
      log("Avertissement de l'hôte refusé : session non démarrée.");
      return false;
    }
    await context.globalState.update(HOST_NOTICE_KEY, HOST_NOTICE_VERSION);
    log("Avertissement de l'hôte accepté.");
    return true;
  }
}

function sessionPolicy(): SessionPolicy {
  const config = vscode.workspace.getConfiguration(CONFIG);
  return {
    reviewGuestQuestions: config.get<boolean>('reviewGuestQuestions', true),
    guestQuestionsPerHour: Math.max(0, Math.floor(config.get<number>('guestQuestionsPerHour', 60))),
  };
}

// ---- Vue du chat : héberger, rejoindre, quitter ----

/** Héberger : démarre la session (avec la proposition WSL sous Windows) et affiche le chat. */
async function hostSession(context: vscode.ExtensionContext): Promise<void> {
  void chatView?.reveal();
  await startSession(context);
}

/** Rejoindre depuis la palette : demande le lien puis ouvre le chat. */
async function joinFromCommand(): Promise<void> {
  const link = await vscode.window.showInputBox({
    title: 'Rejoindre une session Prompt Share',
    prompt: "Collez le lien d'invitation reçu de l'hôte.",
    placeHolder: 'https://xxxx.ngrok-free.app/?token=…',
    ignoreFocusOut: true,
  });
  if (link) {
    await chatView?.reveal();
    await joinSession(hostName(), link);
  }
}

async function joinSession(name: string, link: string): Promise<void> {
  if (session) {
    setViewStatus('Vous hébergez déjà une session : arrêtez-la avant d’en rejoindre une autre.', true);
    return;
  }
  const target = inviteTarget(link);
  if (typeof target === 'string') {
    setViewStatus(target, true);
    return;
  }
  saveName(name);
  notifier.reset();
  guest = { link, target };
  viewStatus = {};
  log(`Session rejointe : ${new URL(link).host}`);
  updateStatusBar(0);
  chatView?.postState();
}

function viewController(context: vscode.ExtensionContext): ChatController {
  return {
    state: (): ViewState => ({
      mode: session ? 'host' : guest ? 'guest' : 'idle',
      name: hostName(),
      busy: starting,
      ...viewStatus,
    }),
    connectionTarget: () =>
      session
        ? { url: `ws://127.0.0.1:${session.server.port}/ws?token=${encodeURIComponent(session.hostToken)}`, headers: {} }
        : guest?.target,
    host: async (name) => {
      saveName(name);
      await hostSession(context);
    },
    join: joinSession,
    leave: async (ended) => {
      if (guest) {
        guest = undefined;
        notifier.reset();
        viewStatus = {};
        updateStatusBar(0);
        chatView?.reset();
        return;
      }
      if (session && !ended) {
        const stop = 'Arrêter la session';
        const answer = await vscode.window.showWarningMessage(
          'Arrêter la session partagée ?',
          { modal: true, detail: 'Tous les participants seront déconnectés et l’historique sera perdu.' },
          stop,
        );
        if (answer !== stop) {
          return;
        }
        await stopSession();
      }
      viewStatus = {};
      chatView?.reset();
    },
  };
}

function setViewStatus(status: string | undefined, error = false): void {
  viewStatus = status ? { status, error } : {};
  chatView?.postState();
}

/** Pseudo saisi dans la vue, utilisé tout de suite (l'enregistrement du paramètre est asynchrone). */
let chosenName: string | undefined;

/** Mémorise le pseudo saisi dans la vue (paramètre promptShare.hostName). */
function saveName(name: string): void {
  const clean = name.trim().slice(0, 32);
  if (clean && clean !== hostName()) {
    chosenName = clean;
    void vscode.workspace.getConfiguration(CONFIG).update('hostName', clean, vscode.ConfigurationTarget.Global);
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
  if ((await vscode.window.showErrorMessage(`Prompt Share : ${message}`, logs)) === logs) {
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
    void vscode.window.showErrorMessage(`Prompt Share : fichiers de la page introuvables (${String(err)}). Lancez « npm run compile ».`);
    return;
  }

  const guestToken = crypto.randomBytes(24).toString('base64url');
  const hostToken = crypto.randomBytes(24).toString('base64url');
  const room = new ChatRoom(new CopilotBackend(tools, log), {
    historyLength: () => vscode.workspace.getConfiguration(CONFIG).get<number>('historyLength', 20),
    hostName: hostName(),
    onParticipantsChanged: (p) => updateStatusBar(p.length),
    extraInstructions: () => tools.instructions(),
    onQuestionAsked: (pending) => void askLocalHost(pending),
    onShowDiff: (_entryId, toolId) => void tools.showDiff(toolId),
    onInviteRequested: inviteFromChat,
    policy: sessionPolicy,
  });
  notifier.reset();
  room.subscribe((msg) => notifier.feed(msg));
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
        ? `le port ${port} est déjà utilisé. Changez le paramètre « promptShare.port ».`
        : String(err);
    void vscode.window.showErrorMessage(`Prompt Share : impossible de démarrer le serveur, ${detail}`);
    return;
  }

  // Les consignes du modèle et les validations dépendent du bac à sable : on attend sa détection.
  await sandboxReady;
  tools.resetSession();
  session = new Session(server, room, guestToken, hostToken);
  if (config.get<boolean>('nativeChat', true)) {
    session.nativeChat = NativeChatBridge.tryCreate(room, hostName, (m) => output.appendLine(m));
  }
  await vscode.commands.executeCommand('setContext', 'promptShare.active', true);
  updateStatusBar(0);
  chatView?.postState();
  void refreshModels();
  void showSessionNotification(session, 'Session démarrée');
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
      title: `Prompt Share — question de l'agent`,
      placeHolder: tool.question.text,
      ignoreFocusOut: true,
    });
    answer = picked === free ? undefined : picked;
    if (picked === undefined) {
      return;
    }
  }
  answer ??= await vscode.window.showInputBox({ title: "Prompt Share — question de l'agent", prompt: tool.question.text, ignoreFocusOut: true });
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
    guestsCanChoose: vscode.workspace.getConfiguration(CONFIG).get<boolean>('allowGuestModelChoice', false),
  });
}

async function selectDefaultModel(): Promise<void> {
  const models = await listCopilotModels();
  if (!models.length) {
    void vscode.window.showErrorMessage(
      'Prompt Share : aucun modèle Copilot disponible. Vérifiez que GitHub Copilot Chat est installé et connecté.',
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
  vscode.window.setStatusBarMessage(`Prompt Share : modèle par défaut → ${picked.model.name}`, 3000);
}

async function showSessionNotification(s: Session, title: string): Promise<void> {
  const copy = "Copier le lien d'invitation";
  const open = 'Ouvrir le chat';
  const choice = await vscode.window.showInformationMessage(
    `Prompt Share : ${title} sur ${s.localUrl}. Pour inviter, exposez ce port avec un tunnel puis utilisez « Inviter » dans le chat.`,
    copy,
    open,
  );
  if (choice === copy) {
    await copyInviteLink(s);
  } else if (choice === open) {
    await chatView?.reveal();
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
  const link = inviteLink(s, input);
  if (!link) {
    return;
  }
  s.publicUrl = input.trim();
  await vscode.env.clipboard.writeText(link);
  void vscode.window.showInformationMessage("Prompt Share : lien d'invitation copié. Toute personne qui l'a peut rejoindre le chat.");
}

/** Lien d'invitation pour une URL de base (tunnel ou locale), ou undefined si l'URL est invalide. */
function inviteLink(s: Session, base: string): string | undefined {
  const url = parseHttpUrl(base);
  if (!url) {
    return undefined;
  }
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  url.search = '';
  url.hash = '';
  url.searchParams.set('token', s.guestToken);
  return url.toString();
}

/** Demande de lien depuis la page de chat de l'hôte : le lien est copié par VS Code (fiable dans la webview). */
async function inviteFromChat(publicUrl: string | undefined, copy: boolean): Promise<InviteResult> {
  const s = session;
  if (!s) {
    return { publicUrl: '', localUrl: '', copied: false, error: 'Aucune session en cours.' };
  }
  const base = publicUrl?.trim() || s.publicUrl || '';
  const result: InviteResult = { publicUrl: base, localUrl: s.localUrl, copied: false };
  if (!base) {
    // Sans tunnel : lien local, valable seulement sur cette machine.
    result.link = inviteLink(s, s.localUrl);
    if (copy && result.link) {
      await vscode.env.clipboard.writeText(result.link);
      result.copied = true;
    }
    return result;
  }
  const link = inviteLink(s, base);
  if (!link) {
    return { ...result, error: 'URL invalide : collez une adresse http(s), par exemple https://xxxx.ngrok-free.app' };
  }
  result.link = link;
  if (copy) {
    s.publicUrl = base;
    await vscode.env.clipboard.writeText(link);
    result.copied = true;
  }
  return result;
}

async function shareSelection(s: Session): Promise<void> {
  const editor = vscode.window.activeTextEditor ?? lastTextEditor;
  if (!editor || editor.document.isClosed) {
    void vscode.window.showWarningMessage('Prompt Share : aucun éditeur actif à partager.');
    return;
  }
  const doc = editor.document;
  const sel = editor.selection;
  const hasSelection = !sel.isEmpty;
  const code = hasSelection ? doc.getText(sel) : doc.getText();
  if (!code.trim()) {
    void vscode.window.showWarningMessage('Prompt Share : rien à partager (sélection ou fichier vide).');
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
    void vscode.window.showWarningMessage("Prompt Share : cette discussion n'existe plus.");
    return;
  }
  const title = s.room.conversationList.find((c) => c.id === conversationId)?.title;
  vscode.window.setStatusBarMessage(`Prompt Share : contexte partagé dans « ${title} »`, 3000);
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
    void vscode.window.showInformationMessage('Prompt Share : aucune réponse en cours.');
  }
}

async function stopSession(): Promise<void> {
  const s = session;
  if (!s) {
    return;
  }
  session = undefined;
  notifier.reset();
  tools.resetSession();
  await vscode.commands.executeCommand('setContext', 'promptShare.active', false);
  await s.stop();
  updateStatusBar(0);
}

// ---- Utilitaires ----

function withSession(fn: (s: Session) => unknown): () => Promise<void> {
  return async () => {
    if (!session) {
      const start = 'Démarrer une session';
      const choice = await vscode.window.showWarningMessage('Prompt Share : aucune session en cours.', start);
      if (choice === start) {
        await vscode.commands.executeCommand('promptShare.startSession');
      }
      return;
    }
    await fn(session);
  };
}

/** Bouton de la barre d'état, toujours visible : ouvre le chat (accueil, session hébergée ou rejointe). */
function updateStatusBar(participants = participantCount, pending = { count: notifier?.pendingCount ?? 0, summary: '' }): void {
  participantCount = participants;
  if (!statusBar) {
    return;
  }
  if (session) {
    statusBar.text = `$(broadcast) Prompt Share · ${participants}`;
    statusBar.tooltip = `Vous hébergez une session (${participants} participant(s)). Cliquer pour ouvrir le chat.`;
  } else if (guest) {
    statusBar.text = '$(plug) Prompt Share';
    statusBar.tooltip = `Connecté à la session de ${new URL(guest.link).host}. Cliquer pour ouvrir le chat.`;
  } else {
    statusBar.text = '$(comment-discussion) Prompt Share';
    statusBar.tooltip = 'Héberger ou rejoindre une session Prompt Share';
  }
  // Décisions en attente : visibles même quand le chat est fermé.
  if ((session || guest) && pending.count) {
    statusBar.text += ` $(bell-dot) ${pending.count}`;
    statusBar.tooltip += `\nEn attente de votre décision : ${pending.summary || pending.count}.`;
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    statusBar.backgroundColor = undefined;
  }
  statusBar.show();
  // Utilisé par le menu de la vue (bouton « Quitter ») et la palette.
  void vscode.commands.executeCommand('setContext', 'promptShare.connected', !!session || !!guest);
}

/** Notifications et décisions en attente, pour l'hôte (salle locale) ou un invité (messages relayés). */
function createNotifier(): SessionNotifier {
  return new SessionNotifier(
    () =>
      session
        ? { isHost: true, clientIds: [chatView!.clientId, LOCAL_HOST_CLIENT_ID] }
        : guest
          ? { isHost: false, clientIds: [chatView!.clientId] }
          : undefined,
    {
      approve: (entryId, toolId, decision) => {
        if (session) {
          session.room.resolveApproval(entryId, toolId, decision, hostName());
        } else {
          chatView?.sendToSession({ type: 'approve', entryId, toolId, decision });
        }
      },
      review: (entryId, accept) => {
        if (session) {
          session.room.reviewQuestion(entryId, accept, hostName());
        } else {
          chatView?.sendToSession({ type: 'reviewQuestion', entryId, accept });
        }
      },
      answer: (entryId, toolId, text) => {
        if (session) {
          session.room.answerQuestion(entryId, toolId, text, hostName());
        } else {
          chatView?.sendToSession({ type: 'answer', entryId, toolId, text });
        }
      },
      open: (conversationId) => openConversationTab(conversationId),
      showDiff: (toolId) => void tools.showDiff(toolId),
    },
    () => vscode.workspace.getConfiguration(CONFIG).get<NotificationLevel>('notifications', 'decisions'),
    (count, summary) => {
      chatView?.setBadge(count, summary);
      updateStatusBar(participantCount, { count, summary });
    },
    // L'hôte répond déjà aux questions nées du chat natif (sélecteur dans VS Code).
    (tool) => tool.question?.requesterClientId === LOCAL_HOST_CLIENT_ID,
  );
}

function conversationsOfSession() {
  return session ? session.room.conversationList : notifier.conversations;
}

/** Ouvre une discussion dans un onglet d'éditeur (déplaçable, à côté des autres). */
function openConversationTab(conversationId: string): void {
  const conv = conversationsOfSession().find((c) => c.id === conversationId);
  chatView?.openTab(conversationId, conv?.title);
}

async function openConversationTabCommand(): Promise<void> {
  const list = conversationsOfSession();
  if (!session && !guest) {
    void vscode.window.showInformationMessage('Prompt Share : hébergez ou rejoignez d’abord une session.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    list.map((c) => ({ label: c.title, description: `par ${c.createdBy}`, id: c.id })),
    { title: 'Ouvrir une discussion dans un onglet', placeHolder: 'Discussion' },
  );
  if (picked) {
    openConversationTab(picked.id);
  }
}

function hostName(): string {
  if (chosenName) {
    return chosenName;
  }
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
