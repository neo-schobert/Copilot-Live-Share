/**
 * Messages WebSocket échangés entre le serveur (extension hôte) et la page de chat.
 * Ce fichier est importé par les deux côtés : il ne doit contenir que des types
 * et des constantes, sans dépendance à Node ni au DOM.
 */

export interface Participant {
  clientId: string;
  name: string;
  isHost: boolean;
}

interface BaseEntry {
  id: string;
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

/** Réponse du modèle, remplie au fil du streaming. */
export interface AssistantEntry extends BaseEntry {
  kind: 'assistant';
  /** Id de la question (UserEntry) à laquelle répond cette entrée. */
  replyTo: string;
  replyToAuthor: string;
  text: string;
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

export interface QueueItem {
  /** Id de la UserEntry correspondante. */
  entryId: string;
  clientId: string;
  author: string;
}

export interface QueueState {
  /** Question en cours de traitement par le modèle. */
  current: QueueItem | null;
  /** Questions en attente, dans l'ordre de traitement. */
  pending: QueueItem[];
}

// ---- Client -> serveur ----

export type ClientMessage =
  | { type: 'hello'; name: string; clientId: string }
  | { type: 'ask'; text: string }
  | { type: 'cancel' };

// ---- Serveur -> client ----

export type ServerMessage =
  | {
      type: 'welcome';
      you: Participant;
      history: ChatEntry[];
      participants: Participant[];
      queue: QueueState;
    }
  | { type: 'entry'; entry: ChatEntry }
  | { type: 'chunk'; entryId: string; text: string }
  | {
      type: 'entryUpdate';
      entryId: string;
      status: AssistantStatus;
      model?: string;
      error?: string;
    }
  | { type: 'participants'; participants: Participant[] }
  | { type: 'queue'; queue: QueueState }
  | { type: 'error'; message: string }
  | { type: 'sessionEnded'; reason: string };

export const LIMITS = {
  maxNameLength: 32,
  maxQuestionLength: 8000,
  maxPendingPerClient: 5,
  /** Taille max d'une trame WebSocket entrante, en octets. */
  maxPayloadBytes: 64 * 1024,
} as const;

/** Codes de fermeture WebSocket applicatifs (plage 4000-4999). */
export const CLOSE_CODES = {
  sessionEnded: 4000,
  protocolError: 4002,
} as const;

/** Chemin de l'endpoint WebSocket, relatif à la page. */
export const WS_PATH = 'ws';
