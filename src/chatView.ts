import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { WebSocket } from 'ws';

/**
 * Le chat dans VS Code, sous forme de vue (barre latérale « Prompt Share ») :
 * accueil (héberger / rejoindre), puis la même page de chat que dans un navigateur.
 * Chaque discussion peut aussi s'ouvrir dans son propre onglet d'éditeur.
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
  /** Ouvre une application partagée par l'hôte (relayée chez un invité). */
  openApp(port: number): Promise<void>;
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
  | { type: 'scc-disconnect'; id: string }
  | { type: 'scc-open-tab'; conversationId: string; title?: string }
  | { type: 'scc-title'; title: string }
  | { type: 'scc-close-panel' }
  | { type: 'scc-open-app'; port: number };

/**
 * Une page de chat dans VS Code (la vue latérale, ou un onglet d'éditeur consacré à une
 * discussion) et les connexions qu'elle fait relayer par l'extension.
 */
class ChatSurface {
  private readonly sockets = new Map<string, WebSocket>();

  constructor(
    readonly webview: vscode.Webview,
    private readonly owner: ChatViewProvider,
    /** Onglet d'éditeur : discussion affichée. Absent : vue latérale. */
    readonly panelConversation?: string,
  ) {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(owner.extensionUri, 'media'), vscode.Uri.joinPath(owner.extensionUri, 'dist', 'web')],
    };
    this.render();
  }

  render(): void {
    this.closeAll();
    this.webview.html = this.owner.html(this.webview);
  }

  postState(): void {
    void this.webview.postMessage({
      type: 'scc-state',
      ...this.owner.controller.state(),
      clientId: this.owner.clientId,
      ...(this.panelConversation ? { panel: { conversationId: this.panelConversation } } : {}),
    });
  }

  /** Envoie un message à la session par une connexion ouverte de cette page. */
  send(data: string): boolean {
    for (const ws of this.sockets.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
        return true;
      }
    }
    return false;
  }

  /** Messages de la page qui concernent ses connexions ; les autres sont traités par le propriétaire. */
  relay(msg: PageMessage): boolean {
    switch (msg.type) {
      case 'scc-connect':
        this.connect(msg.id);
        return true;
      case 'scc-send':
        this.sockets.get(msg.id)?.send(msg.data);
        return true;
      case 'scc-disconnect':
        this.sockets.get(msg.id)?.close();
        this.sockets.delete(msg.id);
        return true;
      default:
        return false;
    }
  }

  closeAll(): void {
    for (const ws of this.sockets.values()) {
      ws.close();
    }
    this.sockets.clear();
  }

  private connect(id: string): void {
    const log = this.owner.log;
    const post = (message: object) => void this.webview.postMessage({ ...message, id });
    const target = this.owner.controller.connectionTarget();
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
    log(`Vue : connexion à ${target.url.replace(/token=[^&]*/, 'token=…')}`);
    const ws = new WebSocket(target.url, { headers: target.headers, handshakeTimeout: 15_000 });
    this.sockets.set(id, ws);
    ws.on('open', () => {
      log('Vue : connectée.');
      post({ type: 'scc-open' });
    });
    ws.on('message', (data) => {
      const text = data.toString();
      post({ type: 'scc-recv', data: text });
      this.owner.onServerMessage?.(text);
    });
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
      log(`Vue : erreur de connexion (${err.message}).`);
    });
    ws.on('close', (code, reason) => {
      log(`Vue : connexion fermée (${code}${reason.length ? `, ${reason.toString()}` : ''}).`);
      finish(code, reason.toString() || lastError);
    });
  }
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'promptShare.view';
  static readonly panelType = 'promptShare.chat';
  /** Identifiant de participant commun à la vue et aux onglets de cette fenêtre. */
  readonly clientId = crypto.randomBytes(12).toString('hex');
  /** Messages reçus de la session par une page (invité dans VS Code : notifications). */
  onServerMessage: ((data: string) => void) | undefined;
  private view: { view: vscode.WebviewView; surface: ChatSurface } | undefined;
  private readonly panels = new Map<string, { panel: vscode.WebviewPanel; surface: ChatSurface }>();
  private template: string | undefined;

  constructor(
    readonly extensionUri: vscode.Uri,
    readonly controller: ChatController,
    readonly log: (message: string) => void = () => undefined,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.log('Vue : affichée.');
    const surface = new ChatSurface(view.webview, this);
    this.view = { view, surface };
    view.webview.onDidReceiveMessage((msg: PageMessage) => this.onMessage(surface, msg));
    view.onDidDispose(() => {
      surface.closeAll();
      this.view = undefined;
    });
  }

  /** Affiche la vue (et ouvre la barre latérale si besoin). */
  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  }

  /** Pastille sur l'icône de la vue (décisions en attente). */
  setBadge(count: number, tooltip: string): void {
    if (this.view) {
      this.view.view.badge = count ? { value: count, tooltip } : undefined;
    }
  }

  /**
   * Ouvre une discussion dans un onglet d'éditeur, qu'on peut déplacer, diviser ou détacher
   * comme les onglets du Chat de VS Code. Déjà ouverte : l'onglet passe au premier plan.
   */
  openTab(conversationId: string, title = 'Discussion'): void {
    const existing = this.panels.get(conversationId);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      ChatViewProvider.panelType,
      title,
      { viewColumn: vscode.ViewColumn.Active },
      { retainContextWhenHidden: true },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png');
    const surface = new ChatSurface(panel.webview, this, conversationId);
    this.panels.set(conversationId, { panel, surface });
    panel.webview.onDidReceiveMessage((msg: PageMessage) => this.onMessage(surface, msg, panel));
    panel.onDidDispose(() => {
      surface.closeAll();
      this.panels.delete(conversationId);
    });
    this.log(`Onglet ouvert pour la discussion ${conversationId}.`);
  }

  /** Discussions ouvertes dans un onglet (tests). */
  get openTabs(): string[] {
    return [...this.panels.keys()];
  }

  /** Transmet l'état courant aux pages (accueil ou chat). */
  postState(): void {
    this.view?.surface.postState();
    for (const { surface } of this.panels.values()) {
      surface.postState();
    }
  }

  /** Envoie un message à la session (invité dans VS Code) par la première connexion ouverte. */
  sendToSession(msg: object): boolean {
    const data = JSON.stringify(msg);
    return [this.view?.surface, ...[...this.panels.values()].map((p) => p.surface)].some((s) => s?.send(data));
  }

  /** Repart d'une page neuve (retour à l'accueil après une session) et ferme les onglets. */
  reset(): void {
    this.view?.surface.render();
    this.closeTabs();
  }

  closeTabs(): void {
    for (const { panel } of [...this.panels.values()]) {
      panel.dispose();
    }
  }

  dispose(): void {
    this.view?.surface.closeAll();
    this.closeTabs();
  }

  private onMessage(surface: ChatSurface, msg: PageMessage, panel?: vscode.WebviewPanel): void {
    if (surface.relay(msg)) {
      return;
    }
    this.log(`Vue : ${msg.type}`);
    switch (msg.type) {
      case 'scc-ready':
        surface.postState();
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
      case 'scc-open-tab':
        this.openTab(msg.conversationId, msg.title);
        break;
      case 'scc-title':
        if (panel && msg.title) {
          panel.title = msg.title;
        }
        break;
      case 'scc-close-panel':
        panel?.dispose();
        break;
      case 'scc-open-app':
        if (Number.isInteger(msg.port)) {
          void this.controller.openApp(msg.port).catch((err: Error) => {
            this.log(`Application partagée : ${err.message}`);
            void vscode.window.showErrorMessage(`Prompt Share : impossible d'ouvrir l'application (${err.message}).`);
          });
        }
        break;
    }
  }

  /** Page du chat avec les ressources de l'extension et une politique de sécurité stricte. */
  html(webview: vscode.Webview): string {
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
