import * as crypto from 'crypto';
import {
  AssistantEntry,
  ChatEntry,
  ClientMessage,
  CLOSE_CODES,
  ContextEntry,
  LIMITS,
  Participant,
  QueueItem,
  QueueState,
  ServerMessage,
  UserEntry,
} from './protocol';
import type { Connection, ConnectionHandler } from './server';

/**
 * État d'une session de chat : historique, participants et file d'attente des
 * questions. Indépendant de VS Code : le modèle est fourni via {@link ModelBackend}.
 */

export interface ModelTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ModelResponse {
  modelName: string;
  chunks: AsyncIterable<string>;
}

export interface ModelBackend {
  /** Lance une requête. Doit lever une Error au message lisible par les participants en cas d'échec. */
  ask(turns: ModelTurn[], signal: AbortSignal): Promise<ModelResponse>;
}

export interface ChatRoomOptions {
  /** Nombre d'échanges précédents envoyés au modèle (lu à chaque question). */
  historyLength: () => number;
  onParticipantsChanged?: (participants: Participant[]) => void;
}

interface ClientState extends Participant {
  joined: boolean;
}

interface QueuedQuestion extends QueueItem {
  text: string;
}

const SYSTEM_PROMPT = [
  'Tu es un assistant de programmation dans un chat partagé entre plusieurs personnes.',
  'Chaque message utilisateur est préfixé par le pseudo de son auteur, sous la forme « pseudo: message ».',
  "Les blocs « Contexte partagé » contiennent du code partagé par l'hôte depuis son éditeur.",
  "Réponds à la dernière question, en Markdown, dans la langue de son auteur. Tu peux t'adresser à lui par son pseudo.",
].join('\n');

export class ChatRoom implements ConnectionHandler {
  private readonly entries: ChatEntry[] = [];
  private readonly clients = new Map<Connection, ClientState>();
  private readonly queue: QueuedQuestion[] = [];
  private current: { item: QueuedQuestion; abort: AbortController } | undefined;
  private disposed = false;

  constructor(
    private readonly backend: ModelBackend,
    private readonly options: ChatRoomOptions,
  ) {}

  // ---- ConnectionHandler ----

  onOpen(conn: Connection): void {
    this.clients.set(conn, { clientId: '', name: '', isHost: conn.isHost, joined: false });
  }

  onClose(conn: Connection): void {
    const state = this.clients.get(conn);
    this.clients.delete(conn);
    // Les questions en attente sont conservées : le client peut se reconnecter.
    if (state?.joined) {
      this.broadcastParticipants();
    }
  }

  onMessage(conn: Connection, data: string): void {
    const state = this.clients.get(conn);
    if (!state || this.disposed) {
      return;
    }
    const msg = parseClientMessage(data);
    if (!msg) {
      conn.send({ type: 'error', message: 'Message invalide.' });
      return;
    }

    if (msg.type === 'hello') {
      this.handleHello(conn, state, msg.name, msg.clientId);
      return;
    }
    if (!state.joined) {
      conn.send({ type: 'error', message: "Choisissez d'abord un pseudo." });
      return;
    }
    switch (msg.type) {
      case 'ask':
        this.handleAsk(conn, state, msg.text);
        break;
      case 'cancel':
        if (!state.isHost) {
          conn.send({ type: 'error', message: "Seul l'hôte peut annuler une réponse." });
        } else if (!this.cancelCurrent()) {
          conn.send({ type: 'error', message: 'Aucune réponse en cours.' });
        }
        break;
    }
  }

  // ---- API utilisée par l'extension ----

  get participantList(): Participant[] {
    const byId = new Map<string, Participant>();
    for (const c of this.clients.values()) {
      if (c.joined) {
        byId.set(c.clientId, { clientId: c.clientId, name: c.name, isHost: c.isHost });
      }
    }
    return [...byId.values()];
  }

  get isAnswering(): boolean {
    return this.current !== undefined;
  }

  /** Annule la réponse en cours. Renvoie false s'il n'y en a pas. */
  cancelCurrent(): boolean {
    if (!this.current || this.current.abort.signal.aborted) {
      return false;
    }
    this.current.abort.abort();
    return true;
  }

