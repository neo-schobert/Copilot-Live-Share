import * as crypto from 'crypto';
import {
  AssistantEntry,
  ChatEntry,
  ClientMessage,
  CLOSE_CODES,
  ContextEntry,
  Conversation,
  DEFAULT_CONVERSATION_TITLE,
  LIMITS,
  ModelsState,
  Participant,
  QueueItem,
  QueueState,
  ServerMessage,
  ToolActivity,
  UserEntry,
} from './protocol';
import type { Connection, ConnectionHandler } from './server';

/**
 * État d'une session de chat : discussions, historique, participants et file
 * d'attente des questions. Indépendant de VS Code : le modèle est fourni via
 * {@link ModelBackend}.
 */

export interface ModelTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type ModelEvent = { type: 'text'; text: string } | { type: 'tool'; tool: ToolActivity };

export interface ModelResponse {
  modelName: string;
  events: AsyncIterable<ModelEvent>;
}

export interface ModelRequest {
  turns: ModelTurn[];
  /** Modèle demandé ; absent : modèle par défaut. */
  modelId?: string;
  /** Auteur de la question (affiché dans les demandes de validation de l'hôte). */
  author: string;
}

export interface ModelBackend {
  /** Lance une requête. Doit lever une Error au message lisible par les participants en cas d'échec. */
  ask(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}

/** Identité utilisée pour les questions posées depuis VS Code (panneau Chat natif). */
export const LOCAL_HOST_CLIENT_ID = 'vscode-host-local';

export interface ChatRoomOptions {
  /** Nombre d'échanges précédents envoyés au modèle (lu à chaque question). */
  historyLength: () => number;
  onParticipantsChanged?: (participants: Participant[]) => void;
  /** Consignes ajoutées au prompt système (ex. description de l'espace de travail et des outils). */
  extraInstructions?: () => string;
}

interface ClientState extends Participant {
  joined: boolean;
}

interface QueuedQuestion extends QueueItem {
  text: string;
  /** Modèle choisi par l'auteur ; absent : modèle par défaut au moment du traitement. */
  modelId?: string;
}

interface ConversationState extends Conversation {
  /** Titre encore automatique : il prendra le texte de la première question. */
  autoTitle: boolean;
}

const SYSTEM_PROMPT = [
  'Tu es un assistant de programmation dans un chat partagé entre plusieurs personnes.',
  'Chaque message utilisateur est préfixé par le pseudo de son auteur, sous la forme « pseudo: message ».',
  "Les blocs « Contexte partagé » contiennent du code partagé par l'hôte depuis son éditeur.",
  "Réponds à la dernière question, en Markdown, dans la langue de son auteur. Tu peux t'adresser à lui par son pseudo.",
].join('\n');

export class ChatRoom implements ConnectionHandler {
  private readonly conversations: ConversationState[] = [];
  private readonly entries: ChatEntry[] = [];
  private readonly clients = new Map<Connection, ClientState>();
  private readonly queue: QueuedQuestion[] = [];
  private current: { item: QueuedQuestion; abort: AbortController } | undefined;
  private models: ModelsState = { available: [], defaultId: null, guestsCanChoose: true };
  private disposed = false;
  private readonly listeners = new Set<(msg: ServerMessage) => void>();

  constructor(
    private readonly backend: ModelBackend,
    private readonly options: ChatRoomOptions,
  ) {
    this.createConversation('hôte', '');
  }

  // ---- ConnectionHandler ----

  onOpen(conn: Connection): void {
    this.clients.set(conn, { clientId: '', name: '', isHost: conn.isHost, viewing: null, joined: false });
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
    const fail = (message: string) => conn.send({ type: 'error', message });

    switch (msg.type) {
      case 'ask':
        this.enqueueQuestion(state, msg.conversationId, msg.text, msg.modelId, fail);
        break;
      case 'cancel':
        if (!state.isHost) {
          fail("Seul l'hôte peut annuler une réponse.");
        } else if (!this.cancelCurrent()) {
          fail('Aucune réponse en cours.');
        }
        break;
      case 'view':
        if (this.findConversation(msg.conversationId) && state.viewing !== msg.conversationId) {
          state.viewing = msg.conversationId;
          this.broadcastParticipants();
        }
        break;
      case 'createConversation':
        if (this.conversations.length >= LIMITS.maxConversations) {
          fail(`Nombre maximal de discussions atteint (${LIMITS.maxConversations}).`);
        } else {
          this.createConversation(state.name, state.clientId);
        }
        break;
      case 'renameConversation': {
        const conv = this.findConversation(msg.conversationId);
        const title = sanitizeLine(msg.title, LIMITS.maxTitleLength);
        if (conv && title) {
          conv.title = title;
          conv.autoTitle = false;
          this.broadcastConversation(conv);
        }
        break;
      }
      case 'deleteConversation':
        if (!state.isHost) {
          fail("Seul l'hôte peut supprimer une discussion.");
        } else {
          this.deleteConversation(msg.conversationId);
        }
        break;
    }
  }

