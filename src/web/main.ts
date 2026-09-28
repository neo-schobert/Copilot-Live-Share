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
  ToolActivity,
  WS_PATH,
} from '../protocol';
import { codeBlock, renderMarkdown } from './markdown';
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

// ---- État ----

const params = new URLSearchParams(location.search);
const token = params.get('token') ?? '';
const clientId = loadClientId();

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
let queue: QueueState = { current: null, pending: [] };
let models: ModelsState = { available: [], defaultId: null, guestsCanChoose: true };
/** Modèle choisi par ce participant ; '' = modèle par défaut de la session. */
let chosenModel = storage('local', 'scc.model') ?? '';
/** Participants en train d'écrire : clientId -> discussion et échéance de l'indicateur. */
const typing = new Map<string, { name: string; conversationId: string; until: number }>();
const TYPING_TTL_MS = 4000;
let lastTypingSent = 0;
/** Entrées dont le rendu doit être rafraîchi à la prochaine frame (streaming). */
const dirty = new Set<string>();
let frameRequested = false;

const SUGGESTIONS = [
  'Explique la structure de ce projet',
  'Trouve les TODO et résume-les',
  'Y a-t-il des erreurs à corriger ?',
];

// ---- Démarrage ----

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
  if (msg.mode === 'idle') {
    return;
  }
  // Session ouverte (hébergée ou rejointe) : on passe au chat, avec une seule connexion
  // (l'extension renvoie l'état à chaque changement ; la reconnexion a sa propre logique).
  leaveBtn.title = msg.mode === 'host' ? 'Arrêter la session' : 'Quitter la session';
  if (homeScreen.hidden) {
    return;
  }
  myName = msg.name;
  homeScreen.hidden = true;
  app.hidden = false;
  leaveBtn.hidden = false;
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

// ---- WebSocket ----

