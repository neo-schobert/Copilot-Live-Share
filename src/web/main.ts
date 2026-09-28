import {
  AssistantEntry,
  ChatEntry,
  CLOSE_CODES,
  LIMITS,
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

const entries = new Map<string, ChatEntry>();
const entryEls = new Map<string, HTMLElement>();
let participants: Participant[] = [];
let queue: QueueState = { current: null, pending: [] };
/** Entrées dont le rendu doit être rafraîchi à la prochaine frame (streaming). */
const dirty = new Set<string>();
let frameRequested = false;

// ---- Démarrage ----

nameInput.maxLength = LIMITS.maxNameLength;
askInput.maxLength = LIMITS.maxQuestionLength;
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
  updateComposer();
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
  updateComposer();
  updateActivity();
}

// ---- Messages serveur ----

function handle(msg: ServerMessage): void {
  switch (msg.type) {
    case 'welcome':
      me = msg.you;
      myName = msg.you.name;
      setConnection('online', 'Connecté');
      entries.clear();
      entryEls.clear();
      dirty.clear();
      messagesEl.replaceChildren();
      for (const entry of msg.history) {
        addEntry(entry);
      }
      if (!msg.history.length) {
        messagesEl.append(emptyState());
      }
      participants = msg.participants;
      queue = msg.queue;
      renderParticipants();
      updateActivity();
      updateComposer();
      scrollToBottom(true);
      break;
    case 'entry':
      messagesEl.querySelector('.empty')?.remove();
      withAutoScroll(() => addEntry(msg.entry));
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
      break;
    case 'error':
      toast(msg.message);
      break;
    case 'sessionEnded':
      endSession(msg.reason);
      break;
  }
}

// ---- Rendu des messages ----

function addEntry(entry: ChatEntry): void {
  entries.set(entry.id, entry);
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
  const d = new Date(timestamp);
  time.dateTime = d.toISOString();
  time.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
  div.textContent = 'Aucun message pour l’instant. Posez la première question !';
  return div;
}

/** Regroupe les re-rendus du streaming sur une frame d'affichage. */
function markDirty(id: string): void {
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

// ---- Participants, file d'attente, saisie ----

function renderParticipants(): void {
  peopleCount.textContent = String(participants.length);
  peopleList.replaceChildren(
    ...participants.map((p) => {
      const li = document.createElement('li');
      li.textContent = p.name;
      if (p.isHost) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = 'hôte';
        li.append(b);
      }
      if (p.clientId === me?.clientId) {
        const you = document.createElement('span');
        you.className = 'you';
        you.textContent = '(vous)';
        li.append(you);
      }
      return li;
    }),
  );
}

function updateActivity(): void {
  const parts: string[] = [];
  if (queue.current) {
    parts.push(`Le modèle répond à ${queue.current.clientId === me?.clientId ? 'vous' : queue.current.author}…`);
  }
  const mine = queue.pending.findIndex((q) => q.clientId === me?.clientId);
  if (mine >= 0) {
    parts.push(`Votre question est en position ${mine + 1} dans la file.`);
  } else if (queue.pending.length) {
    parts.push(`${queue.pending.length} question(s) en attente.`);
  }
  activityText.textContent = parts.join(' ');
  activityText.parentElement!.classList.toggle('busy', queue.current !== null);
  cancelBtn.hidden = !(me?.isHost && queue.current);
}

function updateComposer(): void {
  const online = !!ws && ws.readyState === WebSocket.OPEN && !!me && !ended;
  askInput.disabled = ended;
  askSend.disabled = !online;
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
  if (!text) {
    return;
  }
  if (!send({ type: 'ask', text })) {
    toast('Non connecté : la question sera à renvoyer après la reconnexion.');
    return;
  }
  askInput.value = '';
}

cancelBtn.addEventListener('click', () => {
  send({ type: 'cancel' });
});

peopleToggle.addEventListener('click', () => {
  const open = peopleEl.classList.toggle('open');
  peopleToggle.setAttribute('aria-expanded', String(open));
});

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