  addContext(context: Omit<ContextEntry, 'kind' | 'id' | 'timestamp'>): void {
    const entry: ContextEntry = { kind: 'context', id: newId(), timestamp: Date.now(), ...context };
    this.pushEntry(entry);
  }

  addSystemMessage(text: string, level: 'info' | 'error' = 'info'): void {
    this.pushEntry({ kind: 'system', id: newId(), timestamp: Date.now(), level, text });
  }

  /** Prévient les clients, annule la réponse en cours et libère l'état. La fermeture des sockets revient au serveur. */
  dispose(reason: string): void {
    if (this.disposed) {
      return;
    }
    this.broadcast({ type: 'sessionEnded', reason });
    this.disposed = true;
    this.current?.abort.abort();
    this.queue.length = 0;
    this.entries.length = 0;
    this.clients.clear();
  }

  // ---- Gestion des messages ----

  private handleHello(conn: Connection, state: ClientState, rawName: string, rawClientId: string): void {
    const name = sanitizeName(rawName);
    if (!name) {
      conn.send({ type: 'error', message: 'Pseudo invalide.' });
      conn.close(CLOSE_CODES.protocolError, 'Invalid name');
      return;
    }
    state.name = name;
    state.clientId = /^[A-Za-z0-9_-]{8,64}$/.test(rawClientId) ? rawClientId : newId();
    state.joined = true;

    conn.send({
      type: 'welcome',
      you: { clientId: state.clientId, name: state.name, isHost: state.isHost },
      history: this.entries,
      participants: this.participantList,
      queue: this.queueState(),
    });
    this.broadcastParticipants();
  }

  private handleAsk(conn: Connection, state: ClientState, rawText: string): void {
    const text = rawText.trim();
    if (!text) {
      return;
    }
    if (text.length > LIMITS.maxQuestionLength) {
      conn.send({ type: 'error', message: `Question trop longue (max ${LIMITS.maxQuestionLength} caractères).` });
      return;
    }
    const pendingForClient = this.queue.filter((q) => q.clientId === state.clientId).length;
    if (pendingForClient >= LIMITS.maxPendingPerClient) {
      conn.send({ type: 'error', message: `Vous avez déjà ${pendingForClient} questions en attente.` });
      return;
    }

    const entry: UserEntry = {
      kind: 'user',
      id: newId(),
      timestamp: Date.now(),
      author: state.name,
      clientId: state.clientId,
      isHost: state.isHost,
      text,
    };
    this.pushEntry(entry);
    this.queue.push({ entryId: entry.id, clientId: state.clientId, author: state.name, text });
    this.broadcastQueue();
    this.pump();
  }

  // ---- File d'attente ----

  /** Démarre la question suivante si le modèle est libre. Une seule question à la fois (FIFO). */
  private pump(): void {
    if (this.current || this.disposed) {
      return;
    }
    const item = this.queue.shift();
    if (!item) {
      return;
    }
    const abort = new AbortController();
    this.current = { item, abort };
    void this.answer(item, abort.signal).finally(() => {
      this.current = undefined;
      if (!this.disposed) {
        this.broadcastQueue();
        this.pump();
      }
    });
  }

  private async answer(item: QueuedQuestion, signal: AbortSignal): Promise<void> {
    const turns = this.buildTurns(item);
    const entry: AssistantEntry = {
      kind: 'assistant',
      id: newId(),
      timestamp: Date.now(),
      replyTo: item.entryId,
      replyToAuthor: item.author,
      text: '',
      status: 'streaming',
    };
    this.pushEntry(entry);
    this.broadcastQueue();

    try {
      const response = await this.backend.ask(turns, signal);
      entry.model = response.modelName;
      this.broadcast({ type: 'entryUpdate', entryId: entry.id, status: 'streaming', model: entry.model });
      for await (const chunk of response.chunks) {
        if (signal.aborted || this.disposed) {
          break;
        }
        entry.text += chunk;
        this.broadcast({ type: 'chunk', entryId: entry.id, text: chunk });
      }
      entry.status = signal.aborted ? 'cancelled' : 'done';
    } catch (err) {
      if (signal.aborted) {
        entry.status = 'cancelled';
      } else {
        entry.status = 'error';
        entry.error = err instanceof Error ? err.message : String(err);
      }
    }
    if (!this.disposed) {
      this.broadcast({
        type: 'entryUpdate',
        entryId: entry.id,
        status: entry.status,
        model: entry.model,
        error: entry.error,
      });
    }
  }