function connect(): void {
  if (ended) {
    return;
  }
  setConnection('connecting', me ? 'Reconnexion…' : 'Connexion…');
  const handlers = {
    onOpen: () => {
      reconnectDelay = 1000;
      transport.send(JSON.stringify({ type: 'hello', name: myName, clientId }));
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
        endSession("L'hôte a arrêté la session.");
        return;
      }
      if (code === CLOSE_CODES.protocolError) {
        endSession(`Connexion refusée par le serveur${reason ? ` : ${reason}` : ''}.`);
        return;
      }
      // Refus à la connexion (lien invalide, session arrêtée) : inutile de réessayer.
      if (code === 4401) {
        endSession(reason || 'Accès refusé : lien invalide ou session terminée.');
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
  setConnection('offline', `Déconnecté — nouvelle tentative dans ${Math.round(reconnectDelay / 1000)} s`);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

function send(msg: object): boolean {
  return !!ws && ws.send(JSON.stringify(msg));
}

function endSession(reason: string): void {
  ended = true;
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  ws?.close();
  ws = undefined;
  setConnection('offline', 'Session terminée');
  bannerEl.textContent = `${reason} L'historique affiché n'est conservé nulle part : copiez ce dont vous avez besoin.`;
  if (vscodeApi) {
    const back = document.createElement('button');
    back.className = 'secondary';
    back.type = 'button';
    back.textContent = 'Retour à l’accueil';
    back.addEventListener('click', () => vscodeApi?.postMessage({ type: 'scc-leave', ended: true }));
    bannerEl.append(back);
    leaveBtn.hidden = true;
  }
  bannerEl.hidden = false;
  queue = { current: null, pending: [] };
  participants = [];
  renderParticipants();
  renderConversations();
  updateComposer();
  updateActivity();
  rerenderActive();
}

// ---- Messages serveur ----

function handle(msg: ServerMessage): void {
  switch (msg.type) {
    case 'welcome': {
      me = msg.you;
      myName = msg.you.name;
      setConnection('online', 'Connecté');
      conversations = msg.conversations;
      entries.clear();
      for (const entry of msg.history) {
        entries.set(entry.id, entry);
      }
      participants = msg.participants;
      queue = msg.queue;
      models = msg.models;
      const remembered = activeId ?? storage('session', 'scc.conv');
      const known = conversations.some((c) => c.id === remembered);
      openConversation(known ? remembered! : lastConversationId(), true);
      renderParticipants();
      renderModels();
      updateActivity();
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
      if (index < 0 && (msg.conversation.createdByClientId === clientId || activeId === null)) {
        openConversation(msg.conversation.id);
      } else {
        renderConversations();
        renderTitle();
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
      if (activeId === msg.conversationId) {
        toast('Cette discussion a été supprimée par l’hôte.');
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
          toast('Une action de l’agent attend votre décision dans une autre discussion.');
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
        markDirty(entry.id);
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
      break;
    case 'models':
      models = msg.models;
      renderModels();
      break;
    case 'invite':
      renderInvite(msg);
      break;
    case 'error':
      toast(msg.message);
      break;
    case 'sessionEnded':
      endSession(msg.reason);
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
  return participants.filter((p) => p.viewing === conversationId && p.clientId !== me?.clientId);
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
  if (names.length <= 2) {
    return names.join(' et ');
  }
  return `${names[0]}, ${names[1]} et ${names.length - 2} autre${names.length > 3 ? 's' : ''}`;
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
    text.textContent = `${nameList(writers)} ${writers.length > 1 ? 'écrivent' : 'écrit'}…`;
  } else if (here.length) {
    text.textContent = `${nameList(here.map((p) => p.name))} ${here.length > 1 ? 'sont' : 'est'} dans cette discussion`;
  } else {
    text.textContent = 'Personne d’autre dans cette discussion pour l’instant';
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
  convTitle.textContent = conv?.title ?? '';
  convTitle.title = conv ? `Créée par ${conv.createdBy} à ${formatTime(conv.createdAt)}` : '';
  document.title = conv ? `${conv.title} — Shared Copilot` : 'Shared Copilot';
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
      title.textContent = conv.title;
      const meta = document.createElement('span');
      meta.className = 'conv-meta';
      meta.textContent =
        conv.id === answering ? 'Copilot répond…' : waiting.has(conv.id) ? 'En attente…' : `${conv.createdBy} · ${formatTime(conv.createdAt)}`;
      const writers = typingIn(conv.id);
      if (writers.length && conv.id !== answering) {
        meta.textContent = `${nameList(writers)} ${writers.length > 1 ? 'écrivent' : 'écrit'}…`;
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
        del.title = 'Supprimer la discussion';
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
  del.textContent = 'Supprimer ?';
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
    toast('Non connecté.');
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
      el.append(turnHead(avatar(entry.author), entry.author, entry.timestamp, entry.isHost ? 'hôte' : undefined));
      const request = document.createElement('div');
      request.className = 'request body';
      request.append(renderMarkdown(entry.text));
      el.append(request);
      break;
    }
    case 'assistant':
      renderAssistant(entry, el);
      break;
    case 'context': {
      const where = entry.range ? `${entry.fileName} — ${entry.range}` : entry.fileName;
      el.append(turnHead(avatar(entry.author), `${entry.author} a partagé du contexte`, entry.timestamp));
      el.append(codeBlock(entry.code, entry.languageId, where));
      break;
    }
    case 'system': {
      el.classList.toggle('error', entry.level === 'error');
      el.textContent = entry.text;
      break;
    }
  }
}

function renderAssistant(entry: AssistantEntry, el: HTMLElement): void {
  const head = turnHead(copilotAvatar(), 'Copilot', entry.timestamp);
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${entry.model ? `${entry.model} · ` : ''}pour ${entry.replyToAuthor}`;
  head.append(meta);
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
    bodyEl.append(note('Réponse arrêtée.'));
  } else if (entry.status === 'error') {
    bodyEl.append(note(entry.error ?? 'Erreur inconnue.', true));
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
  title.textContent = tool.question ? tool.question.text : tool.title;
  text.append(title);
  if (tool.answer) {
    const answer = document.createElement('span');
    answer.className = 'tool-detail answered';
    answer.textContent = `« ${tool.answer} »${tool.answeredBy ? ` — ${tool.answeredBy}` : ''}`;
    text.append(answer);
  }
  if (tool.detail) {
    const detail = document.createElement('span');
    detail.className = 'tool-detail';
    detail.textContent = tool.detail;
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
  title.textContent = `${tool.title} ?`;
  head.append(title);
  if (approval.hostOnly) {
    const scope = document.createElement('span');
    scope.className = 'scope';
    scope.append(icon('warning'), document.createTextNode('Hors du projet'));
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
    foot.append(button('Autoriser', 'primary', decide('once')));
    if (me?.isHost && !approval.hostOnly) {
      foot.append(button('Autoriser pour la session', 'secondary', decide('session')));
    }
    foot.append(button('Refuser', 'secondary', decide('deny')));
    if (me?.isHost && approval.canShowDiff) {
      foot.append(button('Voir dans VS Code', 'link-btn', () => send({ type: 'showDiff', entryId: entry.id, toolId: tool.id })));
    }
  } else {
    const waiting = document.createElement('span');
    waiting.className = 'waiting';
    const requester = entries.get(entry.replyTo);
    waiting.textContent =
      approval.hostOnly || requester?.kind !== 'user'
        ? "En attente de la validation de l'hôte…"
        : `En attente de la validation de ${requester.author} ou de l'hôte…`;
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
  scope.append(icon('organization'), document.createTextNode('Tout le monde peut répondre'));
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
    input.placeholder = question.options.length ? 'Ou répondez librement…' : 'Votre réponse…';
    input.maxLength = LIMITS.maxAnswerLength;
    row.append(input, button('Répondre', 'primary', () => undefined, 'submit'));
    row.addEventListener('submit', (e) => {
      e.preventDefault();
      reply(input.value);
    });
    foot.append(row);
  } else {
    const waiting = document.createElement('span');
    waiting.className = 'waiting';
    waiting.textContent = 'En attente d’une réponse…';
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

function copilotAvatar(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'avatar copilot';
  span.append(icon('copilot'));
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
  title.textContent = 'Demandez à Copilot, ensemble';
  const text = document.createElement('p');
  text.textContent =
    "L'agent explore le projet de l'hôte, propose des modifications et lance des commandes ; chaque action est soumise à validation.";
  const suggestions = document.createElement('div');
  suggestions.className = 'suggestions';
  for (const s of SUGGESTIONS) {
    suggestions.append(
      button(s, '', () => {
        askInput.value = s;
        submitQuestion();
      }),
    );
  }
  div.append(icon('copilot'), title, text, suggestions);
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
        b.textContent = 'hôte';
        name.append(b);
      }
      if (p.clientId === me?.clientId) {
        const you = document.createElement('span');
        you.className = 'you';
        you.textContent = 'vous';
        name.append(you);
      }
      text.append(name);
      const where = conversations.find((c) => c.id === p.viewing);
      if (where) {
        const here = where.id === activeId;
        const w = document.createElement(here ? 'span' : 'button');
        w.className = 'person-where';
        w.textContent = here ? 'dans cette discussion' : `dans « ${where.title} »`;
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

function renderInvite(msg: Extract<ServerMessage, { type: 'invite' }>): void {
  const port = /:(\d+)/.exec(msg.localUrl)?.[1] ?? '3717';
  inviteHint.replaceChildren(
    document.createTextNode('Exposez le port '),
    Object.assign(document.createElement('code'), { textContent: port }),
    document.createTextNode(' avec '),
    Object.assign(document.createElement('code'), { textContent: `ngrok http ${port}` }),
    document.createTextNode(' ou le panneau Ports de VS Code (visibilité Public), puis collez l’URL publique :'),
  );
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
          textContent: msg.publicUrl
            ? 'Lien copié dans le presse-papier : envoyez-le aux participants.'
            : 'Lien local copié : il ne fonctionne que sur cette machine. Ajoutez l’URL du tunnel pour inviter d’autres personnes.',
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
    options.push(new Option('Aucun modèle disponible', ''));
  } else {
    options.push(new Option(defaultModel ? `${defaultModel.name} (défaut)` : 'Modèle par défaut', ''));
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
  modelSelect.disabled = ended || !canChoose || models.available.length < 2;
  modelSelect.parentElement!.title = canChoose ? 'Modèle utilisé pour vos questions' : "L'hôte a fixé le modèle de la session";
}

modelSelect.addEventListener('change', () => {
  chosenModel = modelSelect.value;
  store('local', 'scc.model', chosenModel);
});

function updateActivity(): void {
  const parts: string[] = [];
  const current = queue.current;
  if (current) {
    const who = current.clientId === me?.clientId ? 'vous' : current.author;
    const conv = conversations.find((c) => c.id === current.conversationId);
    const where = current.conversationId === activeId || !conv ? '' : ` dans « ${conv.title} »`;
    parts.push(`Copilot répond à ${who}${where}`);
  }
  const mine = queue.pending.findIndex((q) => q.clientId === me?.clientId);
  if (mine >= 0) {
    parts.push(`votre question est en position ${mine + 1} dans la file`);
  } else if (queue.pending.length) {
    parts.push(`${queue.pending.length} question(s) en attente`);
  }
  activityText.textContent = parts.join(' · ');
  activityEl.hidden = parts.length === 0;
  cancelBtn.hidden = !(me?.isHost && current);
}

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
    toast('Non connecté : la question sera à renvoyer après la reconnexion.');
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
      label.textContent = ok ? 'Copié' : 'Échec';
      setTimeout(() => (label.textContent = 'Copier'), 1500);
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

function setConnection(state: 'connecting' | 'online' | 'offline', label: string): void {
  connectionEl.dataset.state = state;
  connectionEl.title = label;
  updateComposer();
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
