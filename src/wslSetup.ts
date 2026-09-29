import * as fs from 'fs';
import * as vscode from 'vscode';
import { t, uiLang } from './i18n/vscode';
import { inspectWsl, installBubblewrapInWsl, sandboxRuntime, windowsToWsl, WslInfo } from './sandbox';

/**
 * Préparation de l'environnement au démarrage d'une session :
 * - sous Windows, si WSL est installé, propose de rouvrir le projet dans WSL (pour
 *   fonctionner exactement comme sous Linux) et installe ce qui manque, avec l'accord
 *   de l'hôte : bubblewrap dans la distribution, extension WSL de VS Code ;
 * - sous Linux (y compris dans WSL), propose d'installer bubblewrap s'il manque.
 */

const WSL_EXTENSION = 'ms-vscode-remote.remote-wsl';
const PENDING_KEY = 'promptShare.pendingStartInWsl';
const PENDING_TTL_MS = 10 * 60_000;

export type WslMode = 'ask' | 'reopen' | 'windows' | 'off';

export interface SetupResult {
  /** continue : démarrer la session ici ; reopening : la fenêtre se rouvre dans WSL ; cancelled : abandon. */
  outcome: 'continue' | 'reopening' | 'cancelled';
  /** L'environnement a changé (bubblewrap installé…) : il faut refaire la détection du bac à sable. */
  redetect: boolean;
}

interface PendingStart {
  path: string;
  at: number;
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('promptShare');
}

export async function prepareEnvironment(context: vscode.ExtensionContext, log: (m: string) => void): Promise<SetupResult> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (process.platform === 'win32' && !vscode.env.remoteName && folder?.uri.scheme === 'file') {
    return windowsSetup(context, folder, log);
  }
  if (process.platform === 'linux' && !sandboxRuntime()) {
    offerLinuxBubblewrap(log);
  }
  return { outcome: 'continue', redetect: false };
}

/** À l'activation : la session doit-elle démarrer d'elle-même (réouverture dans WSL demandée juste avant) ? */
export function consumePendingStart(context: vscode.ExtensionContext): boolean {
  const pending = context.globalState.get<PendingStart>(PENDING_KEY);
  if (!pending) {
    return false;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (vscode.env.remoteName !== 'wsl' || !folder) {
    return false; // Pas encore dans la fenêtre WSL : on laisse la demande en place.
  }
  void context.globalState.update(PENDING_KEY, undefined);
  return folder.uri.path === pending.path && Date.now() - pending.at < PENDING_TTL_MS;
}

// ---- Windows ----

async function windowsSetup(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  log: (m: string) => void,
): Promise<SetupResult> {
  const mode = config().get<WslMode>('wslMode', 'ask');
  log(`Windows : wslMode = ${mode}, dossier ${folder.uri.fsPath}`);
  if (mode === 'off') {
    return { outcome: 'continue', redetect: false };
  }
  const distro = config().get<string>('wslDistro', '').trim();
  let info = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('wsl.progress.searching') },
    () => inspectWsl(distro, config().get<string[]>('sandboxReadOnlyPaths', []), undefined, uiLang()),
  );
  log(`WSL : ${info.status}${info.distro ? `, distribution ${info.distro}` : ''}, montage ${info.mountRoot} — ${info.detail}`);
  if (info.status === 'absent') {
    return { outcome: 'continue', redetect: false };
  }
  if (info.status === 'bubblewrapFails') {
    void vscode.window.showWarningMessage(t('wsl.bubblewrapFails', { detail: info.detail }));
    return { outcome: 'continue', redetect: false };
  }

  let choice: 'reopen' | 'windows' = mode === 'reopen' ? 'reopen' : 'windows';
  if (mode === 'ask') {
    const reopen = t('wsl.reopen.button');
    const stay = t('wsl.stay.button');
    const answer = await vscode.window.showInformationMessage(
      info.distro ? t('wsl.reopen.messageDistro', { distro: info.distro }) : t('wsl.reopen.message'),
      {
        modal: true,
        detail: t(info.status === 'noBubblewrap' ? 'wsl.reopen.detailNoBubblewrap' : 'wsl.reopen.detail'),
      },
      reopen,
      stay,
    );
    log(`Choix de l'hôte : ${answer ?? 'fenêtre fermée sans réponse'}`);
    if (!answer) {
      return { outcome: 'cancelled', redetect: false };
    }
    choice = answer === reopen ? 'reopen' : 'windows';
  }

  let redetect = false;
  if (info.status === 'noBubblewrap') {
    const installed = await offerWslBubblewrap(info, log);
    if (installed) {
      info = await inspectWsl(distro, config().get<string[]>('sandboxReadOnlyPaths', []), undefined, uiLang());
      log(info.detail);
      redetect = true;
    }
  }

  if (choice === 'reopen') {
    const reopened = await reopenInWsl(context, folder, info, log);
    log(reopened ? 'Réouverture dans WSL lancée.' : 'Réouverture dans WSL impossible : la session démarre sous Windows.');
    if (reopened) {
      return { outcome: 'reopening', redetect };
    }
  }
  return { outcome: 'continue', redetect };
}

