/**
 * Messages WebSocket échangés entre le serveur (extension hôte) et la page de chat.
 * Ce fichier est importé par les deux côtés : il ne doit contenir que des types
 * et des constantes, sans dépendance à Node ni au DOM.
 */

export interface Participant {
  clientId: string;
  name: string;
  isHost: boolean;
  /** Discussion actuellement affichée par ce participant. */
  viewing: string | null;
}

/** Une discussion : un fil de messages avec son propre historique envoyé au modèle. */
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  createdBy: string;
  /** Id client du créateur, pour que son navigateur ouvre la discussion créée. */
  createdByClientId: string;
}

interface BaseEntry {
  id: string;
  conversationId: string;
  /** Horodatage epoch en millisecondes. */
  timestamp: number;
}

/** Question posée par un participant. */
export interface UserEntry extends BaseEntry {
  kind: 'user';
  author: string;
  clientId: string;
  isHost: boolean;
  text: string;
}

export type AssistantStatus = 'streaming' | 'done' | 'cancelled' | 'error';

export type ToolStatus = 'running' | 'awaitingApproval' | 'awaitingAnswer' | 'done' | 'rejected' | 'error';

/** Catégorie d'action sensible ; « Autoriser pour la session » vaut pour toute la catégorie. */
export type ApprovalKind = 'write' | 'command';

export type ApprovalDecision = 'once' | 'session' | 'deny';

/** Demande de validation d'une action sensible, affichée à tous et décidée par l'hôte. */
export interface ApprovalRequest {
  kind: ApprovalKind;
  /** Aperçu lisible : lignes « - »/« + » d'une modification, ou commande. */
  preview: string;
  /** L'hôte peut ouvrir le diff complet dans VS Code. */
  canShowDiff: boolean;
  /**
   * true : action hors du projet, seul l'hôte peut décider. Sinon l'auteur de la
   * demande peut aussi valider (« Autoriser pour la session » reste réservé à l'hôte).
   */
  hostOnly: boolean;
}

/** Question posée par l'agent pendant une réponse : visible par tous, tout participant peut répondre. */
export interface AgentQuestion {
  text: string;
  /** Réponses proposées (peut être vide : réponse libre). */
  options: string[];
  /** Auteur de la demande qui a conduit à cette question (information). */
  requesterClientId: string;
  requesterName: string;
}

/** Action de l'agent dans l'espace de travail de l'hôte (lecture, recherche, modification…). */
export interface ToolActivity {
  id: string;
  /** Description courte, ex. « Lecture de src/app.ts ». */
  title: string;
  status: ToolStatus;
  /** Complément affiché sous le titre (résumé du résultat, commande, erreur). */
  detail?: string;
  approval?: ApprovalRequest;
  question?: AgentQuestion;
  /** Réponse donnée à `question`. */
  answer?: string;
  /** Participant qui a répondu. */
  answeredBy?: string;
}

/** Morceau d'une réponse, dans l'ordre d'affichage : texte ou action d'outil. */
export type AssistantPart = { type: 'text'; text: string } | { type: 'tool'; tool: ToolActivity };

/** Réponse du modèle, remplie au fil du streaming. */
export interface AssistantEntry extends BaseEntry {
  kind: 'assistant';
  /** Id de la question (UserEntry) à laquelle répond cette entrée. */
  replyTo: string;
  replyToAuthor: string;
  /** Texte complet de la réponse (sans les actions d'outils). */
  text: string;
  /** Texte et actions d'outils entrelacés, pour l'affichage. */
  parts: AssistantPart[];
  status: AssistantStatus;
  model?: string;
  error?: string;
}

/** Code partagé par l'hôte depuis son éditeur. */
export interface ContextEntry extends BaseEntry {
  kind: 'context';
  author: string;
  fileName: string;
  languageId: string;
  /** Ex. « lignes 10-24 » ; absent si le fichier entier est partagé. */
  range?: string;
  code: string;
}

/** Message informatif (erreur de modèle, etc.). */
export interface SystemEntry extends BaseEntry {
  kind: 'system';
  level: 'info' | 'error';
  text: string;
}

