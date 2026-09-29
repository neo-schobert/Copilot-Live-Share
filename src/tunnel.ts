import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TunnelProviderId } from './protocol';
import type { ExtensionKey } from './i18n/extension';
import { t } from './i18n/vscode';

/**
 * Tunnel public vers le serveur local de la session, pour inviter des personnes
 * d'autres machines :
 * - Cloudflare (par défaut) : « tunnel rapide », sans compte ni jeton ;
 * - ngrok : compte gratuit et jeton d'authentification, adresse fixe liée au compte.
 * L'outil est cherché dans le PATH, puis dans le dossier de l'extension ; s'il manque,
 * il est téléchargé depuis sa source officielle avec l'accord de l'hôte.
 */

export type TunnelProvider = TunnelProviderId;

/** Le service est injoignable depuis ce réseau (pare-feu) : un autre fournisseur peut passer. */
export class TunnelUnreachableError extends Error {}

export interface Tunnel {
  provider: TunnelProvider;
  url: string;
  stop(): void;
}

const PROVIDERS: Record<TunnelProvider, { label: string; command: string; source: ExtensionKey }> = {
  cloudflare: { label: 'Cloudflare (cloudflared)', command: 'cloudflared', source: 'tunnel.source.cloudflare' },
  ngrok: { label: 'ngrok', command: 'ngrok', source: 'tunnel.source.ngrok' },
};

const START_TIMEOUT_MS = 45_000;

export class TunnelManager {
  constructor(
    private readonly storage: vscode.Uri,
    private readonly log: (message: string) => void,
  ) {}

  /** Nom lisible d'un fournisseur. */
  static label(provider: TunnelProvider): string {
    return PROVIDERS[provider].label;
  }

