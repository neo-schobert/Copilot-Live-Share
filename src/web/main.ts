import {
  AssistantEntry,
  ChatEntry,
  CLOSE_CODES,
  Conversation,
  LIMITS,
  ModelsState,
  Participant,
  QueueState,
  ServerMessage,
  SessionPolicy,
  SharedApp,
  SummaryEntry,
  ToolActivity,
  TunnelProviderId,
  TunnelState,
  UserEntry,
  WS_PATH,
} from '../protocol';
import { codeBlock, renderMarkdown, setMarkdownLang } from './markdown';
import { I18nText, isLang, Lang, LANG_NAMES, LANGS, LangPreference, Params, resolveLang } from '../i18n/core';
import { RoomKey, roomT } from '../i18n/room';
import { WebKey, webT } from '../i18n/web';
import { openVsCode, openWebSocket, Transport, vscodeApi } from './transport';

// ---- Éléments ----

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const joinScreen = $<HTMLElement>('join');
const joinForm = $<HTMLFormElement>('join-form');
const nameInput = $<HTMLInputElement>('name-input');
const app = $<HTMLElement>('app');
const connectionEl = $<HTMLElement>('connection');
const convTitle = $<HTMLElement>('conv-title');
const renameBtn = $<HTMLButtonElement>('rename');
const renameForm = $<HTMLFormElement>('rename-form');
const renameInput = $<HTMLInputElement>('rename-input');
const convsEl = $<HTMLElement>('convs');
const convList = $<HTMLUListElement>('conv-list');
const newConvBtn = $<HTMLButtonElement>('new-conv');
const convsToggle = $<HTMLButtonElement>('toggle-convs');
const unreadTotal = $<HTMLElement>('unread-total');
const messagesEl = $<HTMLElement>('messages');
const peopleToggle = $<HTMLButtonElement>('toggle-people');
const peoplePopover = $<HTMLElement>('people');
const peopleList = $<HTMLUListElement>('people-list');
const peopleCount = $<HTMLElement>('people-count');
const avatarStack = $<HTMLElement>('avatar-stack');
const bannerEl = $<HTMLElement>('banner');
const activityEl = $<HTMLElement>('activity');
const activityText = $<HTMLElement>('activity-text');
const cancelBtn = $<HTMLButtonElement>('cancel');
const askForm = $<HTMLFormElement>('ask-form');
const askInput = $<HTMLTextAreaElement>('ask-input');
const askSend = $<HTMLButtonElement>('ask-send');
const modelSelect = $<HTMLSelectElement>('model-select');
const modelChevron = $<HTMLElement>('model-chevron');
const hostOptions = $<HTMLElement>('host-options');
const optModelChoice = $<HTMLInputElement>('opt-model-choice');
const optReview = $<HTMLInputElement>('opt-review');
const presenceEl = $<HTMLElement>('presence');
const jumpBtn = $<HTMLButtonElement>('jump');
const inviteBtn = $<HTMLButtonElement>('invite-btn');
const invitePop = $<HTMLElement>('invite-pop');
const inviteHint = $<HTMLElement>('invite-hint');
const inviteForm = $<HTMLFormElement>('invite-form');
const inviteUrl = $<HTMLInputElement>('invite-url');
const inviteResult = $<HTMLElement>('invite-result');
const toastEl = $<HTMLElement>('toast');
const homeScreen = $<HTMLElement>('home');
const homeName = $<HTMLInputElement>('home-name');
const homeHost = $<HTMLButtonElement>('home-host');
const homeJoinForm = $<HTMLFormElement>('home-join-form');
const homeLink = $<HTMLInputElement>('home-link');
const homeStatus = $<HTMLElement>('home-status');
const leaveBtn = $<HTMLButtonElement>('leave');
const policyNote = $<HTMLElement>('policy-note');
const openTabBtn = $<HTMLButtonElement>('open-tab');
const contextBtn = $<HTMLButtonElement>('context-btn');
const contextRing = $<HTMLElement>('context-ring');
const contextPct = $<HTMLElement>('context-pct');
const contextPop = $<HTMLElement>('context-pop');
const contextFill = $<HTMLElement>('context-fill');
const contextDetail = $<HTMLElement>('context-detail');
const contextWarn = $<HTMLElement>('context-warn');
const compactBtn = $<HTMLButtonElement>('compact-btn');
const compactHint = $<HTMLElement>('compact-hint');
const tunnelBtn = $<HTMLButtonElement>('tunnel-btn');
const tunnelStatus = $<HTMLElement>('tunnel-status');
const tunnelChoose = $<HTMLElement>('tunnel-choose');
const tunnelOn = $<HTMLElement>('tunnel-on');
const tunnelTitle = $<HTMLElement>('tunnel-title');
const tunnelSince = $<HTMLElement>('tunnel-since');
const tunnelUrl = $<HTMLElement>('tunnel-url');
const tunnelCopy = $<HTMLButtonElement>('tunnel-copy');
const tunnelStop = $<HTMLButtonElement>('tunnel-stop');
const appsWrap = $<HTMLElement>('apps-wrap');
const appsBtn = $<HTMLButtonElement>('apps-btn');
const appsCount = $<HTMLElement>('apps-count');
const appsPop = $<HTMLElement>('apps-pop');
const appsHint = $<HTMLElement>('apps-hint');
const appsList = $<HTMLUListElement>('apps-list');
const appsForm = $<HTMLFormElement>('apps-form');
const appsPort = $<HTMLInputElement>('apps-port');
const appsLabel = $<HTMLInputElement>('apps-label');
const inviteWarn = Object.assign(document.createElement('p'), { className: 'hint warn' });

// ---- État ----

const params = new URLSearchParams(location.search);
const token = params.get('token') ?? '';
let clientId = loadClientId();
/** Dans un onglet d'éditeur de VS Code : la seule discussion affichée. */
let panelConversation: string | undefined;

let myName = '';
let me: Participant | undefined;
let ws: Transport | undefined;
let ended = false;
let reconnectDelay = 1000;
let reconnectTimer: number | undefined;

let conversations: Conversation[] = [];
let activeId: string | null = null;
/** Nombre de nouveaux messages par discussion non affichée. */
const unread = new Map<string, number>();
/** Entrées de toutes les discussions ; seules celles de la discussion active sont dans le DOM. */
const entries = new Map<string, ChatEntry>();
const entryEls = new Map<string, HTMLElement>();
let participants: Participant[] = [];
let policy: SessionPolicy = { reviewGuestQuestions: false, guestQuestionsPerHour: 0 };
/** Applications locales partagées par l'hôte. */
let apps: SharedApp[] = [];
/** Tunnel public de la session (hôte seulement). */
let tunnel: TunnelState | undefined;
const TUNNEL_LABELS: Record<TunnelProviderId, string> = { cloudflare: 'Cloudflare', ngrok: 'ngrok' };
let queue: QueueState = { current: null, pending: [] };
let models: ModelsState = { available: [], defaultId: null, guestsCanChoose: true };
/** Pourquoi le choix du modèle est impossible ('' : possible). */
let lockReason: WebKey | '' = '';
/** Modèle choisi par ce participant ; '' = modèle par défaut de la session. */
let chosenModel = storage('local', 'scc.model') ?? '';
/** Participants en train d'écrire : clientId -> discussion et échéance de l'indicateur. */
const typing = new Map<string, { name: string; conversationId: string; until: number }>();
const TYPING_TTL_MS = 4000;
let lastTypingSent = 0;
/** Entrées dont le rendu doit être rafraîchi à la prochaine frame (streaming). */
const dirty = new Set<string>();
let frameRequested = false;

const SUGGESTIONS: WebKey[] = ['suggestion.structure', 'suggestion.todo', 'suggestion.errors'];
/** Libellé de l'indicateur de connexion (re-traduit au changement de langue). */
let connectionLabel: { key: WebKey; params?: Params } = { key: 'connection.connecting' };
/** Raison de la fin de session, affichée dans le bandeau (re-traduite au changement de langue). */
let endReason: (() => string) | undefined;
/** Rôle dans la session ouverte depuis VS Code (titre du bouton Quitter / Arrêter). */
let sessionMode: 'host' | 'guest' | undefined;
/** Dernière réponse à une demande de lien d'invitation (re-rendue au changement de langue). */
let lastInvite: Extract<ServerMessage, { type: 'invite' }> | undefined;

// ---- Démarrage ----

// ---- Langue ----