  /**
   * Construit les messages envoyés au modèle : consigne, puis les N derniers
   * échanges terminés (chaque question suivie de sa réponse), puis la question.
   */
  private buildTurns(question: QueuedQuestion): ModelTurn[] {
    const answers = new Map<string, AssistantEntry>();
    for (const e of this.entries) {
      if (e.kind === 'assistant') {
        answers.set(e.replyTo, e);
      }
    }

    // Une « unité » = une question et sa réponse, ou un contexte partagé.
    const units: ModelTurn[][] = [];
    for (const e of this.entries) {
      if (e.kind === 'context') {
        units.push([{ role: 'user', content: formatContext(e) }]);
      } else if (e.kind === 'user' && e.id !== question.entryId) {
        const answer = answers.get(e.id);
        if (!answer || answer.status === 'streaming' || answer.status === 'error' || !answer.text) {
          continue;
        }
        const reply = answer.status === 'cancelled' ? `${answer.text}\n\n[réponse interrompue]` : answer.text;
        units.push([
          { role: 'user', content: `${e.author}: ${e.text}` },
          { role: 'assistant', content: reply },
        ]);
      }
    }

    const limit = Math.max(0, Math.floor(this.options.historyLength()));
    const recent = limit === 0 ? [] : units.slice(-limit);
    const turns: ModelTurn[] = [
      { role: 'user', content: SYSTEM_PROMPT },
      ...recent.flat(),
      { role: 'user', content: `${question.author}: ${question.text}` },
    ];
    return mergeConsecutive(turns);
  }

  private queueState(): QueueState {
    const strip = ({ entryId, clientId, author }: QueueItem): QueueItem => ({ entryId, clientId, author });
    return {
      current: this.current ? strip(this.current.item) : null,
      pending: this.queue.map(strip),
    };
  }

  // ---- Diffusion ----

  private pushEntry(entry: ChatEntry): void {
    if (this.disposed) {
      return;
    }
    this.entries.push(entry);
    this.broadcast({ type: 'entry', entry });
  }

  private broadcastQueue(): void {
    this.broadcast({ type: 'queue', queue: this.queueState() });
  }

  private broadcastParticipants(): void {
    const participants = this.participantList;
    this.broadcast({ type: 'participants', participants });
    this.options.onParticipantsChanged?.(participants);
  }

  private broadcast(msg: ServerMessage): void {
    for (const [conn, state] of this.clients) {
      if (state.joined) {
        conn.send(msg);
      }
    }
  }
}

function parseClientMessage(data: string): ClientMessage | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'hello':
      return typeof m.name === 'string' && typeof m.clientId === 'string'
        ? { type: 'hello', name: m.name, clientId: m.clientId }
        : undefined;
    case 'ask':
      return typeof m.text === 'string' ? { type: 'ask', text: m.text } : undefined;
    case 'cancel':
      return { type: 'cancel' };
    default:
      return undefined;
  }
}

function sanitizeName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITS.maxNameLength);
}

function formatContext(e: ContextEntry): string {
  const where = e.range ? `${e.fileName} (${e.range})` : e.fileName;
  return `[Contexte partagé par ${e.author} : ${where}]\n\`\`\`${e.languageId}\n${e.code}\n\`\`\``;
}

/** Fusionne les messages consécutifs de même rôle pour garantir l'alternance user/assistant. */
function mergeConsecutive(turns: ModelTurn[]): ModelTurn[] {
  const out: ModelTurn[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) {
      last.content += `\n\n${t.content}`;
    } else {
      out.push({ ...t });
    }
  }
  return out;
}

function newId(): string {
  return crypto.randomBytes(9).toString('base64url');
}