  /**
   * Ouvre un tunnel vers `port` (127.0.0.1) : trouve ou télécharge l'outil, authentifie
   * ngrok si besoin, puis attend l'adresse publique. `onExit` est appelé si le tunnel
   * s'arrête de lui-même. Renvoie undefined si l'hôte annule.
   */
  async open(provider: TunnelProvider, port: number, onExit: (reason: string) => void): Promise<Tunnel | undefined> {
    const exe = await this.executable(provider);
    if (!exe) {
      return undefined;
    }
    if (provider === 'ngrok' && !(await this.ensureNgrokAuth(exe))) {
      return undefined;
    }
    const start = () =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('tunnel.progress.opening', { provider: PROVIDERS[provider].label }) },
        () => this.start(provider, exe, port, onExit),
      );
    try {
      return await start();
    } catch (err) {
      // ngrok : jeton refusé ou absent (ERR_NGROK_4018, 105…) : on en redemande un, une fois.
      if (provider === 'ngrok' && /ERR_NGROK_(4018|105|107)|authtoken/i.test(String(err)) && (await this.askNgrokToken(exe, true))) {
        return start();
      }
      throw err;
    }
  }

  // ---- Outil ----

  private async executable(provider: TunnelProvider): Promise<string | undefined> {
    const { command, label, source } = PROVIDERS[provider];
    const local = path.join(this.storage.fsPath, 'bin', process.platform === 'win32' ? `${command}.exe` : command);
    for (const candidate of [command, local]) {
      if (await runs(candidate, provider === 'ngrok' ? ['version'] : ['--version'])) {
        this.log(`Tunnel : ${label} trouvé (${candidate}).`);
        return candidate;
      }
    }
    const asset = downloadAsset(provider);
    if (!asset) {
      void vscode.window.showErrorMessage(
        t('tunnel.unavailable', { tool: label, platform: `${process.platform}/${process.arch}` }),
      );
      return undefined;
    }
    const download = t('tunnel.download.button');
    const choice = await vscode.window.showInformationMessage(
      t('tunnel.download.message', { tool: label }),
      {
        modal: true,
        detail: t(provider === 'cloudflare' ? 'tunnel.download.detail.cloudflare' : 'tunnel.download.detail.ngrok', {
          source: t(source),
          url: asset.url,
          folder: path.dirname(local),
        }),
      },
      download,
    );
    if (choice !== download) {
      return undefined;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('tunnel.progress.downloading', { tool: label }) },
      () => this.download(asset, local),
    );
    if (!(await runs(local, provider === 'ngrok' ? ['version'] : ['--version']))) {
      throw new Error(t('tunnel.error.cannotRun', { tool: label, path: local }));
    }
    this.log(`Tunnel : ${label} téléchargé dans ${local}.`);
    return local;
  }

  private async download(asset: { url: string; archive?: 'tgz' | 'zip' }, target: string): Promise<void> {
    const dir = path.dirname(target);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `download-${process.pid}${asset.archive ? `.${asset.archive}` : ''}`);
    try {
      await fetchToFile(asset.url, tmp);
      if (asset.archive) {
        // tar sait extraire .tgz partout, et .zip avec bsdtar (Windows 10+, macOS).
        await execFileAsync(process.platform === 'win32' ? 'tar.exe' : 'tar', [asset.archive === 'tgz' ? '-xzf' : '-xf', tmp, '-C', dir]);
      } else {
        await fs.promises.rename(tmp, target);
      }
      if (process.platform !== 'win32') {
        await fs.promises.chmod(target, 0o755);
      }
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
  }

  // ---- Authentification ngrok ----

  private async ensureNgrokAuth(exe: string): Promise<boolean> {
    const config = await execFileAsync(exe, ['config', 'check']).catch((err: Error) => err.message);
    const file = /at\s+(.+\.ya?ml)/i.exec(config)?.[1]?.trim();
    const content = file ? await fs.promises.readFile(file, 'utf8').catch(() => '') : '';
    if (/^\s*authtoken:\s*\S+/m.test(content)) {
      return true;
    }
    return this.askNgrokToken(exe, false);
  }

  private async askNgrokToken(exe: string, rejected: boolean): Promise<boolean> {
    const dashboard = 'https://dashboard.ngrok.com/get-started/your-authtoken';
    const open = t('ngrok.token.openPage');
    const paste = t('ngrok.token.havePaste');
    const choice = await vscode.window.showInformationMessage(
      t(rejected ? 'ngrok.token.rejected' : 'ngrok.token.required'),
      {
        modal: true,
        detail: t('ngrok.token.detail'),
      },
      open,
      paste,
    );
    if (!choice) {
      return false;
    }
    if (choice === open) {
      await vscode.env.openExternal(vscode.Uri.parse(dashboard));
    }
    const token = await vscode.window.showInputBox({
      title: t('ngrok.token.title'),
      prompt: t('ngrok.token.prompt', { url: dashboard }),
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (/^[A-Za-z0-9_-]{20,}$/.test(v.trim()) ? undefined : t('ngrok.token.invalid')),
    });
    if (!token) {
      return false;
    }
    await execFileAsync(exe, ['config', 'add-authtoken', token.trim()]);
    this.log('Tunnel : jeton ngrok enregistré.');
    return true;
  }

  // ---- Lancement ----

  private start(provider: TunnelProvider, exe: string, port: number, onExit: (reason: string) => void): Promise<Tunnel> {
    const origin = `http://127.0.0.1:${port}`;
    const args =
      provider === 'cloudflare'
        ? // HTTP/2 (TCP) plutôt que QUIC (UDP), souvent bloqué par les réseaux d'entreprise.
          ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', origin]
        : ['http', origin, '--log', 'stdout', '--log-format', 'json'];
    this.log(`Tunnel : ${exe} ${args.join(' ')}`);
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return new Promise<Tunnel>((resolve, reject) => {
      let url: string | undefined;
      let ready = false;
      let lastError = '';
      const timer = setTimeout(
        () =>
          fail(
            lastError
              ? t('tunnel.error.timeoutDetail', { seconds: START_TIMEOUT_MS / 1000, error: lastError })
              : t('tunnel.error.timeout', { seconds: START_TIMEOUT_MS / 1000 }),
            true,
          ),
        START_TIMEOUT_MS,
      );
      const fail = (reason: string, timedOut = false) => {
        if (!ready) {
          ready = true;
          clearTimeout(timer);
          child.kill();
          // Cloudflare : le réseau bloque le port 7844 ou le protocole du tunnel (pare-feu d'entreprise…).
          const unreachable = provider === 'cloudflare' && (timedOut || /edge|7844|i\/o timeout|dial/i.test(reason));
          reject(unreachable ? new TunnelUnreachableError(reason) : new Error(reason));
        }
      };
      const onLine = (line: string) => {
        if (provider === 'cloudflare') {
          url ??= /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line)?.[0];
          if (/ERR|error/i.test(line) && !/Cannot determine default configuration path/.test(line)) {
            lastError = line.replace(/^\S+\s+\S+\s+/, '').slice(0, 200);
          }
          // L'adresse est annoncée avant d'être joignable : on attend la première connexion enregistrée.
          if (url && /Registered tunnel connection/i.test(line)) {
            succeed(url);
          }
        } else {
          let entry: { msg?: string; url?: string; err?: string; lvl?: string };
          try {
            entry = JSON.parse(line) as typeof entry;
          } catch {
            lastError = line.slice(0, 200) || lastError;
            return;
          }
          if (entry.err && entry.err !== '<nil>') {
            lastError = entry.err.slice(0, 300);
          }
          if (entry.msg === 'started tunnel' && entry.url) {
            succeed(entry.url);
          }
        }
      };
      const succeed = (publicUrl: string) => {
        if (ready) {
          return;
        }
        ready = true;
        clearTimeout(timer);
        this.log(`Tunnel ${provider} ouvert : ${publicUrl}`);
        resolve({ provider, url: publicUrl, stop: () => child.kill() });
      };
      for (const stream of [child.stdout, child.stderr]) {
        let buffer = '';
        stream.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          lines.forEach(onLine);
        });
      }
      child.on('error', (err) => fail(err.message));
      child.on('exit', (code) => {
        const reason = lastError || t('tunnel.error.exited', { code: String(code) });
        this.log(`Tunnel ${provider} arrêté : ${reason}`);
        if (ready) {
          onExit(reason);
        } else {
          fail(reason);
        }
      });
    });
  }
}