export type ChatEntry = UserEntry | AssistantEntry | ContextEntry | SystemEntry;

export interface ModelInfo {
  id: string;
  name: string;
  family: string;
}

export interface ModelsState {
  available: ModelInfo[];
  /** Modèle utilisé quand une question n'en précise pas (null : aucun modèle). */
  defaultId: string | null;
  /** Si false, seules les questions de l'hôte peuvent choisir un autre modèle. */
  guestsCanChoose: boolean;
}

export interface QueueItem {
  /** Id de la UserEntry correspondante. */
  entryId: string;
  conversationId: string;
  clientId: string;
  author: string;
}

/** File unique pour toute la session : une seule question traitée à la fois. */
export interface QueueState {
  /** Question en cours de traitement par le modèle. */
  current: QueueItem | null;
  /** Questions en attente, dans l'ordre de traitement. */
  pending: QueueItem[];
}

// ---- Client -> serveur ----

export type ClientMessage =
  | { type: 'hello'; name: string; clientId: string }
  /** `modelId` absent : modèle par défaut de la session. */
  | { type: 'ask'; conversationId: string; text: string; modelId?: string }
  | { type: 'cancel' }
  | { type: 'view'; conversationId: string }
  | { type: 'createConversation' }
  | { type: 'renameConversation'; conversationId: string; title: string }
  /** Réservé à l'hôte. */
  | { type: 'deleteConversation'; conversationId: string }
  /** Réservé à l'hôte : décision sur une action en attente de validation. */
  | { type: 'approve'; entryId: string; toolId: string; decision: ApprovalDecision }
  /** Réservé à l'hôte : ouvre le diff complet dans VS Code. */
  | { type: 'showDiff'; entryId: string; toolId: string }
  /** Le participant est en train d'écrire dans cette discussion (envoyé au plus toutes les 2 s). */
  | { type: 'typing'; conversationId: string }
  /** Réponse à une question de l'agent (par n'importe quel participant). */
  | { type: 'answer'; entryId: string; toolId: string; text: string };

// ---- Serveur -> client ----

export type ServerMessage =
  | {
      type: 'welcome';
      you: Participant;
      conversations: Conversation[];
      /** Entrées de toutes les discussions, dans l'ordre chronologique. */
      history: ChatEntry[];
      participants: Participant[];
      queue: QueueState;
      models: ModelsState;
    }
  /** Discussion créée ou renommée. */
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'conversationDeleted'; conversationId: string }
  | { type: 'entry'; entry: ChatEntry }
  | { type: 'chunk'; entryId: string; text: string }
  /** Action d'outil ajoutée à une réponse, ou mise à jour (même `tool.id`). */
  | { type: 'tool'; entryId: string; tool: ToolActivity }
  | {
      type: 'entryUpdate';
      entryId: string;
      status: AssistantStatus;
      model?: string;
      error?: string;
    }
  | { type: 'participants'; participants: Participant[] }
  | { type: 'queue'; queue: QueueState }
  | { type: 'models'; models: ModelsState }
  /** Un participant écrit dans une discussion (l'indicateur expire côté client). */
  | { type: 'typing'; conversationId: string; clientId: string; name: string }
  | { type: 'error'; message: string }
  | { type: 'sessionEnded'; reason: string };

export const LIMITS = {
  maxNameLength: 32,
  maxTitleLength: 60,
  maxConversations: 50,
  maxQuestionLength: 8000,
  maxAnswerLength: 2000,
  maxPendingPerClient: 5,
  /** Taille max d'une trame WebSocket entrante, en octets. */
  maxPayloadBytes: 64 * 1024,
} as const;

/** Titre d'une discussion tant qu'aucune question n'y a été posée. */
export const DEFAULT_CONVERSATION_TITLE = 'Nouvelle discussion';

/** Codes de fermeture WebSocket applicatifs (plage 4000-4999). */
export const CLOSE_CODES = {
  sessionEnded: 4000,
  protocolError: 4002,
} as const;

/** Chemin de l'endpoint WebSocket, relatif à la page. */
export const WS_PATH = 'ws';
