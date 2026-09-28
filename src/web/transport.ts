/**
 * Canal entre la page de chat et le serveur de session :
 * - dans un navigateur, un WebSocket direct ;
 * - dans VS Code (webview), des messages relayés par l'extension, qui tient la
 *   vraie connexion (vers le serveur local de l'hôte, ou vers la session d'un
 *   autre via son tunnel). Pas de navigateur ni de cadre pour rejoindre.
 */

export interface Transport {
  readonly isOpen: boolean;
  send(data: string): boolean;
  close(): void;
}

export interface TransportHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(code: number, reason: string): void;
}

export interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** API de la webview VS Code, ou undefined dans un navigateur. */
export const vscodeApi: VsCodeApi | undefined = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;

export function openWebSocket(url: string, handlers: TransportHandlers): Transport {
  const socket = new WebSocket(url);
  let open = false;
  socket.onopen = () => {
    open = true;
    handlers.onOpen();
  };
  socket.onmessage = (ev) => handlers.onMessage(String(ev.data));
  socket.onclose = (ev) => {
    open = false;
    handlers.onClose(ev.code, ev.reason);
  };
  return {
    get isOpen() {
      return open && socket.readyState === WebSocket.OPEN;
    },
    send(data) {
      if (socket.readyState !== WebSocket.OPEN) {
        return false;
      }
      socket.send(data);
      return true;
    },
    close() {
      socket.close();
    },
  };
}

let nextId = 1;

/** Connexion relayée par l'extension : messages scc-connect / scc-send / scc-disconnect et scc-open / scc-recv / scc-close. */
export function openVsCode(api: VsCodeApi, handlers: TransportHandlers): Transport {
  const id = `t${nextId++}-${Date.now()}`;
  let open = false;
  let closed = false;
  const listener = (event: MessageEvent) => {
    const msg = event.data as { type?: string; id?: string; data?: string; code?: number; reason?: string } | null;
    if (!msg || msg.id !== id || closed) {
      return;
    }
    if (msg.type === 'scc-open') {
      open = true;
      handlers.onOpen();
    } else if (msg.type === 'scc-recv' && typeof msg.data === 'string') {
      handlers.onMessage(msg.data);
    } else if (msg.type === 'scc-close') {
      finish(msg.code ?? 1006, msg.reason ?? '');
    }
  };
  const finish = (code: number, reason: string) => {
    if (closed) {
      return;
    }
    closed = true;
    open = false;
    window.removeEventListener('message', listener);
    handlers.onClose(code, reason);
  };
  window.addEventListener('message', listener);
  api.postMessage({ type: 'scc-connect', id });
  return {
    get isOpen() {
      return open;
    },
    send(data) {
      if (!open) {
        return false;
      }
      api.postMessage({ type: 'scc-send', id, data });
      return true;
    },
    close() {
      api.postMessage({ type: 'scc-disconnect', id });
      finish(1000, '');
    },
  };
}
