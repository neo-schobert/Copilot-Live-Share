import * as crypto from 'crypto';
import {
  AgentQuestion,
  ApprovalDecision,
  ApprovalRequest,
  AssistantEntry,
  ChatEntry,
  ClientMessage,
  CLOSE_CODES,
  ContextEntry,
  ContextUsage,
  Conversation,
  DEFAULT_CONVERSATION_TITLE,
  LIMITS,
  ModelsState,
  Participant,
  QueueItem,
  QueueState,
  ServerMessage,
  SessionOption,
  SessionPolicy,
  SharedApp,
  SummaryEntry,
  TunnelProviderId,
  TunnelState,
  ToolActivity,
  UserEntry,
} from './protocol';
import type { Connection, ConnectionHandler } from './server';
import { I18nText, isLang, Lang, Params } from './i18n/core';
import { I18nError, renderRoomText, RoomKey, roomT, roomText } from './i18n/room';

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
  authorClientId: string;
  /** Attente des décisions humaines pendant la réponse. */
  interaction: ToolInteraction;
  /** Sans outils (compactage : simple résumé). */
  noTools?: boolean;
  /** Langue de l'hôte, pour les notes insérées dans la réponse. */
  lang?: Lang;
}

/**
 * Pont entre l'agent et les participants. L'action concernée a déjà été diffusée
 * (statut awaitingApproval / awaitingAnswer) quand ces méthodes sont appelées.
 */
export interface ToolInteraction {
  /** Attend la décision (de l'hôte, ou de l'auteur si l'action reste dans le projet) ; « deny » si la réponse est annulée. */
  approval(tool: ToolActivity & { approval: ApprovalRequest }): Promise<ApprovalOutcome>;
  /** Attend la première réponse d'un participant ; texte vide si la réponse est annulée. */
  answer(tool: ToolActivity & { question: AgentQuestion }): Promise<AnswerOutcome>;
}

export interface InviteResult {
  publicUrl: string;
  localUrl: string;
  link?: string;
  copied: boolean;
  error?: string;
  /** Tunnel ouvert par l'extension (nom du fournisseur). */
  tunnel?: string;
}

export interface AnswerOutcome {
  text: string;
  /** Qui a répondu (vide si annulé). */
  by: string;
}

export interface ApprovalOutcome {
  decision: ApprovalDecision;
  /** Qui a décidé (vide si annulé). */
  by: string;
}

/** Action en attente de validation, transmise à l'extension pour notifier l'hôte dans VS Code. */
export interface PendingApproval {
  entryId: string;
  conversationId: string;
  tool: ToolActivity & { approval: ApprovalRequest };
  author: string;
}

/** Question d'invité en attente de l'accord de l'hôte, transmise à l'extension pour le notifier. */
export interface PendingReview {
  entryId: string;
  conversationId: string;
  author: string;
  text: string;
  /** Nom du modèle demandé par l'invité, s'il en a choisi un. */
  modelName?: string;
}

export interface PendingQuestion {
  entryId: string;
  conversationId: string;
  tool: ToolActivity & { question: AgentQuestion };
}

