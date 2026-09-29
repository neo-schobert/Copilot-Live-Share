import * as net from 'net';
import { WebSocket } from 'ws';
import { TCP_PATH } from './protocol';

/**
 * Invité dans VS Code : rend une application partagée par l'hôte accessible sur sa propre
 * machine, comme les serveurs partagés de Live Share. Un port local (le même que chez
 * l'hôte s'il est libre) accepte les connexions, et chacune est relayée, octet par octet,
 * dans une connexion WebSocket authentifiée vers le serveur de session de l'hôte.
 */

export interface ForwardTarget {
  /** URL WebSocket de la session (…/ws?token=…). */
  url: string;
  headers: Record<string, string>;
}

const LOCAL_HOST = '127.0.0.1';

export class PortForwarder {
  private readonly servers = new Map<number, { server: net.Server; localPort: number }>();
  private readonly sockets = new Set<net.Socket>();

  constructor(
    private readonly target: ForwardTarget,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  /** Port local qui mène à l'application `remotePort` de l'hôte (créé au premier appel). */
  async forward(remotePort: number): Promise<number> {
    const existing = this.servers.get(remotePort);
    if (existing) {
      return existing.localPort;
    }
    const server = net.createServer((socket) => this.relay(socket, remotePort));
    const localPort = await listen(server, remotePort).catch(() => listen(server, 0));
    this.servers.set(remotePort, { server, localPort });
    this.log(`Application partagée : localhost:${localPort} → port ${remotePort} de l'hôte.`);
    return localPort;
  }

  /** Arrête les ports qui ne sont plus partagés par l'hôte. */
  keepOnly(remotePorts: number[]): void {
    for (const [port, { server }] of this.servers) {
      if (!remotePorts.includes(port)) {
        server.close();
        this.servers.delete(port);
      }
    }
  }

  dispose(): void {
    this.keepOnly([]);
    for (const socket of this.sockets) {
      socket.destroy();
    }
  }

  private relay(socket: net.Socket, remotePort: number): void {
    this.sockets.add(socket);
    const url = new URL(this.target.url);
    url.pathname = url.pathname.replace(/[^/]*$/, TCP_PATH);
    url.searchParams.set('port', String(remotePort));
    const ws = new WebSocket(url.toString(), { headers: this.target.headers, perMessageDeflate: false, handshakeTimeout: 15_000 });
    const pending: Buffer[] = [];
    const close = () => {
      this.sockets.delete(socket);
      socket.destroy();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
    socket.on('data', (data) => {
      if (ws.readyState !== WebSocket.OPEN) {
        pending.push(data);
        return;
      }
      // Contrôle de flux : on suspend la lecture tant que le WebSocket a trop de données en attente.
      ws.send(data, { binary: true }, () => {
        if (socket.isPaused() && ws.bufferedAmount < 256 * 1024) {
          socket.resume();
        }
      });
      if (ws.bufferedAmount > 1024 * 1024) {
        socket.pause();
      }
    });
    ws.on('open', () => {
      for (const data of pending.splice(0)) {
        ws.send(data, { binary: true });
      }
    });
    ws.on('message', (data: Buffer) => {
      if (!socket.write(data)) {
        ws.pause();
        socket.once('drain', () => ws.resume());
      }
    });
    ws.on('unexpected-response', (req, res) => {
      this.log(`Application partagée : relais refusé par l'hôte (HTTP ${res.statusCode}).`);
      req.destroy();
      close();
    });
    for (const emitter of [socket, ws]) {
      emitter.on('close', close);
      emitter.on('error', close);
    }
  }
}

function listen(server: net.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, LOCAL_HOST, () => {
      server.off('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}
