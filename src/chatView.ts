import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { WebSocket } from 'ws';

/**
 * Le chat dans VS Code, sous forme de vue (barre latérale « Shared Copilot ») :
 * accueil (héberger / rejoindre), puis la même page de chat que dans un navigateur.
 * La page ne se connecte pas elle-même : l'extension tient le WebSocket (vers le
 * serveur local de l'hôte, ou vers la session d'un autre via son tunnel) et relaie
 * les messages. Rejoindre une session ne demande donc pas de navigateur.
 */

export type ViewMode = 'idle' | 'host' | 'guest';

export interface ViewState {
  mode: ViewMode;
  name: string;
  /** Message affiché sur l'accueil (démarrage en cours, erreur…). */
  status?: string;
  error?: boolean;
  busy?: boolean;
}

export interface ConnectionTarget {
  url: string;
  headers: Record<string, string>;
}

export interface ChatController {
  state(): ViewState;
  /** Où se connecter pour la session affichée (serveur local de l'hôte, ou tunnel pour un invité). */
  connectionTarget(): ConnectionTarget | undefined;
  host(name: string): Promise<void>;
  join(name: string, link: string): Promise<void>;
  /** `ended` : la session est déjà terminée, on revient simplement à l'accueil. */
  leave(ended: boolean): Promise<void>;
}

/** Code de fermeture relayé à la page quand la connexion est refusée (lien invalide, session arrêtée). */
const CLOSE_REFUSED = 4401;

type PageMessage =
  | { type: 'scc-ready' }
  | { type: 'scc-host'; name?: string }
  | { type: 'scc-join'; name?: string; link?: string }
  | { type: 'scc-leave'; ended?: boolean }
  | { type: 'scc-connect'; id: string }
  | { type: 'scc-send'; id: string; data: string }
  | { type: 'scc-disconnect'; id: string };

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'sharedCopilotChat.view';
  private view: vscode.WebviewView | undefined;
  private readonly sockets = new Map<string, WebSocket>();
  private template: string | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.log('Vue : affichée.');
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media'), vscode.Uri.joinPath(this.extensionUri, 'dist', 'web')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: PageMessage) => this.onMessage(msg));
    view.onDidDispose(() => {
      this.closeAll();
      this.view = undefined;
    });
  }

  /** Affiche la vue (et ouvre la barre latérale si besoin). */
  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  }

  /** Transmet l'état courant à la page (accueil ou chat). */
  postState(): void {
    void this.view?.webview.postMessage({ type: 'scc-state', ...this.controller.state() });
  }

  /** Repart d'une page neuve (retour à l'accueil après une session). */
  reset(): void {
    this.closeAll();
    if (this.view) {
      this.view.webview.html = this.html(this.view.webview);
    }
  }

  dispose(): void {
    this.closeAll();
  }

  private onMessage(msg: PageMessage): void {
    if (msg.type !== 'scc-send') {
      this.log(`Vue : ${msg.type}`);
    }
    switch (msg.type) {
      case 'scc-ready':
        this.postState();
        break;
      case 'scc-host':
        void this.controller.host(msg.name ?? '');
        break;
      case 'scc-join':
        void this.controller.join(msg.name ?? '', msg.link ?? '');
        break;
      case 'scc-leave':
        void this.controller.leave(!!msg.ended);
        break;
      case 'scc-connect':
        this.connect(msg.id);
        break;
      case 'scc-send':
        this.sockets.get(msg.id)?.send(msg.data);
        break;
      case 'scc-disconnect':
        this.sockets.get(msg.id)?.close();
        this.sockets.delete(msg.id);
        break;
    }
  }

  private connect(id: string): void {
    const post = (message: object) => void this.view?.webview.postMessage({ ...message, id });
    const target = this.controller.connectionTarget();
    if (!target) {
      post({ type: 'scc-close', code: CLOSE_REFUSED, reason: 'Aucune session à rejoindre.' });
      return;
    }
    let lastError = '';
    let finished = false;
    const finish = (code: number, reason: string) => {
      if (!finished) {
        finished = true;
        this.sockets.delete(id);
        post({ type: 'scc-close', code, reason });
      }
    };
    this.log(`Vue : connexion à ${target.url.replace(/token=[^&]*/, 'token=…')}`);
    const ws = new WebSocket(target.url, { headers: target.headers, handshakeTimeout: 15_000 });
    this.sockets.set(id, ws);
    ws.on('open', () => {
      this.log('Vue : connectée.');
      post({ type: 'scc-open' });
    });
    ws.on('message', (data) => post({ type: 'scc-recv', data: data.toString() }));
    // Réponse HTTP au lieu d'un WebSocket : lien invalide, session arrêtée, tunnel fermé…
    ws.on('unexpected-response', (req, res) => {
      req.destroy();
      finish(
        CLOSE_REFUSED,
        res.statusCode === 401
          ? 'Accès refusé : lien d’invitation invalide ou session terminée.'
          : `Impossible de rejoindre la session (réponse HTTP ${res.statusCode}) : vérifiez le lien et que l’hôte a bien ouvert son tunnel.`,
      );
    });
    ws.on('error', (err) => {
      lastError = err.message;
      this.log(`Vue : erreur de connexion (${err.message}).`);
    });
    ws.on('close', (code, reason) => {
      this.log(`Vue : connexion fermée (${code}${reason.length ? `, ${reason.toString()}` : ''}).`);
      finish(code, reason.toString() || lastError);
    });
  }

  private closeAll(): void {
    for (const ws of this.sockets.values()) {
      ws.close();
    }
    this.sockets.clear();
  }

  /** Page du chat avec les ressources de l'extension et une politique de sécurité stricte. */
  private html(webview: vscode.Webview): string {
    this.template ??= fs.readFileSync(vscode.Uri.joinPath(this.extensionUri, 'media', 'index.html').fsPath, 'utf8');
    const nonce = crypto.randomBytes(16).toString('base64');
    const asset = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...parts)).toString();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return this.template
      .replace('codicon.css?token=__TOKEN__', asset('dist', 'web', 'codicon.css'))
      .replace('style.css?token=__TOKEN__', asset('media', 'style.css'))
      .replace('<script src="client.js?token=__TOKEN__">', `<script nonce="${nonce}" src="${asset('dist', 'web', 'client.js')}">`)
      .replace('<head>', `<head>\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`);
  }
}

/** Analyse un lien d'invitation ; renvoie la cible WebSocket, ou un message d'erreur. */
export function inviteTarget(link: string): ConnectionTarget | string {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return "Lien d'invitation invalide : collez le lien complet reçu de l'hôte (https://…/?token=…).";
  }
  const token = url.searchParams.get('token');
  if (!/^https?:$/.test(url.protocol) || !token) {
    return "Lien d'invitation invalide : il doit commencer par http(s):// et contenir « ?token=… ».";
  }
  const ws = new URL(url.toString());
  ws.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  ws.pathname = `${url.pathname.replace(/[^/]*$/, '')}ws`;
  ws.search = '';
  ws.hash = '';
  ws.searchParams.set('token', token);
  // ngrok (offre gratuite) affiche une page d'avertissement aux navigateurs : cet en-tête la contourne.
  return { url: ws.toString(), headers: { 'ngrok-skip-browser-warning': 'true' } };
}