export interface ModelBackend {
  /** Lance une requête. Doit lever une Error au message lisible par les participants en cas d'échec. */
  ask(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
  /** Taille de ces messages en tokens du modèle (jauge du contexte). Absent ou undefined : inconnue. */
  measure?(turns: ModelTurn[], modelId?: string): Promise<ContextUsage | undefined>;
}

/** Identité utilisée pour les questions posées depuis VS Code (panneau Chat natif). */
export const LOCAL_HOST_CLIENT_ID = 'vscode-host-local';

export interface ChatRoomOptions {
  /** Nombre d'échanges précédents envoyés au modèle (lu à chaque question). */
  historyLength: () => number;
  onParticipantsChanged?: (participants: Participant[]) => void;
  /** Pseudo de l'hôte, affiché comme créateur de la première discussion. */
  hostName?: string;
  /** Consignes ajoutées au prompt système (ex. description de l'espace de travail et des outils). */
  extraInstructions?: () => string;
  onApprovalRequested?: (pending: PendingApproval) => void;
  onQuestionAsked?: (pending: PendingQuestion) => void;
  /** L'hôte demande le lien d'invitation (et sa copie dans le presse-papier de VS Code). */
  onInviteRequested?: (publicUrl: string | undefined, copy: boolean) => Promise<InviteResult>;
  /** L'hôte demande à voir le diff complet d'une action. */
  onShowDiff?: (entryId: string, toolId: string) => void;
  /** Langue de l'hôte : repli des textes générés par le serveur, et langue d'une page qui ne la précise pas. */
  defaultLang?: () => Lang;
  /** Règles de la session (lues à chaque question). Absent : aucune validation, pas de limite. */
  policy?: () => SessionPolicy;
  /** Une question d'invité attend l'accord de l'hôte. */
  onReviewRequested?: (pending: PendingReview) => void;
  /** L'hôte demande l'ouverture d'un tunnel public depuis la page. */
  onTunnelRequested?: (provider?: TunnelProviderId) => Promise<InviteResult>;
  /** L'hôte demande la fermeture du tunnel public. */
  onTunnelStop?: () => void;
  /** L'hôte change un réglage de la session depuis le chat. */
  onSessionOption?: (option: SessionOption, value: boolean) => void;
  /** Motif de refus du partage de ce port (ex. port du serveur de session), sinon undefined. Texte brut ou à traduire. */
  appRefusal?: (port: number) => string | I18nText | undefined;
  /** Liste des applications partagées modifiée (coupure des relais d'un port retiré). */
  onAppsChanged?: (apps: SharedApp[]) => void;
}

const HOUR_MS = 60 * 60_000;

interface Waiter<T> {
  resolve: (value: T) => void;
  info: { entryId: string; tool: ToolActivity };
}

interface ClientState extends Participant {
  joined: boolean;
  /** Langue de la page, pour les messages qui lui sont adressés. */
  lang: Lang;
}

interface QueuedQuestion extends QueueItem {
  text: string;
  /** Modèle choisi par l'auteur ; absent : modèle par défaut au moment du traitement. */
  modelId?: string;
}

interface ConversationState extends Conversation {
  /** Titre encore automatique : il prendra le texte de la première question. */
  autoTitle: boolean;
  /** Numéro de la dernière mesure du contexte lancée (les mesures plus anciennes sont ignorées). */
  measuring?: number;
}

// Textes envoyés au modèle : en anglais (le modèle répond dans la langue de l'auteur de la question).
const SUMMARY_PREFIX = '[Summary of the previous exchanges of this conversation, produced by compaction]';

const COMPACT_PROMPT = [
  'You are compacting a programming conversation shared between several people.',
  'Summarize the exchanges below so that an assistant can continue the conversation without them:',
  'goals, decisions made, files and code involved (paths, function names), problems encountered and their solutions,',
  'open questions, and who asked for what (names).',
  'Be factual and concise (400 words at most), in Markdown, in the language of the conversation. Do not answer any question.',
].join('\n');

const SYSTEM_PROMPT = [
  'You are a programming assistant in a chat shared between several people.',
  'Each user message is prefixed with the name of its author, in the form "name: message".',
  'The "Shared context" blocks contain code shared by the host from their editor.',
  'Answer the last question, in Markdown, in the language of its author. You may address them by their name.',
].join('\n');

export class ChatRoom implements ConnectionHandler {
  private readonly conversations: ConversationState[] = [];
  private readonly entries: ChatEntry[] = [];
  private readonly clients = new Map<Connection, ClientState>();
  private readonly queue: QueuedQuestion[] = [];
  /** Questions d'invités en attente de l'accord de l'hôte. */
  private readonly awaitingReview: QueuedQuestion[] = [];
  /** État du tunnel public, transmis aux pages de l'hôte. */
  private tunnel: TunnelState = { status: 'off', provider: 'cloudflare' };
  /** Applications locales partagées par l'hôte, par port. */
  private readonly apps = new Map<number, SharedApp>();
  /** Horodatages des questions d'invités envoyées au modèle (limite horaire). */
  private readonly guestSent: number[] = [];
  private current: { item: QueuedQuestion; abort: AbortController } | undefined;
  private models: ModelsState = { available: [], defaultId: null, guestsCanChoose: true };
  private disposed = false;
  private readonly listeners = new Set<(msg: ServerMessage) => void>();
  private readonly approvals = new Map<string, Waiter<ApprovalOutcome>>();
  private readonly questions = new Map<string, Waiter<AnswerOutcome>>();

  constructor(
    private readonly backend: ModelBackend,
    private readonly options: ChatRoomOptions,
  ) {
    this.createConversation(options.hostName ?? roomT(this.hostLang(), 'participant.host'), '');
  }

  /** Langue de l'hôte : textes générés par le serveur (repli) et appels de l'extension. */
  private hostLang(): Lang {
    return this.options.defaultLang?.() ?? 'en';
  }

  // ---- ConnectionHandler ----

  onOpen(conn: Connection): void {
    this.clients.set(conn, { clientId: '', name: '', isHost: conn.isHost, viewing: null, joined: false, lang: this.hostLang() });
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
      conn.send({ type: 'error', message: roomT(state.lang, 'error.invalidMessage') });
      return;
    }

    if (msg.type === 'hello') {
      if (msg.lang) {
        state.lang = msg.lang;
      }
      this.handleHello(conn, state, msg.name, msg.clientId);
      return;
    }
    if (!state.joined) {
      conn.send({ type: 'error', message: roomT(state.lang, 'error.chooseName') });
      return;
    }
    if (msg.type === 'setLang') {
      state.lang = msg.lang;
      return;
    }
    const fail = (message: string) => conn.send({ type: 'error', message });
    /** Refus traduit dans la langue de ce participant. */
    const refuse = (key: RoomKey, params?: Params) => fail(roomT(state.lang, key, params));
    const refuseText = (text: I18nText | undefined) => text && fail(renderRoomText(state.lang, text));