/** Préférence de langue : réglage de VS Code (webview) ou choix mémorisé par le navigateur. */
let langPreference: LangPreference = ((): LangPreference => {
  const stored = storage('local', 'scc.lang');
  return stored && (stored === 'auto' || isLang(stored)) ? (stored as LangPreference) : 'auto';
})();
/** Langue automatique : celle de VS Code (webview), sinon du navigateur. */
let autoLang: Lang = resolveLang(undefined, ...(navigator.languages ?? [navigator.language]));
let lang: Lang = langPreference === 'auto' ? autoLang : langPreference;
setMarkdownLang(lang);

/** Texte de la page dans la langue courante. */
function t(key: WebKey, params?: Params): string {
  return webT(lang, key, params);
}

/** Titre affiché d'une discussion (titre vide : « Nouvelle discussion » dans la langue de la page). */
function convTitleText(conv: Conversation): string {
  return conv.title || tr({ key: 'conv.untitled' }, '');
}

/** Code de langue pour les dates et nombres. */
function locale(): string {
  return { fr: 'fr-FR', en: 'en-US', de: 'de-DE' }[lang];
}

/** Texte envoyé par le serveur à traduire ici (repli : texte brut, dans la langue de l'hôte). */
function tr(text: I18nText | undefined, fallback: string): string {
  return text ? roomT(lang, text.key as RoomKey, text.params) : fallback;
}

/** Textes fixes de la page : attributs data-i18n (contenu), -placeholder, -title, -aria-label. */
function applyStaticI18n(): void {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n as WebKey);
  }
  for (const [attr, data] of [['placeholder', 'i18nPlaceholder'], ['title', 'i18nTitle'], ['aria-label', 'i18nAriaLabel']] as const) {
    for (const el of document.querySelectorAll<HTMLElement>(`[data-${attr === 'aria-label' ? 'i18n-aria-label' : `i18n-${attr}`}]`)) {
      el.setAttribute(attr, t(el.dataset[data] as WebKey));
    }
  }
  for (const select of document.querySelectorAll<HTMLSelectElement>('select.lang-select')) {
    select.replaceChildren(
      new Option(t('lang.auto', { name: LANG_NAMES[autoLang] }), 'auto'),
      ...LANGS.map((l) => new Option(LANG_NAMES[l], l)),
    );
    select.value = langPreference;
  }
}

/** Change de langue : textes fixes, rendu complet, serveur (messages qui me sont adressés). */
function setLanguage(preference: LangPreference, fromExtension = false): void {
  const next = preference === 'auto' ? autoLang : preference;
  const changed = preference !== langPreference || next !== lang;
  langPreference = preference;
  lang = next;
  setMarkdownLang(lang);
  if (!fromExtension) {
    if (vscodeApi) {
      vscodeApi.postMessage({ type: 'scc-set-lang', preference });
    } else {
      store('local', 'scc.lang', preference);
    }
  }
  if (!changed) {
    return;
  }
  applyStaticI18n();
  renderConnection();
  send({ type: 'setLang', lang });
  if (me || ended) {
    renderAll();
  }
}

document.addEventListener('change', (e) => {
  const target = e.target as HTMLElement;
  if (target instanceof HTMLSelectElement && target.classList.contains('lang-select')) {
    setLanguage(target.value as LangPreference);
  }
});

applyStaticI18n();
renderConnection();

nameInput.maxLength = LIMITS.maxNameLength;
askInput.maxLength = LIMITS.maxQuestionLength;
renameInput.maxLength = LIMITS.maxTitleLength;
nameInput.value = params.get('name') ?? storage('session', 'scc.name') ?? storage('local', 'scc.name') ?? '';

if (vscodeApi) {
  // Dans VS Code : écran d'accueil (héberger / rejoindre), la connexion est tenue par l'extension.
  document.documentElement.classList.add('vscode-theme');
  joinScreen.hidden = true;
  homeScreen.hidden = false;
  window.addEventListener('message', (event) => onExtensionMessage(event.data));
  vscodeApi.postMessage({ type: 'scc-ready' });
} else if (nameInput.value.trim() && (params.has('name') || storage('session', 'scc.name'))) {
  // Reconnexion après rechargement de l'onglet : on rejoint directement.
  join(nameInput.value);
}

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  join(nameInput.value);
});

function join(name: string): void {
  myName = name.trim().slice(0, LIMITS.maxNameLength);
  if (!myName) {
    return;
  }
  store('session', 'scc.name', myName);
  store('local', 'scc.name', myName);
  joinScreen.hidden = true;
  app.hidden = false;
  connect();
  askInput.focus();
}

// ---- Dans VS Code : accueil et état de la session, pilotés par l'extension ----

interface ExtensionState {
  type: 'scc-state';
  mode: 'idle' | 'host' | 'guest';
  name: string;
  /** Message affiché sur l'accueil (erreur, démarrage en cours…). */
  status?: string;
  error?: boolean;
  busy?: boolean;
  /** Identifiant partagé par la vue et les onglets de cette fenêtre : un seul participant. */
  clientId?: string;
  /** Onglet d'éditeur consacré à une discussion. */
  panel?: { conversationId: string };
  /** Langue de l'interface (réglage promptShare.language, sinon langue de VS Code). */
  lang?: Lang;
  langPreference?: LangPreference;
}

function onExtensionMessage(data: unknown): void {
  const msg = data as ExtensionState | null;
  if (msg?.type !== 'scc-state') {
    return;
  }
  homeName.value ||= msg.name;
  homeStatus.hidden = !msg.status;
  homeStatus.textContent = msg.status ?? '';
  homeStatus.classList.toggle('error', !!msg.error);
  homeHost.disabled = !!msg.busy;
  homeJoinForm.querySelector('button')!.disabled = !!msg.busy;
  if (msg.lang) {
    if (msg.langPreference === 'auto' || !msg.langPreference) {
      autoLang = msg.lang;
    }
    setLanguage(msg.langPreference ?? 'auto', true);
    applyStaticI18n();
  }
  if (msg.clientId && /^[A-Za-z0-9_-]{8,64}$/.test(msg.clientId)) {
    clientId = msg.clientId;
  }
  if (msg.panel) {
    panelConversation = msg.panel.conversationId;
    document.documentElement.classList.add('single-conv');
  }
  if (msg.mode === 'idle') {
    return;
  }
  // Session ouverte (hébergée ou rejointe) : on passe au chat, avec une seule connexion
  // (l'extension renvoie l'état à chaque changement ; la reconnexion a sa propre logique).
  sessionMode = msg.mode;
  renderLeaveTitle();
  if (homeScreen.hidden) {
    return;
  }
  myName = msg.name;
  homeScreen.hidden = true;
  app.hidden = false;
  leaveBtn.hidden = !!panelConversation;
  openTabBtn.hidden = !!panelConversation;
  connect();
  askInput.focus();
}

homeHost.addEventListener('click', () => {
  vscodeApi?.postMessage({ type: 'scc-host', name: homeName.value.trim() });
});

homeJoinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  vscodeApi?.postMessage({ type: 'scc-join', name: homeName.value.trim(), link: homeLink.value.trim() });
});

leaveBtn.addEventListener('click', () => vscodeApi?.postMessage({ type: 'scc-leave' }));

openTabBtn.addEventListener('click', () => {
  const conv = conversations.find((c) => c.id === activeId);
  if (conv) {
    vscodeApi?.postMessage({ type: 'scc-open-tab', conversationId: conv.id, title: convTitleText(conv) });
  }
});

/** Onglet d'éditeur : demande à l'extension de le fermer (discussion supprimée, session terminée). */
function closePanel(): void {
  vscodeApi?.postMessage({ type: 'scc-close-panel' });
}

// ---- WebSocket ----

function connect(): void {
  if (ended) {
    return;
  }
  setConnection('connecting', me ? 'connection.reconnecting' : 'connection.connecting');
  const handlers = {
    onOpen: () => {
      reconnectDelay = 1000;
      transport.send(JSON.stringify({ type: 'hello', name: myName, clientId, lang }));
    },
    onMessage: (data: string) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(data) as ServerMessage;
      } catch {
        return;
      }
      handle(msg);
    },
    onClose: (code: number, reason: string) => {
      if (ws !== transport) {
        return;
      }
      ws = undefined;
      if (code === CLOSE_CODES.sessionEnded) {
        endSession(() => t('session.endedByHost'));
        return;
      }
      if (code === CLOSE_CODES.protocolError) {
        endSession(() => (reason ? t('session.refusedReason', { reason }) : t('session.refused')));
        return;
      }
      // Refus à la connexion (lien invalide, session arrêtée) : inutile de réessayer.
      if (code === 4401) {
        endSession(() => reason || t('session.denied'));
        return;
      }
      scheduleReconnect();
    },
  };
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = location.pathname.replace(/[^/]*$/, '');
  const transport: Transport = vscodeApi
    ? openVsCode(vscodeApi, handlers)
    : openWebSocket(`${proto}//${location.host}${base}${WS_PATH}?token=${encodeURIComponent(token)}`, handlers);
  ws = transport;
}

