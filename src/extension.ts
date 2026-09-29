import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as vscode from 'vscode';
import { PROPOSAL_SCHEME, ProposalContentProvider, WorkspaceTools } from './agentTools';
import type { ApprovalDecision, ServerMessage, SessionPolicy, TunnelState } from './protocol';
import { NotificationLevel, SessionNotifier } from './notifications';
import { languagePreference, t, uiLang } from './i18n/vscode';
import { conversationTitle } from './i18n/extension';
import { ChatRoom, InviteResult, LOCAL_HOST_CLIENT_ID, PendingQuestion } from './chatRoom';
import { CopilotBackend, defaultModelId, listCopilotModels } from './copilotBackend';
import { ChatController, ChatViewProvider, ConnectionTarget, inviteTarget, ViewState } from './chatView';
import { NativeChatBridge } from './nativeChat';
import { consumePendingStart, prepareEnvironment } from './wslSetup';
import { ChatServer } from './server';
import { PortForwarder } from './portForward';
import { Tunnel, TunnelManager, TunnelProvider, TunnelUnreachableError } from './tunnel';

const CONFIG = 'promptShare';
/** Au-delà, le partage de contexte demande confirmation (le modèle a une fenêtre limitée). */
const LARGE_CONTEXT_CHARS = 60_000;

class Session {
  /** URL publique du tunnel saisie par l'hôte, gardée en mémoire seulement. */
  publicUrl: string | undefined;
  /** Intégration au panneau Chat natif, si l'API proposée est disponible. */
  nativeChat: NativeChatBridge | undefined;
  /** Tunnel public ouvert par l'extension (arrêté avec la session). */
  tunnel: Tunnel | undefined;
  tunnelState: TunnelState = { status: 'off', provider: 'cloudflare' };

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
    this.tunnel?.stop();
    this.tunnel = undefined;
    this.nativeChat?.dispose();
    this.nativeChat = undefined;
    this.room.dispose(t('session.stoppedByHost'));
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
let tunnels: TunnelManager;
/** Invité dans VS Code : relais vers les applications partagées par l'hôte. */
let forwarder: PortForwarder | undefined;
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
  readonly hostedSession: () => { inviteLink: string; participants: string[]; awaitingReview: string[]; tunnel: TunnelState } | undefined;
  /** Rejoint une session comme le ferait l'accueil de la vue. */
  readonly join: (link: string, name: string) => Promise<void>;
  readonly viewState: () => ViewState;
  /** Discussions ouvertes dans un onglet d'éditeur. */
  readonly openTabs: () => string[];
  readonly openTab: (conversationId: string) => void;
  readonly conversations: () => { id: string; title: string }[];
  /** Invité : envoie un message à la session, comme le ferait la page. */
  readonly sendToSession: (msg: object) => boolean;
  /** Port local d'une application partagée (relais chez un invité), sans ouvrir de navigateur. */
  readonly localPortOfApp: (port: number) => Promise<number>;
  /** Nombre de décisions qui attendent ce participant (pastille). */
  readonly pendingDecisions: () => number;
  readonly viewEvents: () => string[];
  readonly logs: () => string[];
}