    switch (msg.type) {
      case 'ask':
        this.enqueueQuestion(state, msg.conversationId, msg.text, msg.modelId, refuseText);
        break;
      case 'cancel':
        if (!state.isHost) {
          refuse('error.hostOnlyCancel');
        } else if (!this.cancelCurrent()) {
          refuse('error.noActiveResponse');
        }
        break;
      case 'invite':
        if (!state.isHost) {
          refuse('error.hostOnlyInvite');
        } else if (this.options.onInviteRequested) {
          void this.options.onInviteRequested(msg.publicUrl, msg.copy).then((result) => conn.send({ type: 'invite', ...result }));
        }
        break;
      case 'typing':
        if (this.findConversation(msg.conversationId)) {
          this.broadcast({ type: 'typing', conversationId: msg.conversationId, clientId: state.clientId, name: state.name });
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
          refuse('error.maxConversations', { max: LIMITS.maxConversations });
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
          refuse('error.hostOnlyDelete');
        } else {
          this.deleteConversation(msg.conversationId);
        }
        break;
      case 'approve': {
        const refusal = this.approvalRefusal(state, msg.entryId, msg.toolId, msg.decision);
        if (refusal) {
          refuse(refusal);
        } else {
          this.resolveApproval(msg.entryId, msg.toolId, msg.decision, state.name);
        }
        break;
      }
      case 'showDiff':
        if (state.isHost) {
          this.options.onShowDiff?.(msg.entryId, msg.toolId);
        }
        break;
      case 'shareApp':
      case 'unshareApp': {
        if (!state.isHost) {
          refuse('error.hostOnlyShareApp');
          break;
        }
        const refusal = msg.type === 'shareApp' ? this.shareApp(msg.port, msg.label, state.lang) : (this.unshareApp(msg.port), undefined);
        if (refusal) {
          fail(refusal);
        }
        break;
      }
      case 'startTunnel':
        if (!state.isHost) {
          refuse('error.hostOnlyStartTunnel');
        } else if (this.options.onTunnelRequested) {
          void this.options.onTunnelRequested(msg.provider).then((result) => conn.send({ type: 'invite', ...result }));
        }
        break;
      case 'compact': {
        const refusal = state.isHost
          ? this.compact(msg.conversationId, state.name, state.clientId, state.lang)
          : roomT(state.lang, 'error.hostOnlyCompact');
        if (refusal) {
          fail(refusal);
        }
        break;
      }
      case 'fork': {
        const refusal = this.fork(msg.conversationId, msg.upToEntryId, state.name, state.clientId, state.lang);
        if (refusal) {
          fail(refusal);
        }
        break;
      }
      case 'setSessionOption':
        if (!state.isHost) {
          refuse('error.hostOnlySettings');
        } else {
          this.options.onSessionOption?.(msg.option, msg.value);
        }
        break;
      case 'stopTunnel':
        if (!state.isHost) {
          refuse('error.hostOnlyStopTunnel');
        } else {
          this.options.onTunnelStop?.();
        }
        break;
      case 'reviewQuestion':
        if (!state.isHost) {
          refuse('error.hostOnlyReview');
        } else if (!this.reviewQuestion(msg.entryId, msg.accept, state.name)) {
          refuse('error.reviewExpired');
        }
        break;
      case 'answer': {
        // Tout participant peut répondre ; la première réponse l'emporte.
        if (!this.answerQuestion(msg.entryId, msg.toolId, msg.text, state.name)) {
          refuse('error.answerExpired');
        }
        break;
      }
    }
  }

  // ---- API utilisée par l'extension ----

