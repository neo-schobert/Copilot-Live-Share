import * as crypto from 'crypto';
import * as http from 'http';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import { CLOSE_CODES, LIMITS, ServerMessage, WS_PATH } from './protocol';

/**
 * Serveur HTTP + WebSocket local. Ne connaît rien du chat lui-même : il sert
 * les fichiers statiques, authentifie chaque requête par token et délègue les
 * messages WebSocket à un {@link ConnectionHandler}.
 */

export interface StaticAsset {
  contentType: string;
  body: string | Buffer;
}

export interface ServerOptions {
  port: number;
  /** Token donné aux invités. */
  guestToken: string;
  /** Token réservé à l'hôte (webview), qui donne le droit d'annuler. */
  hostToken: string;
  /** Page servie sur « / » ; `__TOKEN__` y est remplacé par le token de la requête. */
  indexHtml: string;
  /** Fichiers servis par chemin (ex. « /client.js »). */
  assets: Record<string, StaticAsset>;
}

export interface Connection {
  readonly id: string;
  readonly isHost: boolean;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

export interface ConnectionHandler {
  onOpen(conn: Connection): void;
  onMessage(conn: Connection, data: string): void;
  onClose(conn: Connection): void;
}

const HEARTBEAT_MS = 30_000;
const LISTEN_HOST = '127.0.0.1';

type Role = 'host' | 'guest';

class WsConnection implements Connection {
  alive = true;

  constructor(
    readonly id: string,
    readonly isHost: boolean,
    readonly socket: WebSocket,
  ) {}

  send(msg: ServerMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  close(code: number, reason: string): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(code, reason);
    }
  }
}

export class ChatServer {
  private readonly http: http.Server;
  private readonly wss: WebSocketServer;
  private readonly connections = new Set<WsConnection>();
  private heartbeat: NodeJS.Timeout | undefined;
  private nextId = 1;

  constructor(
    private readonly options: ServerOptions,
    private readonly handler: ConnectionHandler,
  ) {
    this.http = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxPayloadBytes });
    this.http.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  get port(): number {
    const addr = this.http.address();
    return typeof addr === 'object' && addr ? addr.port : this.options.port;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.http.once('error', onError);
      this.http.listen(this.options.port, LISTEN_HOST, () => {
        this.http.off('error', onError);
        this.heartbeat = setInterval(() => this.checkAlive(), HEARTBEAT_MS);
        resolve();
      });
    });
  }

  /** Ferme toutes les connexions puis arrête le serveur. */
  async stop(reason: string): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    for (const conn of this.connections) {
      conn.close(CLOSE_CODES.sessionEnded, reason);
    }
    // Laisse une chance aux fermetures propres, puis coupe ce qui traîne.
    await new Promise((r) => setTimeout(r, 250));
    for (const conn of this.connections) {
      conn.socket.terminate();
    }
    this.connections.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => {
      if (!this.http.listening) {
        resolve();
        return;
      }
      this.http.close(() => resolve());
      this.http.closeAllConnections();
    });
  }

  private roleForToken(token: string | null): Role | undefined {
    if (!token) {
      return undefined;
    }
    if (safeEqual(token, this.options.hostToken)) {
      return 'host';
    }
    if (safeEqual(token, this.options.guestToken)) {
      return 'guest';
    }
    return undefined;
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token');
    const role = this.roleForToken(token);

    // Aucun fichier n'est servi sans token valide, y compris les assets.
    if (!role || !token) {
      send(res, 401, 'text/plain; charset=utf-8', 'Unauthorized: missing or invalid token.\n');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed\n');
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = this.options.indexHtml.replace(/__TOKEN__/g, () => encodeURIComponent(token));
      send(res, 200, 'text/html; charset=utf-8', html, {
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'",
      });
      return;
    }

    const asset = this.options.assets[url.pathname];
    if (asset) {
      send(res, 200, asset.contentType, asset.body);
      return;
    }
    send(res, 404, 'text/plain; charset=utf-8', 'Not Found\n');
  }

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const role = url.pathname === `/${WS_PATH}` ? this.roleForToken(url.searchParams.get('token')) : undefined;
    if (!role) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, role === 'host'));
  }

  private onSocket(ws: WebSocket, isHost: boolean): void {
    const conn = new WsConnection(`c${this.nextId++}`, isHost, ws);
    this.connections.add(conn);

    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        conn.close(CLOSE_CODES.protocolError, 'Binary frames are not supported');
        return;
      }
      this.handler.onMessage(conn, data.toString());
    });
    ws.on('close', () => {
      if (this.connections.delete(conn)) {
        this.handler.onClose(conn);
      }
    });
    ws.on('error', () => {
      // L'événement « close » suit toujours ; rien d'autre à faire.
    });

    this.handler.onOpen(conn);
  }

  /** Coupe les sockets qui n'ont pas répondu au ping précédent (clients fantômes derrière un tunnel). */
  private checkAlive(): void {
    for (const conn of this.connections) {
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      conn.socket.ping();
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function send(
  res: http.ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // Le token est dans l'URL : ne jamais le transmettre aux liens externes.
    'Referrer-Policy': 'no-referrer',
    ...extraHeaders,
  });
  res.end(body);
}