async function offerWslBubblewrap(info: WslInfo, log: (m: string) => void): Promise<boolean> {
  const install = t('wsl.bubblewrap.install');
  const answer = await vscode.window.showWarningMessage(
    t('wsl.bubblewrap.message', { distro: info.distro || 'WSL' }),
    {
      modal: true,
      detail: t('wsl.bubblewrap.detail'),
    },
    install,
  );
  log(`Installation de bubblewrap : ${answer === install ? 'acceptée' : 'refusée'}`);
  if (answer !== install) {
    return false;
  }
  const ok = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('wsl.bubblewrap.progress', { distro: info.distro || 'WSL' }) },
    () => installBubblewrapInWsl(info.distro, log),
  );
  if (ok) {
    void vscode.window.showInformationMessage(t('wsl.bubblewrap.installed'));
  } else {
    void vscode.window.showErrorMessage(t('wsl.bubblewrap.failed'));
  }
  return ok;
}

/** Rouvre le dossier dans WSL. Renvoie false si ce n'est pas possible (la session démarre alors sous Windows). */
async function reopenInWsl(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  info: WslInfo,
  log: (m: string) => void,
): Promise<boolean> {
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    void vscode.window.showWarningMessage(t('wsl.devMode'));
    return false;
  }
  const wslPath = windowsToWsl(folder.uri.fsPath, info.mountRoot, info.distro);
  if (!wslPath || !info.distro) {
    log(`Impossible de convertir ${folder.uri.fsPath} en chemin WSL : la session démarre sous Windows.`);
    return false;
  }

  if (!vscode.extensions.getExtension(WSL_EXTENSION)) {
    const install = t('wsl.extension.install');
    const answer = await vscode.window.showInformationMessage(
      t('wsl.extension.required'),
      { modal: true },
      install,
    );
    log(`Installation de l'extension WSL : ${answer === install ? 'acceptée' : 'refusée'}`);
    if (answer !== install) {
      return false;
    }
    try {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', WSL_EXTENSION);
    } catch (err) {
      log(`Échec de l'installation de l'extension WSL : ${String(err)}`);
      void vscode.window.showErrorMessage(t('wsl.extension.failed'));
      return false;
    }
  }

  // Installe automatiquement cette extension dans WSL à la connexion (réglage de VS Code).
  const remote = vscode.workspace.getConfiguration('remote');
  const autoInstall = remote.get<string[]>('defaultExtensionsIfInstalledLocally', []);
  log(`Installation automatique dans WSL : ${context.extension.id} (remote.defaultExtensionsIfInstalledLocally)`);
  if (!autoInstall.includes(context.extension.id)) {
    await remote.update('defaultExtensionsIfInstalledLocally', [...autoInstall, context.extension.id], vscode.ConfigurationTarget.Global);
  }

  await context.globalState.update(PENDING_KEY, { path: wslPath, at: Date.now() } satisfies PendingStart);
  const uri = vscode.Uri.from({ scheme: 'vscode-remote', authority: `wsl+${info.distro}`, path: wslPath });
  log(`Réouverture du projet dans WSL : ${uri.toString()}`);
  await vscode.commands.executeCommand('vscode.openFolder', uri, { forceReuseWindow: true });
  return true;
}

// ---- Linux (y compris dans WSL) ----

const LINUX_INSTALL: [string, string][] = [
  ['/usr/bin/apt-get', 'sudo apt-get install -y bubblewrap'],
  ['/usr/bin/dnf', 'sudo dnf install -y bubblewrap'],
  ['/usr/bin/zypper', 'sudo zypper install -y bubblewrap'],
  ['/usr/bin/pacman', 'sudo pacman -S --noconfirm bubblewrap'],
  ['/sbin/apk', 'sudo apk add bubblewrap'],
];

let linuxOffered = false;

/** Propose (une fois par fenêtre) d'installer bubblewrap dans un terminal, où l'hôte saisit son mot de passe. */
function offerLinuxBubblewrap(log: (m: string) => void): void {
  if (linuxOffered) {
    return;
  }
  linuxOffered = true;
  const command = LINUX_INSTALL.find(([pm]) => fs.existsSync(pm))?.[1];
  if (!command) {
    log('bubblewrap absent et gestionnaire de paquets non reconnu : installez bubblewrap pour isoler les commandes.');
    return;
  }
  const install = t('linux.bubblewrap.install');
  void vscode.window
    .showWarningMessage(
      t('linux.bubblewrap.missing'),
      install,
    )
    .then((answer) => {
      if (answer !== install) {
        return;
      }
      const terminal = vscode.window.createTerminal({ name: 'Prompt Share — bubblewrap' });
      terminal.show();
      terminal.sendText(command);
      void vscode.window.showInformationMessage(t('linux.bubblewrap.restart'));
    });
}