  get participantList(): Participant[] {
    // Plusieurs connexions pour un même participant (vue et onglets de VS Code) : une seule entrée.
    const byId = new Map<string, Participant>();
    for (const c of this.clients.values()) {
      if (!c.joined) {
        continue;
      }
      const known = byId.get(c.clientId);
      if (!known) {
        byId.set(c.clientId, { clientId: c.clientId, name: c.name, isHost: c.isHost, viewing: c.viewing });
      } else if (c.viewing) {
        const all = new Set([...(known.viewingAll ?? (known.viewing ? [known.viewing] : [])), c.viewing]);
        known.viewing ??= c.viewing;
        known.viewingAll = [...all];
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
    void this.measureContext(conversationId);
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

  /**
   * Applique une décision sur une action en attente (appel de l'extension : décision de l'hôte).
   * Renvoie false si l'action n'attend plus.
   */
  resolveApproval(entryId: string, toolId: string, decision: ApprovalDecision, by: string): boolean {
    const k = key(entryId, toolId);
    const waiter = this.approvals.get(k);
    if (!waiter) {
      return false;
    }
    this.approvals.delete(k);
    waiter.resolve({ decision, by });
    return true;
  }

  /** Motif de refus si ce participant ne peut pas prendre cette décision, sinon undefined. */
  private approvalRefusal(state: ClientState, entryId: string, toolId: string, decision: ApprovalDecision): RoomKey | undefined {
    const waiter = this.approvals.get(key(entryId, toolId));
    const approval = waiter?.info.tool.approval;
    if (!approval) {
      return 'error.approvalExpired';
    }
    if (state.isHost) {
      return undefined;
    }
    const answer = this.entries.find((e) => e.id === entryId);
    const question = answer?.kind === 'assistant' ? this.entries.find((e) => e.id === answer.replyTo) : undefined;
    const isRequester = question?.kind === 'user' && question.clientId === state.clientId;
    if (!isRequester) {
      return 'error.approvalNotAllowed';
    }
    if (approval.hostOnly) {
      return 'error.approvalHostOnly';
    }
    if (decision === 'session') {
      return 'error.approvalSessionHostOnly';
    }
    return undefined;
  }

  /** Transmet la réponse à une question de l'agent. Renvoie false si elle n'attend plus (ou réponse vide). */
  answerQuestion(entryId: string, toolId: string, text: string, by: string): boolean {
    const k = key(entryId, toolId);
    const waiter = this.questions.get(k);
    const answer = text.trim().slice(0, LIMITS.maxAnswerLength);
    if (!waiter || !answer) {
      return false;
    }
    this.questions.delete(k);
    waiter.resolve({ text: answer, by });
    return true;
  }

  /**
   * Accepte (envoi au modèle) ou refuse une question d'invité en attente.
   * Renvoie false si elle n'attend plus.
   */
  reviewQuestion(entryId: string, accept: boolean, by: string): boolean {
    const index = this.awaitingReview.findIndex((q) => q.entryId === entryId);
    const entry = this.entries.find((e): e is UserEntry => e.kind === 'user' && e.id === entryId);
    if (index < 0 || !entry) {
      return false;
    }
    const [item] = this.awaitingReview.splice(index, 1);
    entry.review = accept ? 'approved' : 'rejected';
    entry.reviewedBy = by;
    this.broadcast({ type: 'questionReview', entryId, review: entry.review, by });
    if (accept) {
      // L'accord explicite de l'hôte l'emporte sur la limite horaire.
      this.guestSent.push(Date.now());
      this.queue.push(item);
      this.broadcastQueue();
      this.pump();
    }
    return true;
  }

  /**
   * Met en file le compactage d'une discussion : le modèle résume ses échanges, et ce
   * résumé remplace, pour la suite, l'historique envoyé au modèle. Renvoie un motif de refus
   * dans la langue `lang` (par défaut celle de l'hôte).
   */
  compact(conversationId: string, author: string, clientId: string, lang: Lang = this.hostLang()): string | undefined {
    const conv = this.findConversation(conversationId);
    if (!conv) {
      return roomT(lang, 'error.conversationGone');
    }
    if ([...this.queue, ...(this.current ? [this.current.item] : [])].some((q) => q.kind === 'compact' && q.conversationId === conversationId)) {
      return roomT(lang, 'error.compactInProgress');
    }
    if (!this.historyUnits(conversationId).units.length) {
      return roomT(lang, 'error.nothingToCompact');
    }
    this.queue.push({ entryId: newId(), conversationId, clientId, author, text: '', kind: 'compact' });
    this.broadcastQueue();
    this.pump();
    return undefined;
  }

  /**
   * Copie une discussion jusqu'à une entrée (incluse, avec sa réponse s'il s'agit d'une
   * question) dans une nouvelle discussion. Les questions sans réponse ne sont pas copiées.
   * Renvoie un motif de refus dans la langue `lang` (par défaut celle de l'hôte).
   */
  fork(conversationId: string, upToEntryId: string | undefined, author: string, clientId: string, lang: Lang = this.hostLang()): string | undefined {
    const source = this.findConversation(conversationId);
    if (!source) {
      return roomT(lang, 'error.conversationGone');
    }
    if (this.conversations.length >= LIMITS.maxConversations) {
      return roomT(lang, 'error.maxConversations', { max: LIMITS.maxConversations });
    }
    const entries = this.entriesOf(conversationId);
    let end = upToEntryId ? entries.findIndex((e) => e.id === upToEntryId) : entries.length - 1;
    if (end < 0) {
      return roomT(lang, 'error.messageGone');
    }
    const cut = entries[end];
    if (cut.kind === 'user') {
      const answerIndex = entries.findIndex((e) => e.kind === 'assistant' && e.replyTo === cut.id);
      end = Math.max(end, answerIndex);
    }
    const answered = new Set(
      entries.filter((e): e is AssistantEntry => e.kind === 'assistant' && e.status !== 'streaming').map((e) => e.replyTo),
    );
    const ids = new Map<string, string>();
    const copies: ChatEntry[] = [];
    for (const e of entries.slice(0, end + 1)) {
      if (e.kind === 'system' || (e.kind === 'user' && !answered.has(e.id)) || (e.kind === 'assistant' && (e.status === 'streaming' || !ids.has(e.replyTo)))) {
        continue;
      }
      const id = newId();
      ids.set(e.id, id);
      const copy = structuredClone(e);
      copy.id = id;
      if (copy.kind === 'assistant') {
        copy.replyTo = ids.get(e.kind === 'assistant' ? e.replyTo : '')!;
      }
      copies.push(copy);
    }
    const conv: ConversationState = {
      id: newId(),
      title: sanitizeLine(roomT(lang, 'conv.forkTitle', { title: source.title || roomT(lang, 'conv.untitled') }), LIMITS.maxTitleLength),
      createdAt: Date.now(),
      createdBy: author,
      createdByClientId: clientId,
      autoTitle: false,
      forkedFrom: source.id,
    };
    for (const copy of copies) {
      copy.conversationId = conv.id;
    }
    this.conversations.push(conv);
    // Les entrées d'abord : la page de l'auteur ouvre la discussion dès son annonce.
    for (const copy of copies) {
      this.pushEntry(copy);
    }
    this.broadcastConversation(conv);
    void this.measureContext(conv.id);
    return undefined;
  }

  /** Met à jour l'état du tunnel et le transmet aux pages de l'hôte. */
  setTunnelState(tunnel: TunnelState): void {
    this.tunnel = tunnel;
    for (const [conn, state] of this.clients) {
      if (state.joined && state.isHost) {
        conn.send({ type: 'tunnel', tunnel });
      }
    }
  }

  /** Partage une application locale de l'hôte. Renvoie un motif de refus (dans la langue `lang`, par défaut celle de l'hôte), ou undefined. */
  shareApp(port: number, rawLabel?: string, lang: Lang = this.hostLang()): string | undefined {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return roomT(lang, 'error.invalidPort');
    }
    const refusal = this.options.appRefusal?.(port);
    if (refusal) {
      return typeof refusal === 'string' ? refusal : renderRoomText(lang, refusal);
    }
    if (!this.apps.has(port) && this.apps.size >= LIMITS.maxSharedApps) {
      return roomT(lang, 'error.maxSharedApps', { max: LIMITS.maxSharedApps });
    }
    const label = sanitizeLine(rawLabel ?? '', LIMITS.maxTitleLength) || `localhost:${port}`;
    this.apps.set(port, { port, label });
    this.broadcastApps();
    return undefined;
  }

  unshareApp(port: number): void {
    if (this.apps.delete(port)) {
      this.broadcastApps();
    }
  }

  isAppShared(port: number): boolean {
    return this.apps.has(port);
  }

  get sharedApps(): SharedApp[] {
    return [...this.apps.values()];
  }

  private broadcastApps(): void {
    const apps = this.sharedApps;
    this.broadcast({ type: 'sharedApps', apps });
    this.options.onAppsChanged?.(apps);
  }

  /** Discussion d'une entrée, si elle existe encore. */
  conversationOfEntry(entryId: string): string | undefined {
    return this.entries.find((e) => e.id === entryId)?.conversationId;
  }

  /** Questions d'invités en attente de l'accord de l'hôte. */
  get awaitingReviewIds(): string[] {
    return this.awaitingReview.map((q) => q.entryId);
  }

  /** Question d'invité en attente de l'accord de l'hôte (pour l'extension). */
  awaitingReviewOf(entryId: string): boolean {
    return this.awaitingReview.some((q) => q.entryId === entryId);
  }

  /** Diffuse les règles de la session (après un changement de réglage). */
  broadcastPolicy(): void {
    this.broadcast({ type: 'policy', policy: this.policy() });
  }

  /** Actions en attente de validation (pour l'extension). */
  pendingApproval(entryId: string, toolId: string): ToolActivity | undefined {
    return this.approvals.get(key(entryId, toolId))?.info.tool;
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
   * ou lève une Error si elle est refusée (message dans la langue de l'hôte, `i18n` pour la traduire).
   */
  askAsHost(conversationId: string, text: string, author: string, modelId?: string): string {
    const lang = this.hostLang();
    const state: ClientState = { clientId: LOCAL_HOST_CLIENT_ID, name: author, isHost: true, viewing: null, joined: true, lang };
    let error: I18nText | undefined;
    const knownModel = modelId && this.models.available.some((m) => m.id === modelId) ? modelId : undefined;
    const id = this.enqueueQuestion(state, conversationId, text, knownModel, (m) => (error = m));
    if (!id) {
      const refusal: I18nText = error ?? roomText('error.emptyQuestion');
      throw Object.assign(new Error(renderRoomText(lang, refusal)), { i18n: refusal });
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
      this.addSystemMessage(entryId, 'system.questionRemoved');
      this.broadcastQueue();
    }
  }

  /** Met à jour la liste des modèles proposés et la diffuse. */
  setModels(models: ModelsState): void {
    const changedDefault = models.defaultId !== this.models.defaultId;
    this.models = models;
    this.broadcast({ type: 'models', models });
    // La jauge dépend du modèle par défaut (taille maximale, tokenizer).
    if (changedDefault) {
      for (const conv of this.conversations) {
        void this.measureContext(conv.id);
      }
    }
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
    this.awaitingReview.length = 0;
    this.apps.clear();
    this.entries.length = 0;
    this.conversations.length = 0;
    this.clients.clear();
    this.listeners.clear();
  }

  // ---- Gestion des messages ----

  private handleHello(conn: Connection, state: ClientState, rawName: string, rawClientId: string): void {
    const name = sanitizeLine(rawName, LIMITS.maxNameLength);
    if (!name) {
      conn.send({ type: 'error', message: roomT(state.lang, 'error.invalidName') });
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
      policy: this.policy(),
      apps: this.sharedApps,
    });
    if (state.isHost) {
      conn.send({ type: 'tunnel', tunnel: this.tunnel });
    }
    this.broadcastParticipants();
  }

  /** Valide et met en file une question. Renvoie l'id de la question, ou undefined si refusée. */
  private enqueueQuestion(
    state: ClientState,
    conversationId: string,
    rawText: string,
    rawModelId: string | undefined,
    fail: (refusal: I18nText) => void,
  ): string | undefined {
    const conv = this.findConversation(conversationId);
    if (!conv) {
      fail(roomText('error.conversationGone'));
      return undefined;
    }
    const text = rawText.trim();
    if (!text) {
      return undefined;
    }
    if (text.length > LIMITS.maxQuestionLength) {
      fail(roomText('error.questionTooLong', { max: LIMITS.maxQuestionLength }));
      return undefined;
    }
    let modelId: string | undefined;
    if (rawModelId) {
      if (!state.isHost && !this.models.guestsCanChoose) {
        fail(roomText('error.modelFixed'));
        return undefined;
      }
      if (!this.models.available.some((m) => m.id === rawModelId)) {
        fail(roomText('error.modelUnavailable'));
        return undefined;
      }
      modelId = rawModelId;
    }
    const pendingForClient = [...this.queue, ...this.awaitingReview].filter((q) => q.clientId === state.clientId).length;
    if (pendingForClient >= LIMITS.maxPendingPerClient) {
      fail(roomText('error.tooManyPending', { count: pendingForClient }));
      return undefined;
    }
    const policy = this.policy();
    const review = !state.isHost && policy.reviewGuestQuestions;
    if (!state.isHost) {
      const refusal = this.guestLimitRefusal(policy);
      if (refusal) {
        fail(refusal);
        return undefined;
      }
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
      ...(review ? { review: 'pending' as const } : {}),
    };
    this.pushEntry(entry);
    if (conv.autoTitle) {
      conv.title = sanitizeLine(text, LIMITS.maxTitleLength) || conv.title;
      conv.autoTitle = false;
      this.broadcastConversation(conv);
    }
    const item: QueuedQuestion = { entryId: entry.id, conversationId, clientId: state.clientId, author: state.name, text, modelId };
    if (review) {
      this.awaitingReview.push(item);
      this.options.onReviewRequested?.({
        entryId: entry.id,
        conversationId,
        author: state.name,
        text,
        modelName: modelId ? this.models.available.find((m) => m.id === modelId)?.name : undefined,
      });
      return entry.id;
    }
    if (!state.isHost) {
      this.guestSent.push(Date.now());
    }
    this.queue.push(item);
    this.broadcastQueue();
    this.pump();
    return entry.id;
  }

  private policy(): SessionPolicy {
    return this.options.policy?.() ?? { reviewGuestQuestions: false, guestQuestionsPerHour: 0 };
  }

  /**
   * Limite horaire des questions d'invités, pour toute la session (un invité peut changer
   * d'identifiant client). Les questions en attente de l'hôte comptent déjà.
   */
  private guestLimitRefusal(policy: SessionPolicy): I18nText | undefined {
    const limit = Math.floor(policy.guestQuestionsPerHour);
    if (limit <= 0) {
      return undefined;
    }
    const now = Date.now();
    removeWhere(this.guestSent, (t) => now - t >= HOUR_MS);
    if (this.guestSent.length + this.awaitingReview.length < limit) {
      return undefined;
    }
    const minutes = this.guestSent.length ? Math.max(1, Math.ceil((this.guestSent[0] + HOUR_MS - now) / 60_000)) : undefined;
    return minutes ? roomText('error.guestLimitWait', { limit, minutes }) : roomText('error.guestLimitPending', { limit });
  }

  /** Entrée système : `text` dans la langue de l'hôte (repli), `i18n` traduit par chaque page. */
  private systemEntry(conversationId: string, level: 'info' | 'error', key: RoomKey, params?: Params): ChatEntry {
    const i18n = roomText(key, params);
    return { kind: 'system', id: newId(), conversationId, timestamp: Date.now(), level, text: renderRoomText(this.hostLang(), i18n), i18n };
  }

  private addSystemMessage(nearEntryId: string, key: RoomKey, params?: Params): void {
    const near = this.entries.find((e) => e.id === nearEntryId);
    if (near) {
      this.pushEntry(this.systemEntry(near.conversationId, 'info', key, params));
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
    void this.measureContext(conv.id);
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
    removeWhere(this.awaitingReview, (q) => q.conversationId === id);
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
      this.createConversation(roomT(this.hostLang(), 'participant.host'), '');
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
    const run = item.kind === 'compact' ? this.runCompaction(item, abort.signal) : this.answer(item, abort.signal);
    void run.finally(() => {
      void this.measureContext(item.conversationId);
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
        {
          turns,
          modelId: item.modelId ?? this.models.defaultId ?? undefined,
          author: item.author,
          authorClientId: item.clientId,
          interaction: this.interactionFor(entry, signal),
          lang: this.hostLang(),
        },
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
        const i18n = errorText(err);
        entry.error = i18n ? renderRoomText(this.hostLang(), i18n) : err instanceof Error ? err.message : String(err);
        if (i18n) {
          entry.errorI18n = i18n;
        }
      }
    }
    if (!this.disposed) {
      this.broadcast({
        type: 'entryUpdate',
        entryId: entry.id,
        status: entry.status,
        model: entry.model,
        error: entry.error,
        ...(entry.errorI18n ? { errorI18n: entry.errorI18n } : {}),
      });
    }
  }

  private interactionFor(entry: AssistantEntry, signal: AbortSignal): ToolInteraction {
    const wait = <T>(map: Map<string, Waiter<T>>, tool: ToolActivity, onCancel: T, notify: () => void): Promise<T> =>
      new Promise<T>((resolve) => {
        if (signal.aborted) {
          resolve(onCancel);
          return;
        }
        const k = key(entry.id, tool.id);
        const done = (value: T) => {
          signal.removeEventListener('abort', cancel);
          map.delete(k);
          resolve(value);
        };
        const cancel = () => done(onCancel);
        signal.addEventListener('abort', cancel, { once: true });
        map.set(k, { resolve: done, info: { entryId: entry.id, tool } });
        notify();
      });

    return {
      approval: (tool) =>
        wait<ApprovalOutcome>(this.approvals, tool, { decision: 'deny', by: '' }, () =>
          this.options.onApprovalRequested?.({
            entryId: entry.id,
            conversationId: entry.conversationId,
            tool,
            author: entry.replyToAuthor,
          }),
        ),
      answer: (tool) =>
        wait<AnswerOutcome>(this.questions, tool, { text: '', by: '' }, () =>
          this.options.onQuestionAsked?.({ entryId: entry.id, conversationId: entry.conversationId, tool }),
        ),
    };
  }

  /**
   * Construit les messages envoyés au modèle : consigne, puis les N derniers
   * échanges terminés de la même discussion (chaque question suivie de sa
   * réponse), puis la question.
   */
  private buildTurns(question: QueuedQuestion): ModelTurn[] {
    return mergeConsecutive([...this.historyTurns(question.conversationId, question.entryId), { role: 'user', content: `${question.author}: ${question.text}` }]);
  }

  /**
   * Consigne, dernier résumé (compactage) et N derniers échanges : ce que le modèle reçoit
   * avant la question. `excludeEntryId` : la question en cours, à ne pas compter comme échange.
   */
  private historyTurns(conversationId: string, excludeEntryId?: string): ModelTurn[] {
    const { units, summary } = this.historyUnits(conversationId, excludeEntryId);
    const limit = Math.max(0, Math.floor(this.options.historyLength()));
    const recent = limit === 0 ? [] : units.slice(-limit);
    const extra = this.options.extraInstructions?.();
    return [
      { role: 'user', content: extra ? `${SYSTEM_PROMPT}\n\n${extra}` : SYSTEM_PROMPT },
      ...(summary ? [{ role: 'user' as const, content: `${SUMMARY_PREFIX}\n${summary.text}` }] : []),
      ...recent.flat(),
    ];
  }

  /** Échanges terminés depuis le dernier résumé (une « unité » = question + réponse, ou contexte partagé). */
  private historyUnits(conversationId: string, excludeEntryId?: string): { units: ModelTurn[][]; summary?: SummaryEntry } {
    const all = this.entries.filter((e) => e.conversationId === conversationId);
    let start = 0;
    let summary: SummaryEntry | undefined;
    all.forEach((e, i) => {
      if (e.kind === 'summary') {
        summary = e;
        start = i + 1;
      }
    });
    const entries = all.slice(start);
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
      } else if (e.kind === 'user' && e.id !== excludeEntryId) {
        const answer = answers.get(e.id);
        if (!answer || answer.status === 'streaming' || answer.status === 'error' || !answer.text) {
          continue;
        }
        const reply = answer.status === 'cancelled' ? `${answer.text}\n\n[answer interrupted]` : answer.text;
        units.push([
          { role: 'user', content: `${e.author}: ${e.text}` },
          { role: 'assistant', content: reply },
        ]);
      }
    }

    return { units, summary };
  }

  /** Compactage : le modèle résume les échanges depuis le dernier résumé, sans outils. */
  private async runCompaction(item: QueuedQuestion, signal: AbortSignal): Promise<void> {
    const { units, summary } = this.historyUnits(item.conversationId);
    const transcript = units
      .flat()
      .map((t) => (t.role === 'assistant' ? `Assistant: ${t.content}` : t.content))
      .join('\n\n');
    const before = this.findConversation(item.conversationId)?.context?.tokens;
    const content = [COMPACT_PROMPT, summary ? `Previous summary (to integrate):\n${summary.text}` : '', `Exchanges:\n${transcript}`]
      .filter(Boolean)
      .join('\n\n');
    try {
      const response = await this.backend.ask(
        {
          turns: [{ role: 'user', content }],
          modelId: this.models.defaultId ?? undefined,
          author: item.author,
          authorClientId: item.clientId,
          interaction: { approval: async () => ({ decision: 'deny', by: '' }), answer: async () => ({ text: '', by: '' }) },
          noTools: true,
          lang: this.hostLang(),
        },
        signal,
      );
      let text = '';
      for await (const event of response.events) {
        if (signal.aborted || this.disposed) {
          return;
        }
        if (event.type === 'text') {
          text += event.text;
        }
      }
      if (!text.trim() || !this.findConversation(item.conversationId)) {
        throw new I18nError('system.compactEmpty');
      }
      this.pushEntry({
        kind: 'summary',
        id: newId(),
        conversationId: item.conversationId,
        timestamp: Date.now(),
        author: item.author,
        text: text.trim(),
        model: response.modelName,
        before,
      });
    } catch (err) {
      if (!signal.aborted && this.findConversation(item.conversationId)) {
        const i18n = errorText(err);
        this.pushEntry(
          i18n?.key === 'system.compactEmpty'
            ? this.systemEntry(item.conversationId, 'error', 'system.compactEmpty')
            : this.systemEntry(item.conversationId, 'error', 'system.compactFailed', {
                // Erreur du modèle : rendue dans la langue de l'hôte (pas de traduction imbriquée).
                error: i18n ? renderRoomText(this.hostLang(), i18n) : err instanceof Error ? err.message : String(err),
              }),
        );
      }
    }
  }

  /** Mesure le contexte de la prochaine question de la discussion (jauge), si le modèle le permet. */
  private async measureContext(conversationId: string): Promise<void> {
    const conv = this.findConversation(conversationId);
    if (!conv || !this.backend.measure || this.disposed) {
      return;
    }
    const run = (conv.measuring ?? 0) + 1;
    conv.measuring = run;
    try {
      const usage = await this.backend.measure(mergeConsecutive(this.historyTurns(conversationId)), this.models.defaultId ?? undefined);
      if (usage && conv.measuring === run && this.findConversation(conversationId) && !this.disposed) {
        conv.context = usage;
        this.broadcastConversation(conv);
      }
    } catch {
      // Mesure indisponible : la jauge garde sa dernière valeur.
    }
  }

  private queueState(): QueueState {
    const strip = ({ entryId, conversationId, clientId, author, kind }: QueueItem): QueueItem => ({
      entryId,
      conversationId,
      clientId,
      author,
      ...(kind ? { kind } : {}),
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
      return str(m.name) && str(m.clientId)
        ? { type: 'hello', name: m.name, clientId: m.clientId, lang: isLang(m.lang) ? m.lang : undefined }
        : undefined;
    case 'setLang':
      return isLang(m.lang) ? { type: 'setLang', lang: m.lang } : undefined;
    case 'ask':
      if (!str(m.text) || !str(m.conversationId) || (m.modelId !== undefined && !str(m.modelId))) {
        return undefined;
      }
      return { type: 'ask', conversationId: m.conversationId, text: m.text, modelId: m.modelId || undefined };
    case 'cancel':
      return { type: 'cancel' };
    case 'view':
      return str(m.conversationId) ? { type: 'view', conversationId: m.conversationId } : undefined;
    case 'typing':
      return str(m.conversationId) ? { type: 'typing', conversationId: m.conversationId } : undefined;
    case 'invite':
      return m.publicUrl === undefined || str(m.publicUrl)
        ? { type: 'invite', publicUrl: m.publicUrl as string | undefined, copy: m.copy === true }
        : undefined;
    case 'createConversation':
      return { type: 'createConversation' };
    case 'renameConversation':
      return str(m.conversationId) && str(m.title)
        ? { type: 'renameConversation', conversationId: m.conversationId, title: m.title }
        : undefined;
    case 'deleteConversation':
      return str(m.conversationId) ? { type: 'deleteConversation', conversationId: m.conversationId } : undefined;
    case 'approve':
      return str(m.entryId) && str(m.toolId) && (m.decision === 'once' || m.decision === 'session' || m.decision === 'deny')
        ? { type: 'approve', entryId: m.entryId, toolId: m.toolId, decision: m.decision }
        : undefined;
    case 'showDiff':
      return str(m.entryId) && str(m.toolId) ? { type: 'showDiff', entryId: m.entryId, toolId: m.toolId } : undefined;
    case 'shareApp':
      return typeof m.port === 'number' && (m.label === undefined || str(m.label))
        ? { type: 'shareApp', port: m.port, label: m.label as string | undefined }
        : undefined;
    case 'unshareApp':
      return typeof m.port === 'number' ? { type: 'unshareApp', port: m.port } : undefined;
    case 'startTunnel':
      return m.provider === undefined || m.provider === 'cloudflare' || m.provider === 'ngrok'
        ? { type: 'startTunnel', provider: m.provider }
        : undefined;
    case 'stopTunnel':
      return { type: 'stopTunnel' };
    case 'compact':
      return str(m.conversationId) ? { type: 'compact', conversationId: m.conversationId } : undefined;
    case 'fork':
      return str(m.conversationId) && (m.upToEntryId === undefined || str(m.upToEntryId))
        ? { type: 'fork', conversationId: m.conversationId, upToEntryId: m.upToEntryId as string | undefined }
        : undefined;
    case 'setSessionOption':
      return (m.option === 'guestModelChoice' || m.option === 'reviewGuestQuestions') && typeof m.value === 'boolean'
        ? { type: 'setSessionOption', option: m.option, value: m.value }
        : undefined;
    case 'reviewQuestion':
      return str(m.entryId) && typeof m.accept === 'boolean' ? { type: 'reviewQuestion', entryId: m.entryId, accept: m.accept } : undefined;
    case 'answer':
      return str(m.entryId) && str(m.toolId) && str(m.text)
        ? { type: 'answer', entryId: m.entryId, toolId: m.toolId, text: m.text }
        : undefined;
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

function publicConversation({ id, title, createdAt, createdBy, createdByClientId, context, forkedFrom }: ConversationState): Conversation {
  return { id, title, createdAt, createdBy, createdByClientId, ...(context ? { context } : {}), ...(forkedFrom ? { forkedFrom } : {}) };
}

function formatContext(e: ContextEntry): string {
  const where = e.range ? `${e.fileName} (${e.range})` : e.fileName;
  return `[Shared context from ${e.author}: ${where}]\n\`\`\`${e.languageId}\n${e.code}\n\`\`\``;
}

/** Texte traduisible d'une erreur (I18nError, ou Error portant un champ `i18n`). */
function errorText(err: unknown): I18nText | undefined {
  if (err instanceof I18nError) {
    return err.i18n;
  }
  const i18n = (err as { i18n?: unknown } | null)?.i18n;
  return i18n && typeof i18n === 'object' && typeof (i18n as I18nText).key === 'string' ? (i18n as I18nText) : undefined;
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

function key(entryId: string, toolId: string): string {
  return `${entryId}/${toolId}`;
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