  // ---- API utilisée par l'extension ----

  get participantList(): Participant[] {
    const byId = new Map<string, Participant>();
    for (const c of this.clients.values()) {
      if (c.joined) {
        byId.set(c.clientId, { clientId: c.clientId, name: c.name, isHost: c.isHost, viewing: c.viewing });
      }
    }
    return [...byId.values()];
  }

  get conversationList(): Conversation[] {
    return this.conversations.map(publicConversation);
  }

  /** Discussion affichée par l'hôte (webview), s'il est connecté. */
  get hostViewing(): string | undefined {
    for (const c of this.clients.values()) {
      if (c.joined && c.isHost && c.viewing && this.findConversation(c.viewing)) {
        return c.viewing;
      }
    }
    return undefined;
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

  /** Ajoute un contexte partagé. Renvoie false si la discussion n'existe plus. */
  addContext(conversationId: string, context: Omit<ContextEntry, 'kind' | 'id' | 'timestamp' | 'conversationId'>): boolean {
    if (!this.findConversation(conversationId)) {
      return false;
    }
    this.pushEntry({ kind: 'context', id: newId(), conversationId, timestamp: Date.now(), ...context });
    return true;
  }

  /** Reçoit tous les messages diffusés aux participants (intégration au chat natif). */
  subscribe(listener: (msg: ServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getConversation(id: string): Conversation | undefined {
    const conv = this.findConversation(id);
    return conv && publicConversation(conv);
  }

  entriesOf(conversationId: string): ChatEntry[] {
    return this.entries.filter((e) => e.conversationId === conversationId);
  }

  /** Réponse (terminée ou en cours) à une question, si elle a commencé. */
  answerTo(questionId: string): AssistantEntry | undefined {
    return this.entries.find((e): e is AssistantEntry => e.kind === 'assistant' && e.replyTo === questionId);
  }

  /** Crée une discussion au nom de l'hôte depuis VS Code. */
  createConversationAsHost(author: string): Conversation {
    return publicConversation(this.createConversation(author, LOCAL_HOST_CLIENT_ID));
  }

  /**
   * Pose une question au nom de l'hôte depuis VS Code. Renvoie l'id de la question,
   * ou lève une Error si elle est refusée.
   */
  askAsHost(conversationId: string, text: string, author: string, modelId?: string): string {
    const state: ClientState = { clientId: LOCAL_HOST_CLIENT_ID, name: author, isHost: true, viewing: null, joined: true };
    let error: string | undefined;
    const knownModel = modelId && this.models.available.some((m) => m.id === modelId) ? modelId : undefined;
    const id = this.enqueueQuestion(state, conversationId, text, knownModel, (m) => (error = m));
    if (!id) {
      throw new Error(error ?? 'Question vide.');
    }
    return id;
  }

  /** Annule une question : arrête la réponse si elle est en cours, la retire de la file sinon. */
  cancelQuestion(entryId: string): void {
    if (this.current?.item.entryId === entryId) {
      this.cancelCurrent();
      return;
    }
    const before = this.queue.length;
    removeWhere(this.queue, (q) => q.entryId === entryId);
    if (this.queue.length !== before) {
      this.addSystemMessage(entryId, 'Question retirée de la file.');
      this.broadcastQueue();
    }
  }

  /** Met à jour la liste des modèles proposés et la diffuse. */
  setModels(models: ModelsState): void {
    this.models = models;
    this.broadcast({ type: 'models', models });
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
    this.conversations.length = 0;
    this.clients.clear();
    this.listeners.clear();
  }

  // ---- Gestion des messages ----

  private handleHello(conn: Connection, state: ClientState, rawName: string, rawClientId: string): void {
    const name = sanitizeLine(rawName, LIMITS.maxNameLength);
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
      you: { clientId: state.clientId, name: state.name, isHost: state.isHost, viewing: state.viewing },
      conversations: this.conversationList,
      history: this.entries,
      participants: this.participantList,
      queue: this.queueState(),
      models: this.models,
    });
    this.broadcastParticipants();
  }

  /** Valide et met en file une question. Renvoie l'id de la question, ou undefined si refusée. */
  private enqueueQuestion(
    state: ClientState,
    conversationId: string,
    rawText: string,
    rawModelId: string | undefined,
    fail: (message: string) => void,
  ): string | undefined {
    const conv = this.findConversation(conversationId);
    if (!conv) {
      fail("Cette discussion n'existe plus.");
      return undefined;
    }
    const text = rawText.trim();
    if (!text) {
      return undefined;
    }
    if (text.length > LIMITS.maxQuestionLength) {
      fail(`Question trop longue (max ${LIMITS.maxQuestionLength} caractères).`);
      return undefined;
    }
    let modelId: string | undefined;
    if (rawModelId) {
      if (!state.isHost && !this.models.guestsCanChoose) {
        fail("L'hôte a fixé le modèle : choix de modèle non autorisé.");
        return undefined;
      }
      if (!this.models.available.some((m) => m.id === rawModelId)) {
        fail("Ce modèle n'est plus disponible. Choisissez-en un autre.");
        return undefined;
      }
      modelId = rawModelId;
    }
    const pendingForClient = this.queue.filter((q) => q.clientId === state.clientId).length;
    if (pendingForClient >= LIMITS.maxPendingPerClient) {
      fail(`Vous avez déjà ${pendingForClient} questions en attente.`);
      return undefined;
    }

    const entry: UserEntry = {
      kind: 'user',
      id: newId(),
      conversationId,
      timestamp: Date.now(),
      author: state.name,
      clientId: state.clientId,
      isHost: state.isHost,
      text,
    };
    this.pushEntry(entry);
    if (conv.autoTitle) {
      conv.title = sanitizeLine(text, LIMITS.maxTitleLength) || conv.title;
      conv.autoTitle = false;
      this.broadcastConversation(conv);
    }
    this.queue.push({ entryId: entry.id, conversationId, clientId: state.clientId, author: state.name, text, modelId });
    this.broadcastQueue();
    this.pump();
    return entry.id;
  }

  private addSystemMessage(nearEntryId: string, text: string): void {
    const near = this.entries.find((e) => e.id === nearEntryId);
    if (near) {
      this.pushEntry({ kind: 'system', id: newId(), conversationId: near.conversationId, timestamp: Date.now(), level: 'info', text });
    }
  }

  // ---- Discussions ----

  private findConversation(id: string): ConversationState | undefined {
    return this.conversations.find((c) => c.id === id);
  }

  private createConversation(author: string, clientId: string): ConversationState {
    const conv: ConversationState = {
      id: newId(),
      title: DEFAULT_CONVERSATION_TITLE,
      createdAt: Date.now(),
      createdBy: author,
      createdByClientId: clientId,
      autoTitle: true,
    };
    this.conversations.push(conv);
    this.broadcastConversation(conv);
    return conv;
  }

  private deleteConversation(id: string): void {
    const index = this.conversations.findIndex((c) => c.id === id);
    if (index < 0) {
      return;
    }
    this.conversations.splice(index, 1);
    removeWhere(this.entries, (e) => e.conversationId === id);
    removeWhere(this.queue, (q) => q.conversationId === id);
    if (this.current?.item.conversationId === id) {
      this.current.abort.abort();
    }
    for (const c of this.clients.values()) {
      if (c.viewing === id) {
        c.viewing = null;
      }
    }
    this.broadcast({ type: 'conversationDeleted', conversationId: id });
    // Il reste toujours au moins une discussion.
    if (!this.conversations.length) {
      this.createConversation('hôte', '');
    }
    this.broadcastQueue();
    this.broadcastParticipants();
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
      conversationId: item.conversationId,
      timestamp: Date.now(),
      replyTo: item.entryId,
      replyToAuthor: item.author,
      text: '',
      parts: [],
      status: 'streaming',
    };
    this.pushEntry(entry);
    this.broadcastQueue();

    try {
      const response = await this.backend.ask(
        { turns, modelId: item.modelId ?? this.models.defaultId ?? undefined, author: item.author },
        signal,
      );
      entry.model = response.modelName;
      this.broadcast({ type: 'entryUpdate', entryId: entry.id, status: 'streaming', model: entry.model });
      for await (const event of response.events) {
        if (signal.aborted || this.disposed) {
          break;
        }
        if (event.type === 'text') {
          appendText(entry, event.text);
          this.broadcast({ type: 'chunk', entryId: entry.id, text: event.text });
        } else {
          upsertTool(entry, event.tool);
          this.broadcast({ type: 'tool', entryId: entry.id, tool: event.tool });
        }
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
   * échanges terminés de la même discussion (chaque question suivie de sa
   * réponse), puis la question.
   */
  private buildTurns(question: QueuedQuestion): ModelTurn[] {
    const entries = this.entries.filter((e) => e.conversationId === question.conversationId);
    const answers = new Map<string, AssistantEntry>();
    for (const e of entries) {
      if (e.kind === 'assistant') {
        answers.set(e.replyTo, e);
      }
    }

    // Une « unité » = une question et sa réponse, ou un contexte partagé.
    const units: ModelTurn[][] = [];
    for (const e of entries) {
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
    const extra = this.options.extraInstructions?.();
    const turns: ModelTurn[] = [
      { role: 'user', content: extra ? `${SYSTEM_PROMPT}\n\n${extra}` : SYSTEM_PROMPT },
      ...recent.flat(),
      { role: 'user', content: `${question.author}: ${question.text}` },
    ];
    return mergeConsecutive(turns);
  }

  private queueState(): QueueState {
    const strip = ({ entryId, conversationId, clientId, author }: QueueItem): QueueItem => ({
      entryId,
      conversationId,
      clientId,
      author,
    });
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

  private broadcastConversation(conv: ConversationState): void {
    this.broadcast({ type: 'conversation', conversation: publicConversation(conv) });
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
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch {
        // Un abonné local défaillant ne doit pas bloquer la diffusion.
      }
    }
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
  const str = (v: unknown): v is string => typeof v === 'string';
  switch (m.type) {
    case 'hello':
      return str(m.name) && str(m.clientId) ? { type: 'hello', name: m.name, clientId: m.clientId } : undefined;
    case 'ask':
      if (!str(m.text) || !str(m.conversationId) || (m.modelId !== undefined && !str(m.modelId))) {
        return undefined;
      }
      return { type: 'ask', conversationId: m.conversationId, text: m.text, modelId: m.modelId || undefined };
    case 'cancel':
      return { type: 'cancel' };
    case 'view':
      return str(m.conversationId) ? { type: 'view', conversationId: m.conversationId } : undefined;
    case 'createConversation':
      return { type: 'createConversation' };
    case 'renameConversation':
      return str(m.conversationId) && str(m.title)
        ? { type: 'renameConversation', conversationId: m.conversationId, title: m.title }
        : undefined;
    case 'deleteConversation':
      return str(m.conversationId) ? { type: 'deleteConversation', conversationId: m.conversationId } : undefined;
    default:
      return undefined;
  }
}

/** Texte sur une ligne : sans caractères de contrôle, espaces normalisés, tronqué. */
function sanitizeLine(raw: string, maxLength: number): string {
  const clean = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1).trimEnd()}…` : clean;
}

function publicConversation({ id, title, createdAt, createdBy, createdByClientId }: ConversationState): Conversation {
  return { id, title, createdAt, createdBy, createdByClientId };
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

function appendText(entry: AssistantEntry, text: string): void {
  entry.text += text;
  const last = entry.parts[entry.parts.length - 1];
  if (last?.type === 'text') {
    last.text += text;
  } else {
    entry.parts.push({ type: 'text', text });
  }
}

function upsertTool(entry: AssistantEntry, tool: ToolActivity): void {
  const existing = entry.parts.find((p) => p.type === 'tool' && p.tool.id === tool.id);
  if (existing && existing.type === 'tool') {
    existing.tool = { ...tool };
  } else {
    entry.parts.push({ type: 'tool', tool: { ...tool } });
  }
}

function removeWhere<T>(list: T[], pred: (item: T) => boolean): void {
  for (let i = list.length - 1; i >= 0; i--) {
    if (pred(list[i])) {
      list.splice(i, 1);
    }
  }
}

function newId(): string {
  return crypto.randomBytes(9).toString('base64url');
}