function scheduleReconnect(): void {
  if (ended || reconnectTimer !== undefined) {
    return;
  }
  setConnection('offline', 'connection.retry', { seconds: Math.round(reconnectDelay / 1000) });
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

function send(msg: object): boolean {
  return !!ws && ws.send(JSON.stringify(msg));
}

function endSession(reason: () => string): void {
  ended = true;
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  ws?.close();
  ws = undefined;
  setConnection('offline', 'connection.ended');
  endReason = reason;
  renderBanner();
  if (vscodeApi) {
    leaveBtn.hidden = true;
  }
  queue = { current: null, pending: [] };
  participants = [];
  renderParticipants();
  renderConversations();
  updateComposer();
  updateActivity();
  renderApps();
  renderContext();
  rerenderActive();
}

/** Bandeau de fin de session (raison, et retour à l'accueil dans VS Code). */
function renderBanner(): void {
  if (!endReason) {
    return;
  }
  bannerEl.textContent = t('session.endedBanner', { reason: endReason() });
  if (vscodeApi) {
    const back = document.createElement('button');
    back.className = 'secondary';
    back.type = 'button';
    back.textContent = panelConversation ? t('session.closeTab') : t('session.backHome');
    back.addEventListener('click', () => (panelConversation ? closePanel() : vscodeApi?.postMessage({ type: 'scc-leave', ended: true })));
    bannerEl.append(back);
  }
  bannerEl.hidden = false;
}

function renderLeaveTitle(): void {
  leaveBtn.title = sessionMode === 'host' ? t('session.stop') : t('session.leave');
}

// ---- Messages serveur ----

function handle(msg: ServerMessage): void {
  switch (msg.type) {
    case 'welcome': {
      me = msg.you;
      myName = msg.you.name;
      setConnection('online', 'connection.online');
      conversations = msg.conversations;
      entries.clear();
      for (const entry of msg.history) {
        entries.set(entry.id, entry);
      }
      participants = msg.participants;
      queue = msg.queue;
      models = msg.models;
      policy = msg.policy;
      apps = msg.apps ?? [];
      if (panelConversation) {
        if (!conversations.some((c) => c.id === panelConversation)) {
          closePanel();
          break;
        }
        openConversation(panelConversation, true);
      } else {
        const remembered = activeId ?? storage('session', 'scc.conv');
        const known = conversations.some((c) => c.id === remembered);
        openConversation(known ? remembered! : lastConversationId(), true);
      }
      renderParticipants();
      renderModels();
      updateActivity();
      renderPolicy();
      renderApps();
      inviteBtn.hidden = !me.isHost;
      break;
    }
    case 'conversation': {
      const index = conversations.findIndex((c) => c.id === msg.conversation.id);
      if (index >= 0) {
        conversations[index] = msg.conversation;
      } else {
        conversations.push(msg.conversation);
      }
      // Discussion que je viens de créer, ou remplaçante de la dernière supprimée : on l'ouvre.
      if (index < 0 && !panelConversation && (msg.conversation.createdByClientId === clientId || activeId === null)) {
        openConversation(msg.conversation.id);
      } else {
        renderConversations();
        renderTitle();
        renderContext();
        renderParticipants();
      }
      break;
    }
    case 'conversationDeleted': {
      conversations = conversations.filter((c) => c.id !== msg.conversationId);
      unread.delete(msg.conversationId);
      for (const [id, e] of entries) {
        if (e.conversationId === msg.conversationId) {
          entries.delete(id);
        }
      }
      if (panelConversation === msg.conversationId) {
        closePanel();
        break;
      }
      if (activeId === msg.conversationId) {
        toast(t('toast.convDeleted'));
        activeId = null;
        if (conversations.length) {
          openConversation(lastConversationId());
        }
      } else {
        renderConversations();
      }
      break;
    }
    case 'entry':
      entries.set(msg.entry.id, msg.entry);
      if (msg.entry.kind === 'user' && typing.delete(msg.entry.clientId)) {
        renderPresence();
        renderConversations();
      }
      if (msg.entry.kind === 'user' && msg.entry.review === 'pending') {
        updateActivity();
        if (me?.isHost && msg.entry.conversationId !== activeId) {
          toast(t('toast.reviewElsewhere', { name: msg.entry.author }));
        }
      }
      if (msg.entry.conversationId === activeId) {
        messagesEl.querySelector('.welcome')?.remove();
        withAutoScroll(() => appendEntry(msg.entry));
      } else if (msg.entry.kind !== 'system') {
        unread.set(msg.entry.conversationId, (unread.get(msg.entry.conversationId) ?? 0) + 1);
        renderConversations();
      }
      break;
    case 'chunk': {
      const entry = entries.get(msg.entryId);
      if (entry?.kind === 'assistant') {
        entry.text += msg.text;
        const last = entry.parts[entry.parts.length - 1];
        if (last?.type === 'text') {
          last.text += msg.text;
        } else {
          entry.parts.push({ type: 'text', text: msg.text });
        }
        markDirty(entry.id);
      }
      break;
    }
    case 'tool': {
      const entry = entries.get(msg.entryId);
      if (entry?.kind === 'assistant') {
        const existing = entry.parts.find((p) => p.type === 'tool' && p.tool.id === msg.tool.id);
        if (existing?.type === 'tool') {
          existing.tool = msg.tool;
        } else {
          entry.parts.push({ type: 'tool', tool: msg.tool });
        }
        markDirty(entry.id);
        // Une décision attend ce participant dans une autre discussion : on le signale.
        if (entry.conversationId !== activeId && needsMe(entry, msg.tool)) {
          toast(t('toast.actionElsewhere'));
        }
      }
      break;
    }
    case 'entryUpdate': {
      const entry = entries.get(msg.entryId);
      if (entry?.kind === 'assistant') {
        entry.status = msg.status;
        entry.model = msg.model ?? entry.model;
        entry.error = msg.error;
        entry.errorI18n = msg.errorI18n;
        markDirty(entry.id);
      }
      break;
    }
    case 'questionReview': {
      const entry = entries.get(msg.entryId);
      if (entry?.kind === 'user') {
        entry.review = msg.review;
        entry.reviewedBy = msg.by;
        markDirty(entry.id);
        if (msg.review === 'rejected' && entry.clientId === me?.clientId) {
          toast(t('toast.questionRejected', { name: msg.by }));
        }
      }
      updateActivity();
      break;
    }
    case 'policy':
      policy = msg.policy;
      renderPolicy();
      renderHostOptions();
      break;
    case 'tunnel':
      tunnel = msg.tunnel;
      renderTunnel();
      break;
    case 'sharedApps': {
      const added = msg.apps.filter((a) => !apps.some((b) => b.port === a.port));
      apps = msg.apps;
      renderApps();
      if (!me?.isHost && added.length) {
        toast(t('toast.appShared', { label: added[0].label }));
      }
      break;
    }
    case 'participants':
      participants = msg.participants;
      for (const id of typing.keys()) {
        if (!participants.some((p) => p.clientId === id)) {
          typing.delete(id);
        }
      }
      renderParticipants();
      renderConversations();
      renderPresence();
      break;
    case 'typing':
      if (msg.clientId !== me?.clientId) {
        typing.set(msg.clientId, { name: msg.name, conversationId: msg.conversationId, until: Date.now() + TYPING_TTL_MS });
        renderPresence();
        renderConversations();
        setTimeout(expireTyping, TYPING_TTL_MS + 50);
      }
      break;
    case 'queue':
      queue = msg.queue;
      updateActivity();
      renderConversations();
      renderContext();
      break;
    case 'models':
      models = msg.models;
      renderModels();
      break;
    case 'invite':
      lastInvite = msg;
      renderInvite(msg);
      break;
    case 'error':
      toast(msg.message);
      break;
    case 'sessionEnded':
      // Seul motif aujourd'hui : l'hôte a arrêté la session ; chaque page l'affiche dans sa langue.
      endSession(() => t('session.endedByHost'));
      break;
  }
}

// ---- Discussions ----

function lastConversationId(): string {
  return conversations[conversations.length - 1].id;
}

function openConversation(id: string, force = false): void {
  if (id === activeId && !force) {
    closeDrawers();
    return;
  }
  activeId = id;
  unread.delete(id);
  store('session', 'scc.conv', id);
  send({ type: 'view', conversationId: id });
  cancelRename();
  rerenderActive();
  renderConversations();
  renderTitle();
  renderContext();
  renderParticipants();
  renderPresence();
  updateActivity();
  updateComposer();
  closeDrawers();
  scrollToBottom(true);
}

// ---- Présence en temps réel ----

/** Participants (autres que moi) actuellement dans une discussion. */
function presentIn(conversationId: string): Participant[] {
  return participants.filter((p) => (p.viewingAll ?? [p.viewing]).includes(conversationId) && p.clientId !== me?.clientId);
}

function typingIn(conversationId: string): string[] {
  const now = Date.now();
  return [...typing.values()].filter((t) => t.conversationId === conversationId && t.until > now).map((t) => t.name);
}

function expireTyping(): void {
  const now = Date.now();
  let changed = false;
  for (const [id, t] of typing) {
    if (t.until <= now) {
      typing.delete(id);
      changed = true;
    }
  }
  if (changed) {
    renderPresence();
    renderConversations();
  }
}

/** « Camille », « Camille et Léo », « Camille, Léo et 2 autres ». */
function nameList(names: string[]): string {
  if (names.length < 2) {
    return names.join('');
  }
  if (names.length === 2) {
    return t('names.two', { a: names[0], b: names[1] });
  }
  const n = names.length - 2;
  return t(n > 1 ? 'names.more.other' : 'names.more.one', { a: names[0], b: names[1], n });
}

/** « Camille écrit… », « Camille et Léo écrivent… ». */
function typingText(writers: string[]): string {
  return t(writers.length > 1 ? 'presence.typing.other' : 'presence.typing.one', { names: nameList(writers) });
}

/** Au-dessus de la saisie : qui est dans la discussion, et qui écrit. */
function renderPresence(): void {
  if (!activeId || ended) {
    presenceEl.replaceChildren();
    return;
  }
  const here = presentIn(activeId);
  const writers = typingIn(activeId);
  const stack = document.createElement('span');
  stack.className = 'avatar-stack';
  stack.append(...here.slice(0, 5).map((p) => avatar(p.name)));
  const text = document.createElement('span');
  text.className = 'presence-text';
  if (writers.length) {
    text.classList.add('typing-text');
    text.textContent = typingText(writers);
  } else if (here.length) {
    text.textContent = t(here.length > 1 ? 'presence.here.other' : 'presence.here.one', { names: nameList(here.map((p) => p.name)) });
  } else {
    text.textContent = t('presence.alone');
  }
  presenceEl.replaceChildren(stack, text);
}

askInput.addEventListener('input', () => {
  const now = Date.now();
  if (activeId && askInput.value.trim() && now - lastTypingSent > 2000) {
    lastTypingSent = now;
    send({ type: 'typing', conversationId: activeId });
  }
});

/** Redessine toute la page (changement de langue). */
function renderAll(): void {
  renderLeaveTitle();
  renderBanner();
  if (lastInvite) {
    renderInvite(lastInvite);
  }
  renderConversations();
  renderTitle();
  rerenderActive();
  renderParticipants();
  renderPresence();
  renderModels();
  renderPolicy();
  renderApps();
  renderTunnel();
  renderContext();
  updateActivity();
  updateComposer();
}

function rerenderActive(): void {
  entryEls.clear();
  dirty.clear();
  messagesEl.replaceChildren();
  const list = [...entries.values()].filter((e) => e.conversationId === activeId);
  for (const entry of list) {
    appendEntry(entry);
  }
  if (!list.length && !ended) {
    messagesEl.append(welcome());
  }
}

function renderTitle(): void {
  const conv = conversations.find((c) => c.id === activeId);
  convTitle.textContent = conv ? convTitleText(conv) : '';
  convTitle.title = conv ? t('conv.createdBy', { name: conv.createdBy, time: formatTime(conv.createdAt) }) : '';
  document.title = conv ? `${convTitleText(conv)} — Prompt Share` : 'Prompt Share';
  if (panelConversation && conv) {
    vscodeApi?.postMessage({ type: 'scc-title', title: convTitleText(conv) });
  }
}

function renderConversations(): void {
  const answering = queue.current?.conversationId;
  const waiting = new Set(queue.pending.map((q) => q.conversationId));
  convList.replaceChildren(
    ...[...conversations].reverse().map((conv) => {
      const busy = conv.id === answering || waiting.has(conv.id);
      const li = document.createElement('li');
      li.className = 'conv';
      li.classList.toggle('active', conv.id === activeId);
      li.classList.toggle('busy', busy);
      li.dataset.id = conv.id;
      li.tabIndex = 0;
      li.append(icon(busy ? 'loading codicon-modifier-spin' : 'comment-discussion'));

      const text = document.createElement('div');
      text.className = 'conv-text';
      const title = document.createElement('span');
      title.className = 'conv-name';
      title.textContent = convTitleText(conv);
      const meta = document.createElement('span');
      meta.className = 'conv-meta';
      meta.textContent =
        conv.id === answering
          ? t(queue.current?.kind === 'compact' ? 'conv.compacting' : 'conv.answering')
          : waiting.has(conv.id)
            ? t('conv.waiting')
            : `${conv.createdBy} · ${formatTime(conv.createdAt)}`;
      const writers = typingIn(conv.id);
      if (writers.length && conv.id !== answering) {
        meta.textContent = typingText(writers);
        meta.classList.add('typing-text');
      }
      text.append(title, meta);
      li.append(text);
      // Avatars des participants présents dans cette discussion.
      const here = presentIn(conv.id);
      if (here.length) {
        const stack = document.createElement('span');
        stack.className = 'avatar-stack small';
        stack.title = here.map((p) => p.name).join(', ');
        stack.append(...here.slice(0, 3).map((p) => avatar(p.name)));
        li.append(stack);
      }

      const count = unread.get(conv.id);
      if (count) {
        const badge = document.createElement('span');
        badge.className = 'unread';
        badge.textContent = String(count);
        li.append(badge);
      }
      if (me?.isHost && !ended) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'icon-btn conv-delete';
        del.title = t('conv.delete');
        del.append(icon('trash'));
        li.append(del);
      }
      return li;
    }),
  );
  unreadTotal.hidden = ![...unread.values()].some(Boolean);
  newConvBtn.disabled = ended;
}