export function activate(context: vscode.ExtensionContext): PromptShareApi {
  output = vscode.window.createOutputChannel('Prompt Share');
  proposals = new ProposalContentProvider();
  tools = new WorkspaceTools(proposals, output, uiLang);
  sandboxReady = tools.initSandbox(log);
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'promptShare.openChat';
  lastTextEditor = vscode.window.activeTextEditor;
  chatView = new ChatViewProvider(context.extensionUri, viewController(context), (m) => {
    log(m);
    viewEvents.push(m);
  });
  notifier = createNotifier();
  tunnels = new TunnelManager(context.globalStorageUri, log);
  chatView.onServerMessage = (data) => {
    // Invité dans VS Code : les messages de la session passent par la vue et les onglets.
    if (guest && !session) {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(data) as ServerMessage;
      } catch {
        return; // Message illisible : ignoré.
      }
      notifier.feed(msg);
      if (msg.type === 'sharedApps' || msg.type === 'welcome') {
        forwarder?.keepOnly((msg.type === 'welcome' ? msg.apps : msg.apps).map((a) => a.port));
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
    vscode.commands.registerCommand('promptShare.startTunnel', withSession(startTunnelCommand)),
    vscode.commands.registerCommand('promptShare.stopTunnel', withSession((s) => stopTunnel(s))),
    vscode.commands.registerCommand('promptShare.shareApp', withSession(shareAppCommand)),
    vscode.commands.registerCommand('promptShare.shareSelection', withSession(shareSelection)),
    vscode.commands.registerCommand('promptShare.cancelResponse', withSession(cancelResponse)),
    vscode.commands.registerCommand('promptShare.stopSession', withSession(stopSession)),
    vscode.commands.registerCommand('promptShare.selectModel', selectDefaultModel),
    // Commandes internes, utilisées par les boutons du chat natif.
    vscode.commands.registerCommand('promptShare.resolveApproval', (entryId: string, toolId: string, decision: ApprovalDecision) => {
      if (!session?.room.resolveApproval(entryId, toolId, decision, hostName())) {
        void vscode.window.showInformationMessage(t('info.approvalGone'));
      }
    }),
    vscode.commands.registerCommand('promptShare.reviewQuestion', (entryId: string, accept: boolean) => {
      if (!session?.room.reviewQuestion(entryId, accept, hostName())) {
        void vscode.window.showInformationMessage(t('info.reviewGone'));
      }
    }),
    vscode.commands.registerCommand('promptShare.showDiff', async (toolId: string) => {
      if (!(await tools.showDiff(toolId))) {
        void vscode.window.showInformationMessage(t('info.diffGone'));
      }
    }),
    vscode.commands.registerCommand('promptShare.answerQuestion', async (entryId: string, toolId: string, text?: string) => {
      const answer = text ?? (await vscode.window.showInputBox({ title: t('notify.answerAgent.title'), ignoreFocusOut: true }));
      if (answer && !session?.room.answerQuestion(entryId, toolId, answer, hostName())) {
        void vscode.window.showInformationMessage(t('info.questionGone'));
      }
    }),
    vscode.lm.onDidChangeChatModels(() => void refreshModels()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG}.modelFamily`) || e.affectsConfiguration(`${CONFIG}.allowGuestModelChoice`)) {
        void refreshModels();
      }
      if (e.affectsConfiguration(`${CONFIG}.language`)) {
        chatView?.postState();
        updateStatusBar();
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
    localPortOfApp,
    pendingDecisions: () => notifier.pendingCount,
    get sandboxReady() {
      return sandboxReady;
    },
    hostedSession: () =>
      session && {
        inviteLink: inviteLink(session, session.localUrl) ?? '',
        participants: session.room.participantList.map((p) => p.name),
        awaitingReview: session.room.awaitingReviewIds,
        tunnel: session.tunnelState,
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
    void showSessionNotification(session, true);
    return;
  }
  if (starting) {
    void vscode.window.showInformationMessage(t('session.alreadyStarting'));
    return;
  }
  if (!(await acknowledgeHostNotice(context))) {
    setViewStatus(t('view.status.cancelled'));
    return;
  }
  starting = true;
  setViewStatus(t('view.status.starting'));
  log(`Start Session : ${describeEnvironment(context)}`);
  try {
    // Windows + WSL : proposition de rouvrir dans WSL, installation de ce qui manque.
    const setup = await prepareEnvironment(context, log);
    log(`Préparation de l'environnement : ${setup.outcome}${setup.redetect ? ' (nouvelle détection du bac à sable)' : ''}`);
    if (setup.outcome === 'cancelled') {
      setViewStatus(t('view.status.cancelled'));
      void vscode.window.showInformationMessage(t('session.startCancelled'));
      return;
    }
    if (setup.outcome === 'reopening') {
      setViewStatus(t('view.status.reopeningWsl'));
      return;
    }
    // Bac à sable absent jusqu'ici (ex. bubblewrap installé entre-temps) : nouvelle détection.
    if (setup.redetect || !tools.sandboxDescription()) {
      sandboxReady = tools.initSandbox(log, true);
    }
    await createSession(context);
    const started = session as Session | undefined; // modifiée par createSession
    log(started ? `Session démarrée sur ${started.localUrl}` : 'Session non démarrée.');
    setViewStatus(started ? undefined : t('view.status.startFailed'), !started);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Erreur au démarrage de la session : ${err instanceof Error && err.stack ? err.stack : message}`);
    setViewStatus(t('view.status.startError', { error: message }), true);
    void showError(t('session.startError', { error: message }));
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
    reviewGuestQuestions ? t('notice.safeguard.review') : undefined,
    guestQuestionsPerHour > 0 ? t('notice.safeguard.rate', { count: guestQuestionsPerHour }) : undefined,
  ].filter(Boolean);
  const accept = t('notice.accept');
  const terms = t('notice.terms');
  for (;;) {
    const choice = await vscode.window.showWarningMessage(
      t('notice.title'),
      {
        modal: true,
        detail: [
          t('notice.quota'),
          t('notice.responsibility'),
          safeguards.length ? t('notice.safeguards', { list: safeguards.join(t('notice.safeguards.separator')) }) : t('notice.noSafeguards'),
          t('notice.projectAccess'),
          '',
          t('notice.independent'),
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
    title: t('join.title'),
    prompt: t('join.prompt'),
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
    setViewStatus(t('join.alreadyHosting'), true);
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
      lang: uiLang(),
      langPreference: languagePreference(),
      ...viewStatus,
    }),
    setLanguage: async (preference) => {
      await vscode.workspace.getConfiguration(CONFIG).update('language', preference, vscode.ConfigurationTarget.Global);
    },
    connectionTarget: () =>
      session
        ? { url: `ws://127.0.0.1:${session.server.port}/ws?token=${encodeURIComponent(session.hostToken)}`, headers: {} }
        : guest?.target,
    host: async (name) => {
      saveName(name);
      await hostSession(context);
    },
    join: joinSession,
    openApp,
    leave: async (ended) => {
      if (guest) {
        guest = undefined;
        forwarder?.dispose();
        forwarder = undefined;
        notifier.reset();
        viewStatus = {};
        updateStatusBar(0);
        chatView?.reset();
        return;
      }
      if (session && !ended) {
        const stop = t('stop.button');
        const answer = await vscode.window.showWarningMessage(
          t('stop.confirm'),
          { modal: true, detail: t('stop.detail') },
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
  const logs = t('button.showLog');
  if ((await vscode.window.showErrorMessage(t('error.prefixed', { message }), logs)) === logs) {
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
    void vscode.window.showErrorMessage(t('server.assetsMissing', { error: String(err) }));
    return;
  }

  const guestToken = crypto.randomBytes(24).toString('base64url');
  const hostToken = crypto.randomBytes(24).toString('base64url');
  const room: ChatRoom = new ChatRoom(new CopilotBackend(tools, log), {
    historyLength: () => vscode.workspace.getConfiguration(CONFIG).get<number>('historyLength', 20),
    hostName: hostName(),
    onParticipantsChanged: (p) => updateStatusBar(p.length),
    extraInstructions: () => tools.instructions(),
    onQuestionAsked: (pending) => void askLocalHost(pending),
    onShowDiff: (_entryId, toolId) => void tools.showDiff(toolId),
    onInviteRequested: inviteFromChat,
    policy: sessionPolicy,
    defaultLang: uiLang,
    onTunnelRequested: (provider) => startTunnel(provider),
    onSessionOption: (option, value) => {
      // Réglage utilisateur : la diffusion suit (onDidChangeConfiguration).
      const key = option === 'guestModelChoice' ? 'allowGuestModelChoice' : 'reviewGuestQuestions';
      log(`Réglage modifié depuis le chat : ${key} = ${value}`);
      const config = vscode.workspace.getConfiguration(CONFIG);
      // Une valeur propre à l'espace de travail l'emporterait sur le réglage global : on la modifie elle.
      const target = config.inspect(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      void config.update(key, value, target);
    },
    onTunnelStop: () => {
      if (session) {
        stopTunnel(session);
      }
    },
    appRefusal: (p: number) => (p === server.port ? { key: 'error.appSessionPort' } : undefined),
    onAppsChanged: (apps) => server.closeRelays((p: number) => !apps.some((a) => a.port === p)),
  });
  notifier.reset();
  room.subscribe((msg) => notifier.feed(msg));
  const server: ChatServer = new ChatServer(
    {
      port,
      guestToken,
      hostToken,
      indexHtml,
      isPortShared: (p: number): boolean => room.isAppShared(p),
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
    void vscode.window.showErrorMessage(
      code === 'EADDRINUSE' ? t('server.portInUse', { port }) : t('server.startFailed', { error: String(err) }),
    );
    return;
  }

  // Les consignes du modèle et les validations dépendent du bac à sable : on attend sa détection.
  await sandboxReady;
  tools.resetSession();
  session = new Session(server, room, guestToken, hostToken);
  setTunnelState(session, { status: 'off' });
  if (config.get<boolean>('nativeChat', true)) {
    session.nativeChat = NativeChatBridge.tryCreate(room, hostName, (m) => output.appendLine(m));
  }
  await vscode.commands.executeCommand('setContext', 'promptShare.active', true);
  updateStatusBar(0);
  chatView?.postState();
  void refreshModels();
  void showSessionNotification(session, false);
}

/** Question de l'agent posée à l'hôte depuis le chat natif : réponse dans VS Code. */
async function askLocalHost(pending: PendingQuestion): Promise<void> {
  const { tool, entryId } = pending;
  if (tool.question.requesterClientId !== LOCAL_HOST_CLIENT_ID) {
    return; // Question née d'une demande web : les participants répondent depuis la page.
  }
  const free = `$(edit) ${t('agentQuestion.other')}`;
  let answer: string | undefined;
  if (tool.question.options.length) {
    const picked = await vscode.window.showQuickPick([...tool.question.options, free], {
      title: t('agentQuestion.title'),
      placeHolder: tool.question.text,
      ignoreFocusOut: true,
    });
    answer = picked === free ? undefined : picked;
    if (picked === undefined) {
      return;
    }
  }
  answer ??= await vscode.window.showInputBox({ title: t('agentQuestion.title'), prompt: tool.question.text, ignoreFocusOut: true });
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
    void vscode.window.showErrorMessage(t('model.none'));
    return;
  }
  const currentId = defaultModelId(models);
  const picked = await vscode.window.showQuickPick(
    models.map((m) => ({
      label: m.id === currentId ? `$(check) ${m.name}` : m.name,
      description: m.family,
      model: m,
    })),
    { title: t('model.pick.title'), placeHolder: t('model.pick.placeholder') },
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
  vscode.window.setStatusBarMessage(t('model.changed', { name: picked.model.name }), 3000);
}

async function showSessionNotification(s: Session, alreadyRunning: boolean): Promise<void> {
  const copy = t('invite.copy.button');
  const open = t('button.openChat');
  const choice = await vscode.window.showInformationMessage(
    t(alreadyRunning ? 'session.alreadyRunning' : 'session.started', { url: s.localUrl }),
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
    title: t('invite.title'),
    prompt: t('invite.prompt', { port: s.server.port }),
    value: s.publicUrl ?? s.localUrl,
    ignoreFocusOut: true,
    validateInput: (v) => (parseHttpUrl(v) ? undefined : t('invite.invalidUrl')),
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
  void vscode.window.showInformationMessage(t('invite.copied'));
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
    return { publicUrl: '', localUrl: '', copied: false, error: t('session.noneRunning') };
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
    return { ...result, error: t('invite.invalidUrlExample') };
  }
  result.link = link;
  if (copy) {
    s.publicUrl = base;
    await vscode.env.clipboard.writeText(link);
    result.copied = true;
  }
  return result;
}

function preferredTunnel(): TunnelProvider {
  return vscode.workspace.getConfiguration(CONFIG).get<TunnelProvider>('tunnelProvider', 'cloudflare');
}

/** Met à jour l'état du tunnel : pages de l'hôte et barre d'état. */
function setTunnelState(s: Session, state: Omit<TunnelState, 'provider'> & { provider?: TunnelProvider }): void {
  s.tunnelState = { ...state, provider: state.provider ?? preferredTunnel() };
  s.room.setTunnelState(s.tunnelState);
  updateStatusBar();
}

/**
 * Ouvre un tunnel public vers la session avec le service choisi (le dernier utilisé par
 * défaut) et copie le lien d'invitation. Déjà ouvert avec ce service : copie simplement le lien.
 */
async function startTunnel(requested?: TunnelProvider): Promise<InviteResult> {
  const s = session;
  if (!s) {
    return { publicUrl: '', localUrl: '', copied: false, error: t('session.noneRunning') };
  }
  const provider = requested ?? preferredTunnel();
  if (provider !== preferredTunnel()) {
    // Dernier choix mémorisé : il sera présélectionné la prochaine fois.
    await vscode.workspace.getConfiguration(CONFIG).update('tunnelProvider', provider, vscode.ConfigurationTarget.Global);
  }
  if (s.tunnel?.provider === provider) {
    return { ...(await inviteFromChat(s.tunnel.url, true)), tunnel: TunnelManager.label(provider) };
  }
  if (s.tunnelState.status === 'starting') {
    return { publicUrl: '', localUrl: s.localUrl, copied: false, error: t('tunnel.alreadyStarting') };
  }
  if (s.tunnel) {
    stopTunnel(s, false); // Changement de service.
  }
  setTunnelState(s, { status: 'starting', provider });
  try {
    const tunnel = await openTunnelWithFallback(s, provider);
    if (session !== s) {
      tunnel?.stop();
      return { publicUrl: '', localUrl: '', copied: false, error: t('session.ended') };
    }
    if (!tunnel) {
      setTunnelState(s, { status: 'off', provider });
      return { publicUrl: '', localUrl: s.localUrl, copied: false, error: t('tunnel.cancelled') };
    }
    s.tunnel = tunnel;
    setTunnelState(s, { status: 'on', provider: tunnel.provider, url: tunnel.url, since: Date.now() });
    const label = TunnelManager.label(tunnel.provider);
    void vscode.window.showInformationMessage(t('tunnel.opened', { provider: label }));
    return { ...(await inviteFromChat(tunnel.url, true)), tunnel: label };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Tunnel : échec (${message}).`);
    if (session === s) {
      setTunnelState(s, { status: 'error', provider, error: message });
    }
    void showError(t('tunnel.openError', { error: message }));
    return { publicUrl: '', localUrl: s.localUrl, copied: false, error: t('tunnel.failed', { error: message }) };
  }
}

/** Ouvre le tunnel ; en cas d'échec, propose d'essayer l'autre service. */
async function openTunnelWithFallback(s: Session, provider: TunnelProvider): Promise<Tunnel | undefined> {
  const onExit = (reason: string) => void onTunnelExit(s, reason);
  try {
    return await tunnels.open(provider, s.server.port, onExit);
  } catch (err) {
    const other: TunnelProvider = provider === 'cloudflare' ? 'ngrok' : 'cloudflare';
    const reason = err instanceof Error ? err.message : String(err);
    log(`Tunnel ${provider} impossible : ${reason}`);
    const tryOther = t('tunnel.tryOther', { provider: TunnelManager.label(other) });
    const hint = t(
      err instanceof TunnelUnreachableError ? 'tunnel.hint.blocked' : provider === 'ngrok' ? 'tunnel.hint.cloudflare' : 'tunnel.hint.ngrok',
    );
    const choice = await vscode.window.showWarningMessage(
      t('tunnel.openFailed', { provider: TunnelManager.label(provider) }),
      { modal: true, detail: `${reason}\n\n${hint}` },
      tryOther,
    );
    if (choice !== tryOther || session !== s) {
      throw err;
    }
    setTunnelState(s, { status: 'starting', provider: other });
    return tunnels.open(other, s.server.port, onExit);
  }
}

/** Ferme le tunnel : le lien public cesse de fonctionner, les invités à distance sont déconnectés. */
function stopTunnel(s: Session, notify = true): void {
  const tunnel = s.tunnel;
  if (!tunnel) {
    return;
  }
  s.tunnel = undefined; // Avant stop() : l'arrêt n'est pas un incident (voir onTunnelExit).
  if (s.publicUrl === tunnel.url) {
    s.publicUrl = undefined;
  }
  tunnel.stop();
  log(`Tunnel ${tunnel.provider} fermé par l'hôte.`);
  setTunnelState(s, { status: 'off', provider: tunnel.provider });
  if (notify) {
    void vscode.window.showInformationMessage(t('tunnel.closed', { provider: TunnelManager.label(tunnel.provider) }));
  }
}

/** Le tunnel s'est arrêté de lui-même : le lien public ne fonctionne plus. */
async function onTunnelExit(s: Session, reason: string): Promise<void> {
  const tunnel = s.tunnel;
  if (!tunnel) {
    return; // Fermé volontairement, ou avec la session.
  }
  if (s.publicUrl === tunnel.url) {
    s.publicUrl = undefined;
  }
  s.tunnel = undefined;
  if (session !== s) {
    return;
  }
  setTunnelState(s, { status: 'error', provider: tunnel.provider, error: t('tunnel.stoppedReason', { reason }) });
  const retry = t('tunnel.reopen');
  const choice = await vscode.window.showWarningMessage(
    t('tunnel.exited', { reason }),
    retry,
  );
  if (choice === retry) {
    await startTunnel(tunnel.provider);
  }
}

/** Palette : choix du service, puis ouverture. */
async function startTunnelCommand(): Promise<void> {
  const preferred = preferredTunnel();
  const items: (vscode.QuickPickItem & { provider: TunnelProvider })[] = [
    { provider: 'cloudflare', label: '$(cloud) Cloudflare', description: t('tunnel.pick.cloudflare.description'), detail: t('tunnel.pick.cloudflare.detail') },
    { provider: 'ngrok', label: '$(globe) ngrok', description: t('tunnel.pick.ngrok.description'), detail: t('tunnel.pick.ngrok.detail') },
  ];
  items.sort((x, y) => (x.provider === preferred ? -1 : y.provider === preferred ? 1 : 0));
  const picked = await vscode.window.showQuickPick(items, { title: t('tunnel.pick.title'), placeHolder: t('tunnel.pick.placeholder') });
  if (picked) {
    await startTunnel(picked.provider);
  }
}

/** Partage une application locale de l'hôte avec les participants. */
async function shareAppCommand(s: Session): Promise<void> {
  const port = await vscode.window.showInputBox({
    title: t('app.share.title'),
    prompt: t('app.share.prompt'),
    validateInput: (v) => (/^\d{1,5}$/.test(v.trim()) && +v > 0 && +v < 65536 ? undefined : t('app.share.invalidPort')),
  });
  if (!port) {
    return;
  }
  const label = await vscode.window.showInputBox({ title: t('app.share.label'), placeHolder: `localhost:${port.trim()}` });
  const refusal = s.room.shareApp(Number(port), label);
  if (refusal) {
    void vscode.window.showWarningMessage(t('error.prefixed', { message: refusal }));
  }
}

/** Port local d'une application partagée : le sien chez l'hôte, un relais chez un invité. */
async function localPortOfApp(port: number): Promise<number> {
  if (!session && guest) {
    forwarder ??= new PortForwarder(guest.target, log);
    return forwarder.forward(port);
  }
  return port;
}

/** Ouvre une application partagée dans le navigateur. */
async function openApp(port: number): Promise<void> {
  const localPort = await localPortOfApp(port);
  await vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${localPort}/`));
}

async function shareSelection(s: Session): Promise<void> {
  const editor = vscode.window.activeTextEditor ?? lastTextEditor;
  if (!editor || editor.document.isClosed) {
    void vscode.window.showWarningMessage(t('context.noEditor'));
    return;
  }
  const doc = editor.document;
  const sel = editor.selection;
  const hasSelection = !sel.isEmpty;
  const code = hasSelection ? doc.getText(sel) : doc.getText();
  if (!code.trim()) {
    void vscode.window.showWarningMessage(t('context.empty'));
    return;
  }
  if (code.length > LARGE_CONTEXT_CHARS) {
    const share = t('context.large.share');
    const ok = await vscode.window.showWarningMessage(
      t('context.large', { count: code.length.toLocaleString(uiLang()) }),
      { modal: true },
      share,
    );
    if (ok !== share) {
      return;
    }
  }
  const endLine = hasSelection && sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  const context = {
    author: hostName(),
    fileName: vscode.workspace.asRelativePath(doc.uri, false),
    languageId: doc.languageId,
    range: hasSelection ? t('context.lines', { start: sel.start.line + 1, end: endLine }) : undefined,
    code,
  };
  const conversationId = await pickTargetConversation(s);
  if (!conversationId) {
    return;
  }
  if (!s.room.addContext(conversationId, context)) {
    void vscode.window.showWarningMessage(t('context.conversationGone'));
    return;
  }
  const title = conversationTitle(uiLang(), s.room.conversationList.find((c) => c.id === conversationId)?.title);
  vscode.window.setStatusBarMessage(t('context.shared', { title }), 3000);
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
    [...conversations]
      .reverse()
      .map((c) => ({ label: conversationTitle(uiLang(), c.title), description: t('conversation.createdBy', { name: c.createdBy }), id: c.id })),
    { title: t('context.pickConversation') },
  );
  return picked?.id;
}

function cancelResponse(s: Session): void {
  if (!s.room.cancelCurrent()) {
    void vscode.window.showInformationMessage(t('cancel.none'));
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
      const start = t('session.start.button');
      const choice = await vscode.window.showWarningMessage(t('session.none'), start);
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
    const tunnel = session.tunnelState;
    statusBar.text = `$(broadcast) Prompt Share · ${participants}${tunnel.status === 'on' ? ' $(globe)' : tunnel.status === 'starting' ? ' $(sync~spin)' : ''}`;
    statusBar.tooltip = `${t(participants === 1 ? 'status.host.tooltip.one' : 'status.host.tooltip.other', { count: participants })}\n${
      tunnel.status === 'on' ? t('status.host.tunnel', { provider: TunnelManager.label(tunnel.provider), url: tunnel.url ?? '' }) : t('status.host.noTunnel')
    }`;
  } else if (guest) {
    statusBar.text = '$(plug) Prompt Share';
    statusBar.tooltip = t('status.guest.tooltip', { host: new URL(guest.link).host });
  } else {
    statusBar.text = '$(comment-discussion) Prompt Share';
    statusBar.tooltip = t('status.idle.tooltip');
  }
  // Décisions en attente : visibles même quand le chat est fermé.
  if ((session || guest) && pending.count) {
    statusBar.text += ` $(bell-dot) ${pending.count}`;
    statusBar.tooltip += `\n${t('status.pending', { summary: pending.summary || pending.count })}`;
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
    void vscode.window.showInformationMessage(t('session.hostOrJoinFirst'));
    return;
  }
  const picked = await vscode.window.showQuickPick(
    list.map((c) => ({ label: conversationTitle(uiLang(), c.title), description: t('conversation.by', { name: c.createdBy }), id: c.id })),
    { title: t('tab.pick.title'), placeHolder: t('tab.pick.placeholder') },
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
    return os.userInfo().username || t('host.defaultName');
  } catch {
    return t('host.defaultName');
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