// ---- Utilitaires ----

/** Fichier officiel à télécharger pour ce système, ou undefined s'il n'y en a pas. */
function downloadAsset(provider: TunnelProvider): { url: string; archive?: 'tgz' | 'zip' } | undefined {
  const arch = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[process.arch as string];
  if (!arch) {
    return undefined;
  }
  if (provider === 'cloudflare') {
    const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
    switch (process.platform) {
      case 'linux':
        return { url: `${base}/cloudflared-linux-${arch}` };
      case 'win32':
        return arch === 'amd64' || arch === '386' ? { url: `${base}/cloudflared-windows-${arch}.exe` } : undefined;
      case 'darwin':
        return arch === 'amd64' || arch === 'arm64' ? { url: `${base}/cloudflared-darwin-${arch}.tgz`, archive: 'tgz' } : undefined;
      default:
        return undefined;
    }
  }
  const base = 'https://bin.equinox.io/c/bNyj1mQVY4c';
  switch (process.platform) {
    case 'linux':
      return { url: `${base}/ngrok-v3-stable-linux-${arch}.tgz`, archive: 'tgz' };
    case 'win32':
      return { url: `${base}/ngrok-v3-stable-windows-${arch}.zip`, archive: 'zip' };
    case 'darwin':
      return arch === 'amd64' || arch === 'arm64' ? { url: `${base}/ngrok-v3-stable-darwin-${arch}.zip`, archive: 'zip' } : undefined;
    default:
      return undefined;
  }
}

/** true si la commande se lance (outil présent et exécutable). */
function runs(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15_000, windowsHide: true }, (err) => resolve(!err));
  });
}

function execFileAsync(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error(`${stderr || stdout || err.message}`.trim())) : resolve(`${stdout}${stderr}`),
    );
  });
}

/** Téléchargement HTTPS (redirections suivies, HTTPS uniquement). */
function fetchToFile(url: string, target: string, redirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': `prompt-share (${os.platform()})` } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url);
        if (next.protocol !== 'https:') {
          reject(new Error(t('download.error.insecureRedirect')));
          return;
        }
        fetchToFile(next.toString(), target, redirects - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(t('download.error.http', { status })));
        return;
      }
      const file = fs.createWriteStream(target, { mode: 0o755 });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => req.destroy(new Error(t('download.error.timeout'))));
  });
}