convList.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const li = target.closest<HTMLLIElement>('li.conv');
  const id = li?.dataset.id;
  if (!li || !id) {
    return;
  }
  const del = target.closest<HTMLButtonElement>('.conv-delete');
  if (!del) {
    openConversation(id);
    return;
  }
  // Confirmation en deux clics (confirm() n'est pas disponible dans les webviews).
  if (del.dataset.confirm) {
    send({ type: 'deleteConversation', conversationId: id });
    return;
  }
  del.dataset.confirm = '1';
  del.textContent = t('conv.deleteConfirm');
  del.classList.add('confirm');
  setTimeout(() => {
    if (del.isConnected) {
      delete del.dataset.confirm;
      del.replaceChildren(icon('trash'));
      del.classList.remove('confirm');
    }
  }, 3000);
});

convList.addEventListener('keydown', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLLIElement>('li.conv');
  if (li?.dataset.id && (e.key === 'Enter' || e.key === ' ') && e.target === li) {
    e.preventDefault();
    openConversation(li.dataset.id);
  }
});

newConvBtn.addEventListener('click', () => {
  // Une discussion vide existe déjà : on l'ouvre plutôt que d'en créer une autre.
  const empty = [...conversations].reverse().find((c) => ![...entries.values()].some((e) => e.conversationId === c.id));
  if (empty) {
    openConversation(empty.id);
    askInput.focus();
    return;
  }
  if (!send({ type: 'createConversation' })) {
    toast(t('toast.offline'));
  }
  askInput.focus();
});

renameBtn.addEventListener('click', () => {
  const conv = conversations.find((c) => c.id === activeId);
  if (!conv || ended) {
    return;
  }
  renameInput.value = conv.title;
  convTitle.hidden = true;
  renameBtn.hidden = true;
  renameForm.hidden = false;
  renameInput.focus();
  renameInput.select();
});

renameForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = renameInput.value.trim();
  if (title && activeId) {
    send({ type: 'renameConversation', conversationId: activeId, title });
  }
  cancelRename();
});

renameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    cancelRename();
  }
});
renameInput.addEventListener('blur', () => cancelRename());

function cancelRename(): void {
  renameForm.hidden = true;
  convTitle.hidden = false;
  renameBtn.hidden = false;
}

// ---- Rendu des messages ----

function appendEntry(entry: ChatEntry): void {
  const el = document.createElement('article');
  entryEls.set(entry.id, el);
  messagesEl.append(el);
  renderEntry(entry, el);
}

function renderEntry(entry: ChatEntry, el: HTMLElement): void {
  el.className = `turn turn-${entry.kind}`;
  el.replaceChildren();

  switch (entry.kind) {
    case 'user': {
      el.classList.toggle('mine', entry.clientId === me?.clientId);
      el.append(turnHead(avatar(entry.author), entry.author, entry.timestamp, entry.isHost ? t('badge.host') : undefined));
      const request = document.createElement('div');
      request.className = 'request body';
      request.append(renderMarkdown(entry.text));
      el.append(request);
      if (entry.review === 'pending') {
        el.append(reviewBar(entry));
      } else if (entry.review === 'rejected') {
        el.append(note(entry.reviewedBy ? t('review.rejectedBy', { name: entry.reviewedBy }) : t('review.rejectedByHost')));
      }
      break;
    }
    case 'assistant':
      renderAssistant(entry, el);
      break;
    case 'context': {
      const where = entry.range ? `${entry.fileName} — ${entry.range}` : entry.fileName;
      el.append(turnHead(avatar(entry.author), t('context.sharedBy', { name: entry.author }), entry.timestamp));
      el.append(codeBlock(entry.code, entry.languageId, where));
      break;
    }
    case 'summary':
      renderSummary(entry, el);
      break;
    case 'system': {
      el.classList.toggle('error', entry.level === 'error');
      el.textContent = tr(entry.i18n, entry.text);
      break;
    }
  }
}

/** Question d'invité en attente : l'hôte l'envoie au modèle ou la refuse, les autres patientent. */
function reviewBar(entry: UserEntry): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'review-bar';
  if (me?.isHost && !ended) {
    bar.classList.add('attention');
    const label = document.createElement('span');
    label.className = 'waiting';
    label.textContent = t('review.prompt', { name: entry.author });
    const decide = (accept: boolean) => () => send({ type: 'reviewQuestion', entryId: entry.id, accept });
    bar.append(icon('shield'), label, button(t('review.send'), 'primary', decide(true)), button(t('review.deny'), 'secondary', decide(false)));
  } else {
    const waiting = document.createElement('span');
    waiting.className = 'waiting';
    waiting.textContent = ended ? t('review.notSent') : t('review.waiting');
    bar.append(icon(ended ? 'circle-slash' : 'loading codicon-modifier-spin'), waiting);
  }
  return bar;
}

/** Discussion compactée : le résumé remplace, pour le modèle, les échanges précédents. */
function renderSummary(entry: SummaryEntry, el: HTMLElement): void {
  const head = turnHead(assistantAvatar(), t('summary.by', { name: entry.author }), entry.timestamp);
  if (entry.model) {
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = entry.model;
    head.append(meta);
  }
  const card = document.createElement('details');
  card.className = 'summary-card';
  const label = document.createElement('summary');
  label.textContent = t('summary.label');
  const body = document.createElement('div');
  body.className = 'body';
  body.append(renderMarkdown(entry.text));
  card.append(label, body);
  el.append(head, card);
}

function renderAssistant(entry: AssistantEntry, el: HTMLElement): void {
  const head = turnHead(assistantAvatar(), t('assistant.name'), entry.timestamp);
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = entry.model
    ? t('assistant.modelFor', { model: entry.model, name: entry.replyToAuthor })
    : t('assistant.for', { name: entry.replyToAuthor });
  head.append(meta);
  if (entry.status !== 'streaming' && !ended) {
    const fork = document.createElement('button');
    fork.type = 'button';
    fork.className = 'icon-btn fork-btn';
    fork.title = t('assistant.fork');
    fork.setAttribute('aria-label', fork.title);
    fork.append(icon('repo-forked'));
    fork.addEventListener('click', () => send({ type: 'fork', conversationId: entry.conversationId, upToEntryId: entry.id }));
    head.append(fork);
  }
  el.append(head);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'response';
  for (const part of entry.parts) {
    if (part.type === 'text') {
      const div = document.createElement('div');
      div.className = 'body';
      div.append(renderMarkdown(part.text));
      bodyEl.append(div);
    } else {
      bodyEl.append(renderTool(entry, part.tool));
    }
  }
  const last = entry.parts[entry.parts.length - 1];
  if (entry.status === 'streaming' && (!last || (last.type === 'tool' && (last.tool.status === 'done' || last.tool.status === 'running')))) {
    const typing = document.createElement('div');
    typing.className = 'typing';
    typing.innerHTML = '<span></span><span></span><span></span>';
    bodyEl.append(typing);
  }
  if (entry.status === 'cancelled') {
    bodyEl.append(note(t('assistant.cancelled')));
  } else if (entry.status === 'error') {
    bodyEl.append(note(tr(entry.errorI18n, entry.error ?? t('assistant.unknownError')), true));
  }
  el.append(bodyEl);
}

const TOOL_ICONS: Record<ToolActivity['status'], string> = {
  running: 'loading codicon-modifier-spin',
  awaitingApproval: 'shield',
  awaitingAnswer: 'question',
  done: 'check',
  rejected: 'circle-slash',
  error: 'warning',
};

function renderTool(entry: AssistantEntry, tool: ToolActivity): HTMLElement {
  if (tool.status === 'awaitingApproval' && tool.approval && entry.status === 'streaming') {
    return approvalCard(entry, tool);
  }
  if (tool.status === 'awaitingAnswer' && tool.question && entry.status === 'streaming') {
    return questionCard(entry, tool);
  }
  const row = document.createElement('div');
  row.className = `tool tool-${tool.status}`;
  row.append(icon(TOOL_ICONS[tool.status]));
  const text = document.createElement('span');
  text.className = 'tool-text';
  const title = document.createElement('span');
  title.className = 'tool-title';
  title.textContent = tool.question ? tool.question.text : tr(tool.titleI18n, tool.title);
  text.append(title);
  if (tool.answer) {
    const answer = document.createElement('span');
    answer.className = 'tool-detail answered';
    answer.textContent = tool.answeredBy
      ? t('tool.answerBy', { answer: tool.answer, name: tool.answeredBy })
      : t('tool.answer', { answer: tool.answer });
    text.append(answer);
  }
  if (tool.detail) {
    const detail = document.createElement('span');
    detail.className = 'tool-detail';
    detail.textContent = tr(tool.detailI18n, tool.detail);
    text.append(detail);
  }
  row.append(text);
  return row;
}

/** Participant qui a posé la question à laquelle répond cette entrée. */
function requesterOf(entry: AssistantEntry): string | undefined {
  const question = entries.get(entry.replyTo);
  return question?.kind === 'user' ? question.clientId : undefined;
}

/** true si ce participant doit prendre une décision sur cette action. */
function needsMe(entry: AssistantEntry, tool: ToolActivity): boolean {
  if (tool.status === 'awaitingApproval' && tool.approval) {
    return !!me && (me.isHost || (!tool.approval.hostOnly && requesterOf(entry) === me.clientId));
  }
  if (tool.status === 'awaitingAnswer' && tool.question) {
    return !!me; // Tout participant peut répondre.
  }
  return false;
}

