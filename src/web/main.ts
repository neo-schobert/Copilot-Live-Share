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
  WS_PATH,
} from '../protocol';
import { codeBlock, renderMarkdown } from './markdown';

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
const peopleEl = $<HTMLElement>('people');
const peopleList = $<HTMLUListElement>('people-list');
const peopleCount = $<HTMLElement>('people-count');
const peopleToggle = $<HTMLButtonElement>('toggle-people');
const bannerEl = $<HTMLElement>('banner');
const activityText = $<HTMLElement>('activity-text');
const cancelBtn = $<HTMLButtonElement>('cancel');
const askForm = $<HTMLFormElement>('ask-form');
const askInput = $<HTMLTextAreaElement>('ask-input');
const askSend = $<HTMLButtonElement>('ask-send');
const modelSelect = $<HTMLSelectElement>('model-select');
const toastEl = $<HTMLElement>('toast');

// ---- État ----

const params = new URLSearchParams(location.search);
const token = params.get('token') ?? '';
const clientId = loadClientId();

let myName = '';
let me: Participant | undefined;
let ws: WebSocket | undefined;
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
/** Entrées dont le rendu doit être rafraîchi à la prochaine frame (streaming). */
const dirty = new Set<string>();
let frameRequested = false;

// ---- Démarrage ----

nameInput.maxLength = LIMITS.maxNameLength;
askInput.maxLength = LIMITS.maxQuestionLength;
renameInput.maxLength = LIMITS.maxTitleLength;
nameInput.value = params.get('name') ?? storage('session', 'scc.name') ?? storage('local', 'scc.name') ?? '';

// Reconnexion après rechargement de l'onglet, ou pseudo fourni par l'hôte (webview) : on rejoint directement.
if (nameInput.value.trim() && (params.has('name') || storage('session', 'scc.name'))) {
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

// ---- WebSocket ----

function connect(): void {
  if (ended) {
    return;
  }
  setConnection('connecting', me ? 'Reconnexion…' : 'Connexion…');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = location.pathname.replace(/[^/]*$/, '');
  const socket = new WebSocket(`${proto}//${location.host}${base}${WS_PATH}?token=${encodeURIComponent(token)}`);
  ws = socket;

  socket.onopen = () => {
    reconnectDelay = 1000;
    socket.send(JSON.stringify({ type: 'hello', name: myName, clientId }));
  };
  socket.onmessage = (ev) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(ev.data)) as ServerMessage;
    } catch {
      return;
    }
    handle(msg);
  };
  socket.onclose = (ev) => {
    if (ws !== socket) {
      return;
    }
    ws = undefined;
    if (ev.code === CLOSE_CODES.sessionEnded) {
      endSession("L'hôte a arrêté la session.");
      return;
    }
    if (ev.code === CLOSE_CODES.protocolError) {
      endSession(`Connexion refusée par le serveur${ev.reason ? ` : ${ev.reason}` : ''}.`);
      return;
    }
    scheduleReconnect();
  };
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
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
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
  bannerEl.hidden = false;
  queue = { current: null, pending: [] };
  participants = [];
  renderParticipants();
  renderConversations();
  updateComposer();
  updateActivity();
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
      if (msg.entry.conversationId === activeId) {
        messagesEl.querySelector('.empty')?.remove();
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
        markDirty(entry.id);
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
      renderParticipants();
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

  entryEls.clear();
  dirty.clear();
  messagesEl.replaceChildren();
  const list = [...entries.values()].filter((e) => e.conversationId === id);
  for (const entry of list) {
    appendEntry(entry);
  }
  if (!list.length) {
    messagesEl.append(emptyState());
  }
  renderConversations();
  renderTitle();
  renderParticipants();
  updateActivity();
  updateComposer();
  closeDrawers();
  scrollToBottom(true);
}

function renderTitle(): void {
  const conv = conversations.find((c) => c.id === activeId);
  convTitle.textContent = conv?.title ?? '';
  convTitle.title = conv ? `Créée par ${conv.createdBy} à ${formatTime(conv.createdAt)}` : '';
  document.title = conv ? `${conv.title} — Shared Copilot Chat` : 'Shared Copilot Chat';
}