function approvalCard(entry: AssistantEntry, tool: ToolActivity): HTMLElement {
  const approval = tool.approval!;
  const card = document.createElement('div');
  card.className = 'card';
  const canDecide = needsMe(entry, tool) && !ended;
  card.classList.toggle('attention', canDecide);

  const head = document.createElement('div');
  head.className = 'card-head';
  head.append(icon(approval.kind === 'command' ? 'terminal' : 'diff'));
  const title = document.createElement('span');
  title.textContent = t('approval.title', { title: tr(tool.titleI18n, tool.title) });
  head.append(title);
  if (approval.hostOnly) {
    const scope = document.createElement('span');
    scope.className = 'scope';
    scope.append(icon('warning'), document.createTextNode(t('approval.outside')));
    head.append(scope);
  }
  card.append(head);

  const body = document.createElement('div');
  body.className = 'card-body';
  body.append(diffView(approval.preview));
  card.append(body);

  const foot = document.createElement('div');
  foot.className = 'card-foot';
  if (canDecide) {
    const decide = (decision: 'once' | 'session' | 'deny') => () =>
      send({ type: 'approve', entryId: entry.id, toolId: tool.id, decision });
    foot.append(button(t('approval.allow'), 'primary', decide('once')));
    if (me?.isHost && !approval.hostOnly) {
      foot.append(button(t('approval.allowSession'), 'secondary', decide('session')));
    }
    foot.append(button(t('approval.deny'), 'secondary', decide('deny')));
    if (me?.isHost && approval.canShowDiff) {
      foot.append(button(t('approval.showDiff'), 'link-btn', () => send({ type: 'showDiff', entryId: entry.id, toolId: tool.id })));
    }
  } else {
    const waiting = document.createElement('span');
    waiting.className = 'waiting';
    const requester = entries.get(entry.replyTo);
    waiting.textContent =
      approval.hostOnly || requester?.kind !== 'user'
        ? t('approval.waitingHost')
        : t('approval.waitingUser', { name: requester.author });
    foot.append(icon('loading codicon-modifier-spin'), waiting);
  }
  card.append(foot);
  return card;
}

function questionCard(entry: AssistantEntry, tool: ToolActivity): HTMLElement {
  const question = tool.question!;
  const card = document.createElement('div');
  card.className = 'card';
  const canAnswer = needsMe(entry, tool) && !ended;
  card.classList.toggle('attention', canAnswer);

  const head = document.createElement('div');
  head.className = 'card-head';
  head.append(icon('question'));
  const title = document.createElement('span');
  title.textContent = question.text;
  const scope = document.createElement('span');
  scope.className = 'scope everyone';
  scope.append(icon('organization'), document.createTextNode(t('question.everyone')));
  head.append(title, scope);
  card.append(head);

  const foot = document.createElement('div');
  foot.className = 'card-foot';
  const reply = (text: string) => {
    if (text.trim()) {
      send({ type: 'answer', entryId: entry.id, toolId: tool.id, text });
    }
  };
  if (canAnswer) {
    for (const option of question.options) {
      foot.append(button(option, 'secondary', () => reply(option)));
    }
    const row = document.createElement('form');
    row.className = 'answer-row';
    const input = document.createElement('input');
    input.placeholder = question.options.length ? t('question.freePlaceholder') : t('question.placeholder');
    input.maxLength = LIMITS.maxAnswerLength;
    row.append(input, button(t('question.reply'), 'primary', () => undefined, 'submit'));
    row.addEventListener('submit', (e) => {
      e.preventDefault();
      reply(input.value);
    });
    foot.append(row);
  } else {
    const waiting = document.createElement('span');
    waiting.className = 'waiting';
    waiting.textContent = t('question.waiting');
    foot.append(icon('loading codicon-modifier-spin'), waiting);
  }
  card.append(foot);
  return card;
}

function diffView(preview: string): HTMLElement {
  const pre = document.createElement('div');
  pre.className = 'diff';
  for (const line of preview.split('\n')) {
    const div = document.createElement('div');
    div.textContent = line;
    div.className = line.startsWith('+ ') ? 'add' : line.startsWith('- ') ? 'del' : line.startsWith('@@') || line.startsWith('#') ? 'hunk' : '';
    pre.append(div);
  }
  return pre;
}

function turnHead(avatarEl: HTMLElement, name: string, timestamp: number, badge?: string): HTMLElement {
  const h = document.createElement('header');
  h.className = 'turn-head';
  const who = document.createElement('strong');
  who.textContent = name;
  h.append(avatarEl, who);
  if (badge) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = badge;
    h.append(b);
  }
  const time = document.createElement('time');
  time.dateTime = new Date(timestamp).toISOString();
  time.textContent = formatTime(timestamp);
  h.append(time);
  return h;
}

function avatar(name: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'avatar';
  span.textContent = name.trim().charAt(0) || '?';
  let hash = 0;
  for (const ch of name) {
    hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  }
  span.style.background = `hsl(${Math.abs(hash) % 360} 55% 42%)`;
  span.title = name;
  return span;
}

function assistantAvatar(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'avatar copilot';
  span.append(icon('sparkle'));
  return span;
}

function icon(name: string): HTMLElement {
  const i = document.createElement('i');
  i.className = `codicon codicon-${name}`;
  i.setAttribute('aria-hidden', 'true');
  return i;
}

function button(label: string, className: string, onClick: () => void, type: 'button' | 'submit' = 'button'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = type;
  b.className = className;
  b.textContent = label;
  if (type === 'button') {
    b.addEventListener('click', onClick);
  }
  return b;
}

function note(text: string, isError = false): HTMLElement {
  const p = document.createElement('p');
  p.className = isError ? 'note error' : 'note';
  p.textContent = text;
  return p;
}

function welcome(): HTMLElement {
  const div = document.createElement('div');
  div.className = 'welcome';
  const title = document.createElement('h2');
  title.textContent = t('welcome.title');
  const text = document.createElement('p');
  text.textContent = t('welcome.text');
  const suggestions = document.createElement('div');
  suggestions.className = 'suggestions';
  for (const key of SUGGESTIONS) {
    const s = t(key);
    suggestions.append(
      button(s, '', () => {
        askInput.value = s;
        submitQuestion();
      }),
    );
  }
  div.append(icon('sparkle'), title, text, suggestions);
  return div;
}

/** Regroupe les re-rendus du streaming sur une frame d'affichage. */
function markDirty(id: string): void {
  if (!entryEls.has(id)) {
    return; // Discussion non affichée : les données sont à jour, rien à redessiner.
  }
  dirty.add(id);
  if (!frameRequested) {
    frameRequested = true;
    requestAnimationFrame(() => {
      frameRequested = false;
      withAutoScroll(() => {
        for (const entryId of dirty) {
          const entry = entries.get(entryId);
          const el = entryEls.get(entryId);
          if (entry && el) {
            renderEntry(entry, el);
          }
        }
        dirty.clear();
      });
    });
  }
}

/**
 * Suivi du bas de la conversation, comme dans Copilot : on reste collé en bas tant
 * que l'utilisateur ne remonte pas lui-même. Le défilement est instantané : une
 * animation laisserait des positions intermédiaires qui feraient croire à une remontée.
 */
let stickToBottom = true;

messagesEl.addEventListener('scroll', () => {
  const distance = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  stickToBottom = distance < 40;
  if (stickToBottom) {
    jumpBtn.hidden = true;
  }
});

function withAutoScroll(fn: () => void): void {
  fn();
  if (stickToBottom) {
    scrollToBottom();
  } else {
    jumpBtn.hidden = false;
  }
}

function scrollToBottom(_instant = true): void {
  stickToBottom = true;
  jumpBtn.hidden = true;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

jumpBtn.addEventListener('click', () => scrollToBottom());

// ---- Participants, modèles, file d'attente, saisie ----

function renderParticipants(): void {
  peopleCount.textContent = String(participants.length);
  avatarStack.replaceChildren(...participants.slice(0, 4).map((p) => avatar(p.name)));
  peopleList.replaceChildren(
    ...participants.map((p) => {
      const li = document.createElement('li');
      li.className = 'person';
      const text = document.createElement('div');
      text.className = 'person-text';
      const name = document.createElement('span');
      name.className = 'person-name';
      name.textContent = p.name;
      if (p.isHost) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = t('badge.host');
        name.append(b);
      }
      if (p.clientId === me?.clientId) {
        const you = document.createElement('span');
        you.className = 'you';
        you.textContent = t('people.you');
        name.append(you);
      }
      text.append(name);
      const where = conversations.find((c) => c.id === p.viewing);
      if (where) {
        const here = where.id === activeId;
        const w = document.createElement(here ? 'span' : 'button');
        w.className = 'person-where';
        w.textContent = here ? t('people.here') : t('people.in', { title: convTitleText(where) });
        if (!here) {
          w.addEventListener('click', () => {
            openConversation(where.id);
            togglePeople(false);
          });
        }
        text.append(w);
      }
      li.append(avatar(p.name), text);
      return li;
    }),
  );
}

// ---- Invitation (hôte) ----

function toggleInvite(open = invitePop.hidden): void {
  invitePop.hidden = !open;
  inviteBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    togglePeople(false);
    toggleApps(false);
    send({ type: 'invite', copy: false }); // Préremplit l'URL publique déjà connue.
    inviteUrl.focus();
  }
}

inviteBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleInvite();
});

inviteForm.addEventListener('submit', (e) => {
  e.preventDefault();
  send({ type: 'invite', publicUrl: inviteUrl.value.trim(), copy: true });
});

// ---- Tunnel public (hôte) ----

const tunnelRadios = () => [...document.querySelectorAll<HTMLInputElement>('input[name="tunnel-provider"]')];

/** Choix du service, ouverture en cours, tunnel actif (adresse, depuis quand, arrêt) ou erreur. */
function renderTunnel(): void {
  const state = tunnel ?? { status: 'off', provider: 'cloudflare' };
  const on = state.status === 'on';
  const starting = state.status === 'starting';
  tunnelChoose.hidden = on;
  tunnelOn.hidden = !on;
  // Avec un tunnel ouvert, l'adresse manuelle est inutile.
  inviteHint.hidden = on;
  inviteForm.hidden = on;
  if (!starting) {
    for (const radio of tunnelRadios()) {
      radio.checked = radio.value === state.provider;
    }
  }
  for (const radio of tunnelRadios()) {
    radio.disabled = starting;
  }
  tunnelBtn.disabled = starting;
  tunnelBtn.lastElementChild!.textContent = starting ? t('tunnel.opening') : t('tunnel.open');
  const provider = TUNNEL_LABELS[state.provider];
  if (on) {
    tunnelTitle.textContent = t('tunnel.active', { provider });
    tunnelSince.textContent = state.since ? t('tunnel.since', { time: formatTime(state.since) }) : '';
    tunnelUrl.textContent = state.url ?? '';
    resetTunnelStop();
  }
  tunnelStatus.classList.toggle('error', state.status === 'error');
  tunnelStatus.hidden = !starting && state.status !== 'error';
  tunnelStatus.textContent = starting
    ? t('tunnel.starting', { provider })
    : state.status === 'error'
      ? t('tunnel.error', { provider, error: state.error ?? t('tunnel.errorUnknown') })
      : '';
}

tunnelBtn.addEventListener('click', () => {
  const provider = (tunnelRadios().find((r) => r.checked)?.value ?? 'cloudflare') as TunnelProviderId;
  send({ type: 'startTunnel', provider });
});

tunnelCopy.addEventListener('click', () => send({ type: 'invite', copy: true }));

/** Arrêt en deux clics : il déconnecte les invités à distance. */
let stopArmed: number | undefined;
function resetTunnelStop(): void {
  clearTimeout(stopArmed);
  stopArmed = undefined;
  tunnelStop.classList.remove('confirm');
  tunnelStop.lastChild!.textContent = t('tunnel.stop');
  tunnelStop.title = t('tunnel.stopTitle');
}
tunnelStop.addEventListener('click', () => {
  if (stopArmed === undefined) {
    tunnelStop.classList.add('confirm');
    tunnelStop.lastChild!.textContent = t('tunnel.stopConfirm');
    stopArmed = window.setTimeout(resetTunnelStop, 4000);
    return;
  }
  resetTunnelStop();
  send({ type: 'stopTunnel' });
});

function renderInvite(msg: Extract<ServerMessage, { type: 'invite' }>): void {
  const port = /:(\d+)/.exec(msg.localUrl)?.[1] ?? '3717';
  // Texte traduit dont les paramètres {port} et {command} deviennent des éléments <code>.
  const code: Record<string, string> = { port, command: `ngrok http ${port}` };
  inviteHint.replaceChildren(
    ...webT(lang, 'invite.hint')
      .split(/(\{\w+\})/)
      .filter(Boolean)
      .map((part) => {
        const name = /^\{(\w+)\}$/.exec(part)?.[1];
        return name && name in code
          ? Object.assign(document.createElement('code'), { textContent: code[name] })
          : document.createTextNode(part);
      }),
  );
  inviteHint.after(Object.assign(inviteWarn, { textContent: t('invite.warn') }));
  if (!inviteUrl.value && msg.publicUrl) {
    inviteUrl.value = msg.publicUrl;
  }
  inviteResult.replaceChildren();
  if (msg.error) {
    inviteResult.append(Object.assign(document.createElement('span'), { className: 'error', textContent: msg.error }));
  } else if (msg.link && (msg.copied || msg.publicUrl)) {
    const field = Object.assign(document.createElement('input'), { value: msg.link, readOnly: true });
    field.addEventListener('focus', () => field.select());
    inviteResult.append(field);
    if (msg.copied) {
      inviteResult.append(
        Object.assign(document.createElement('span'), {
          className: msg.publicUrl ? 'ok' : 'warn',
          textContent: msg.publicUrl ? t('invite.copied') : t('invite.copiedLocal'),
        }),
      );
    }
  }
  inviteResult.hidden = inviteResult.childElementCount === 0;
}

document.addEventListener('click', (e) => {
  if (!invitePop.hidden && !invitePop.contains(e.target as Node) && e.target !== inviteBtn) {
    toggleInvite(false);
  }
});

function togglePeople(open = peoplePopover.hidden): void {
  if (open) {
    toggleInvite(false);
    toggleApps(false);
  }
  peoplePopover.hidden = !open;
  peopleToggle.setAttribute('aria-expanded', String(open));
}

peopleToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  togglePeople();
});
document.addEventListener('click', (e) => {
  if (!peoplePopover.hidden && !peoplePopover.contains(e.target as Node)) {
    togglePeople(false);
  }
});

function renderModels(): void {
  const defaultModel = models.available.find((m) => m.id === models.defaultId);
  const canChoose = !!me?.isHost || models.guestsCanChoose;
  if (chosenModel && !models.available.some((m) => m.id === chosenModel)) {
    chosenModel = '';
  }

  const options: HTMLOptionElement[] = [];
  if (!models.available.length) {
    options.push(new Option(t('model.none'), ''));
  } else {
    options.push(new Option(defaultModel ? t('model.defaultNamed', { name: defaultModel.name }) : t('model.default'), ''));
    if (canChoose) {
      for (const m of models.available) {
        if (m.id !== models.defaultId) {
          options.push(new Option(m.name, m.id));
        }
      }
    }
  }
  modelSelect.replaceChildren(...options);
  modelSelect.value = canChoose ? chosenModel : '';
  lockReason = ended
    ? ''
    : !models.available.length
      ? 'model.lockNone'
      : !canChoose
        ? 'model.lockHost'
        : models.available.length < 2
          ? 'model.lockSingle'
          : '';
  modelSelect.disabled = ended || !!lockReason;
  const picker = modelSelect.parentElement!;
  picker.classList.toggle('locked', !!lockReason);
  picker.title = t(lockReason || 'model.title');
  modelChevron.className = `codicon codicon-${lockReason ? 'lock' : 'chevron-down'}`;
  renderHostOptions();
}


modelSelect.parentElement!.addEventListener('click', () => {
  if (lockReason) {
    toast(t(lockReason === 'model.lockHost' && !me?.isHost ? 'model.lockHostAsk' : lockReason));
  }
});

/** Réglages de la session modifiables par l'hôte depuis le chat (fenêtre Participants). */
function renderHostOptions(): void {
  hostOptions.hidden = !me?.isHost || ended;
  optModelChoice.checked = models.guestsCanChoose;
  optReview.checked = policy.reviewGuestQuestions;
}

optModelChoice.addEventListener('change', () => send({ type: 'setSessionOption', option: 'guestModelChoice', value: optModelChoice.checked }));
optReview.addEventListener('change', () => send({ type: 'setSessionOption', option: 'reviewGuestQuestions', value: optReview.checked }));

modelSelect.addEventListener('change', () => {
  chosenModel = modelSelect.value;
  store('local', 'scc.model', chosenModel);
});

function updateActivity(): void {
  const parts: string[] = [];
  const current = queue.current;
  if (current) {
    const mine = current.clientId === me?.clientId;
    const conv = conversations.find((c) => c.id === current.conversationId);
    const title = current.conversationId === activeId || !conv ? undefined : convTitleText(conv);
    const key: WebKey =
      current.kind === 'compact'
        ? title ? 'activity.compactingIn' : 'activity.compacting'
        : mine
          ? title ? 'activity.answeringYouIn' : 'activity.answeringYou'
          : title ? 'activity.answeringIn' : 'activity.answering';
    parts.push(t(key, { name: current.author, title: title ?? '' }));
  }
  const mine = queue.pending.findIndex((q) => q.clientId === me?.clientId);
  if (mine >= 0) {
    parts.push(t('activity.position', { n: mine + 1 }));
  } else if (queue.pending.length) {
    parts.push(t('activity.pending', { n: queue.pending.length }));
  }
  const awaiting = [...entries.values()].filter((e): e is UserEntry => e.kind === 'user' && e.review === 'pending');
  if (me?.isHost && awaiting.length) {
    parts.push(t('activity.awaitingHost', { n: awaiting.length }));
  } else if (awaiting.some((e) => e.clientId === me?.clientId)) {
    parts.push(t('activity.awaitingMine'));
  }
  activityText.textContent = parts.join(' · ');
  activityEl.hidden = parts.length === 0;
  cancelBtn.hidden = !(me?.isHost && current);
}