function renderConversations(): void {
  const answering = queue.current?.conversationId;
  const waiting = new Set(queue.pending.map((q) => q.conversationId));
  convList.replaceChildren(
    ...[...conversations].reverse().map((conv) => {
      const li = document.createElement('li');
      li.className = 'conv';
      li.classList.toggle('active', conv.id === activeId);
      li.dataset.id = conv.id;

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'conv-open';
      const title = document.createElement('span');
      title.className = 'conv-name';
      title.textContent = conv.title;
      const meta = document.createElement('span');
      meta.className = 'conv-meta';
      meta.textContent = conv.id === answering ? 'Le modèle répond…' : waiting.has(conv.id) ? 'En attente…' : formatTime(conv.createdAt);
      open.append(title, meta);
      li.append(open);

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
        del.className = 'conv-delete ghost icon';
        del.title = 'Supprimer la discussion';
        del.textContent = '🗑';
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
      del.textContent = '🗑';
      del.classList.remove('confirm');
    }
  }, 3000);
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
  el.className = `msg msg-${entry.kind}`;
  el.replaceChildren();

  switch (entry.kind) {
    case 'user': {
      if (entry.clientId === me?.clientId) {
        el.classList.add('mine');
      }
      el.append(header(entry.author, entry.timestamp, entry.isHost ? 'hôte' : undefined), body(renderMarkdown(entry.text)));
      break;
    }
    case 'assistant':
      renderAssistant(entry, el);
      break;
    case 'context': {
      const where = entry.range ? `${entry.fileName} — ${entry.range}` : entry.fileName;
      el.append(header(`Contexte partagé par ${entry.author}`, entry.timestamp), codeBlock(entry.code, entry.languageId, where));
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
  el.classList.toggle('streaming', entry.status === 'streaming');
  const name = entry.model ? `Copilot · ${entry.model}` : 'Copilot';
  const h = header(name, entry.timestamp);
  const replyTo = document.createElement('span');
  replyTo.className = 'reply-to';
  replyTo.textContent = `répond à ${entry.replyToAuthor}`;
  h.append(replyTo);
  el.append(h);

  if (entry.text) {
    el.append(body(renderMarkdown(entry.text)));
  } else if (entry.status === 'streaming') {
    const typing = document.createElement('div');
    typing.className = 'typing';
    typing.innerHTML = '<span></span><span></span><span></span>';
    el.append(typing);
  }

  if (entry.status === 'cancelled') {
    el.append(note('Réponse annulée par l’hôte.'));
  } else if (entry.status === 'error') {
    el.append(note(entry.error ?? 'Erreur inconnue.', true));
  }
}

function header(author: string, timestamp: number, badge?: string): HTMLElement {
  const h = document.createElement('header');
  const who = document.createElement('strong');
  who.textContent = author;
  h.append(who);
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

function body(content: DocumentFragment): HTMLElement {
  const div = document.createElement('div');
  div.className = 'body';
  div.append(content);
  return div;
}

function note(text: string, isError = false): HTMLElement {
  const p = document.createElement('p');
  p.className = isError ? 'note error' : 'note';
  p.textContent = text;
  return p;
}

function emptyState(): HTMLElement {
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = 'Aucun message dans cette discussion. Posez la première question !';
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

function withAutoScroll(fn: () => void): void {
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
  fn();
  if (nearBottom) {
    scrollToBottom();
  }
}

function scrollToBottom(instant = false): void {
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
}

// ---- Participants, modèles, file d'attente, saisie ----

function renderParticipants(): void {
  peopleCount.textContent = String(participants.length);
  peopleList.replaceChildren(
    ...participants.map((p) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'person';
      name.textContent = p.name;
      li.append(name);
      if (p.isHost) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = 'hôte';
        name.append(b);
      }
      if (p.clientId === me?.clientId) {
        const you = document.createElement('span');
        you.className = 'you';
        you.textContent = '(vous)';
        name.append(you);
      }
      const where = conversations.find((c) => c.id === p.viewing);
      if (where) {
        const w = document.createElement('button');
        w.type = 'button';
        w.className = 'where';
        w.textContent = where.id === activeId ? 'ici' : `dans « ${where.title} »`;
        w.disabled = where.id === activeId;
        w.addEventListener('click', () => openConversation(where.id));
        li.append(w);
      }
      return li;
    }),
  );
}

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
    options.push(new Option(defaultModel ? `${defaultModel.name} (par défaut)` : 'Modèle par défaut', ''));
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
  modelSelect.title = canChoose ? 'Modèle utilisé pour vos questions' : "L'hôte a fixé le modèle de la session";
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
    parts.push(`Le modèle répond à ${who}${where}…`);
  }
  const mine = queue.pending.findIndex((q) => q.clientId === me?.clientId);
  if (mine >= 0) {
    parts.push(`Votre question est en position ${mine + 1} dans la file.`);
  } else if (queue.pending.length) {
    parts.push(`${queue.pending.length} question(s) en attente.`);
  }
  activityText.textContent = parts.join(' ');
  activityText.parentElement!.classList.toggle('busy', current !== null);
  cancelBtn.hidden = !(me?.isHost && current);
}

function updateComposer(): void {
  const online = !!ws && ws.readyState === WebSocket.OPEN && !!me && !ended && !!activeId;
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
}

cancelBtn.addEventListener('click', () => {
  send({ type: 'cancel' });
});

// ---- Tiroirs (écrans étroits) ----

function toggleDrawer(drawer: HTMLElement, button: HTMLButtonElement): void {
  const open = !drawer.classList.contains('open');
  closeDrawers();
  drawer.classList.toggle('open', open);
  button.setAttribute('aria-expanded', String(open));
}

function closeDrawers(): void {
  for (const [drawer, button] of [
    [convsEl, convsToggle],
    [peopleEl, peopleToggle],
  ] as const) {
    drawer.classList.remove('open');
    button.setAttribute('aria-expanded', 'false');
  }
}

convsToggle.addEventListener('click', () => toggleDrawer(convsEl, convsToggle));
peopleToggle.addEventListener('click', () => toggleDrawer(peopleEl, peopleToggle));
messagesEl.addEventListener('pointerdown', () => closeDrawers());

// Boutons « copier » des blocs de code (délégation, car le contenu est re-rendu pendant le streaming).
messagesEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.copy');
  const code = btn?.closest('.codeblock')?.querySelector('code')?.textContent;
  if (!btn || code == null) {
    return;
  }
  void copyText(code).then((ok) => {
    btn.textContent = ok ? 'Copié ✓' : 'Échec';
    setTimeout(() => (btn.textContent = 'Copier'), 1500);
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
  connectionEl.textContent = label;
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