// ---- Applications partagées par l'hôte ----

/**
 * Liste des applications locales de l'hôte. Dans VS Code, « Ouvrir » les rend accessibles
 * sur localhost (relais par l'extension) ; un navigateur ne peut pas ouvrir de port local.
 */
function renderApps(): void {
  const isHost = !!me?.isHost;
  appsWrap.hidden = !(isHost || apps.length) || ended;
  appsCount.hidden = !apps.length;
  appsCount.textContent = String(apps.length);
  appsForm.hidden = !isHost;
  appsHint.textContent = isHost
    ? t('apps.hintHost')
    : vscodeApi
      ? t('apps.hintVsCode')
      : t('apps.hintBrowser');
  appsList.replaceChildren(
    ...apps.map((app) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'app-name';
      name.textContent = app.label;
      const port = document.createElement('span');
      port.className = 'app-port';
      port.textContent = `localhost:${app.port}`;
      name.append(port);
      const open = button(t('apps.open'), 'secondary', () => vscodeApi?.postMessage({ type: 'scc-open-app', port: app.port }));
      open.disabled = !vscodeApi;
      li.append(icon('browser'), name, open);
      if (isHost) {
        li.append(button(t('apps.stop'), 'secondary', () => send({ type: 'unshareApp', port: app.port })));
      }
      return li;
    }),
  );
  if (!apps.length && !isHost) {
    toggleApps(false);
  }
}

function toggleApps(open = appsPop.hidden): void {
  if (open) {
    toggleInvite(false);
    togglePeople(false);
  }
  appsPop.hidden = !open;
  appsBtn.setAttribute('aria-expanded', String(open));
}

appsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleApps();
});

document.addEventListener('click', (e) => {
  if (!appsPop.hidden && !appsPop.contains(e.target as Node)) {
    toggleApps(false);
  }
});

appsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const port = Number(appsPort.value.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    toast(t('toast.invalidPort'));
    return;
  }
  if (send({ type: 'shareApp', port, label: appsLabel.value.trim() || undefined })) {
    appsPort.value = '';
    appsLabel.value = '';
  }
});

/** Rappel permanent sous la saisie : quel compte répond, qui voit quoi, règles de l'hôte. */
function renderPolicy(): void {
  const rules = [
    policy.reviewGuestQuestions ? t('policy.review') : undefined,
    policy.guestQuestionsPerHour > 0 ? t('policy.rate', { n: policy.guestQuestionsPerHour }) : undefined,
  ].filter(Boolean);
  const text = me?.isHost ? t('policy.host') : t('policy.guest');
  policyNote.textContent = rules.length ? t('policy.withRules', { text, rules: rules.join(', ') }) : text;
  policyNote.hidden = !me;
}

// ---- Contexte de la discussion (jauge) et compactage ----

const RING = 2 * Math.PI * 6;

function formatTokens(n: number): string {
  return n >= 1000
    ? t('context.kilo', { n: (n / 1000).toLocaleString(locale(), { maximumFractionDigits: n >= 100_000 ? 0 : 1 }) })
    : n.toLocaleString(locale());
}

/** Jauge de la discussion affichée : tokens envoyés au modèle à la prochaine question / maximum du modèle. */
function renderContext(): void {
  const conv = conversations.find((c) => c.id === activeId);
  const usage = conv?.context;
  contextBtn.hidden = !usage || ended;
  if (!usage) {
    toggleContext(false);
    return;
  }
  const ratio = Math.min(1, usage.tokens / usage.max);
  const pct = Math.round(ratio * 100);
  const level = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : '';
  contextBtn.className = `context-gauge ${level}`;
  contextRing.setAttribute('stroke-dasharray', `${Math.max(0.5, ratio * RING)} ${RING}`);
  contextPct.textContent = t('context.pct', { pct });
  const used = formatTokens(usage.tokens);
  const max = formatTokens(usage.max);
  contextBtn.title = t('context.gauge', { used, max, pct });
  contextFill.parentElement!.className = `context-bar ${level}`;
  contextFill.style.width = `${Math.max(1, pct)}%`;
  contextDetail.textContent = t('context.detail', { used, max, pct, model: usage.model });
  contextWarn.hidden = pct < 75;
  const compacting = [queue.current, ...queue.pending].some((q) => q?.kind === 'compact' && q.conversationId === conv!.id);
  compactBtn.hidden = !me?.isHost;
  compactBtn.disabled = compacting;
  compactBtn.lastElementChild!.textContent = compacting ? t('context.compacting') : t('context.compact');
  compactHint.textContent = me?.isHost ? t('context.hintHost') : t('context.hintGuest');
}

function toggleContext(open = contextPop.hidden): void {
  contextPop.hidden = !open;
  contextBtn.setAttribute('aria-expanded', String(open));
}

contextBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleContext();
});

document.addEventListener('click', (e) => {
  if (!contextPop.hidden && !contextPop.contains(e.target as Node)) {
    toggleContext(false);
  }
});

compactBtn.addEventListener('click', () => {
  if (activeId) {
    send({ type: 'compact', conversationId: activeId });
  }
});

function updateComposer(): void {
  const online = !!ws && ws.isOpen && !!me && !ended && !!activeId;
  askInput.disabled = ended;
  askSend.disabled = !online;
  renameBtn.disabled = ended || !activeId;
  if (ended) {
    modelSelect.disabled = true;
  }
}

askForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitQuestion();
});

askInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitQuestion();
  }
});

function submitQuestion(): void {
  const text = askInput.value.trim();
  if (!text || !activeId) {
    return;
  }
  const canChoose = !!me?.isHost || models.guestsCanChoose;
  const msg = { type: 'ask', conversationId: activeId, text, modelId: (canChoose && chosenModel) || undefined };
  if (!send(msg)) {
    toast(t('toast.offlineQuestion'));
    return;
  }
  askInput.value = '';
  scrollToBottom();
}

cancelBtn.addEventListener('click', () => {
  send({ type: 'cancel' });
});

// ---- Tiroir des discussions (écrans étroits) ----

function closeDrawers(): void {
  convsEl.classList.remove('open');
  convsToggle.setAttribute('aria-expanded', 'false');
}

convsToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = !convsEl.classList.contains('open');
  convsEl.classList.toggle('open', open);
  convsToggle.setAttribute('aria-expanded', String(open));
});
messagesEl.addEventListener('pointerdown', () => closeDrawers());

// Boutons « copier » des blocs de code (délégation, car le contenu est re-rendu pendant le streaming).
messagesEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.copy');
  const code = btn?.closest('.codeblock')?.querySelector('code')?.textContent;
  if (!btn || code == null) {
    return;
  }
  const label = btn.querySelector('span');
  void copyText(code).then((ok) => {
    if (label) {
      label.textContent = ok ? t('code.copied') : t('code.copyFailed');
      setTimeout(() => (label.textContent = t('code.copy')), 1500);
    }
  });
});

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Contexte non sécurisé ou iframe sans permission : repli sur execCommand.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

// ---- Divers ----

function setConnection(state: 'connecting' | 'online' | 'offline', key: WebKey, params?: Params): void {
  connectionEl.dataset.state = state;
  connectionLabel = { key, params };
  renderConnection();
  updateComposer();
}

function renderConnection(): void {
  connectionEl.title = t(connectionLabel.key, connectionLabel.params);
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
}

let toastTimer: number | undefined;
function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 4000);
}

function loadClientId(): string {
  const existing = storage('session', 'scc.clientId');
  if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) {
    return existing;
  }
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  store('session', 'scc.clientId', id);
  return id;
}

type StorageArea = 'local' | 'session';

function storage(area: StorageArea, key: string): string | null {
  try {
    return (area === 'local' ? localStorage : sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

function store(area: StorageArea, key: string, value: string): void {
  try {
    (area === 'local' ? localStorage : sessionStorage).setItem(key, value);
  } catch {
    // Stockage indisponible (navigation privée, iframe) : on garde l'état en mémoire.
  }
}
