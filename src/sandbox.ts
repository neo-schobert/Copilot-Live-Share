import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Lang } from './i18n/core';
import { I18nError, roomT } from './i18n/room';

/**
 * Bac à sable des commandes de l'agent, basé sur bubblewrap :
 * - sous Linux (y compris VS Code connecté à WSL), bubblewrap est lancé directement ;
 * - sous Windows, si WSL et bubblewrap sont disponibles, les commandes passent par
 *   wsl.exe et le projet est vu sous /mnt/<lecteur>/… .
 * Dans les deux cas : système en lecture seule, projet en écriture, ni dossier
 * personnel, ni réseau, fichiers protégés masqués.
 */

export interface SandboxRuntime {
  kind: 'native' | 'wsl';
  /** Description pour le modèle et l'hôte, ex. « Linux (WSL : Ubuntu) ». */
  description: string;
  /** Exécutable lancé côté hôte (bwrap ou wsl.exe). */
  launcher: string;
  /** Arguments placés avant ceux de bubblewrap (WSL : [-d distro] -e bwrap). */
  prefix: string[];
  /** /bin, /lib… du système Linux : lien symbolique (avec sa cible) ou dossier. */
  rootEntries: { path: string; link?: string }[];
  /** Dossiers du PATH Linux hors /usr, exposés en lecture seule et placés dans le PATH. */
  pathDirs: string[];
  /** Autres dossiers exposés en lecture seule (ex. racine d'une installation de Node). */
  readOnly: string[];
  /** Variables d'environnement pour lancer le processus côté hôte. */
  env?: NodeJS.ProcessEnv;
  /** Chemin de l'hôte vu depuis le bac à sable ; undefined si le chemin n'y est pas accessible. */
  toSandbox(hostPath: string): string | undefined;
}

export interface SandboxOptions {
  /** Dossiers supplémentaires en lecture seule (paramètre sandboxReadOnlyPaths, chemins Linux). */
  extraReadOnly: string[];
  useWsl: boolean;
  wslDistro: string;
  log: (message: string) => void;
}

let current: SandboxRuntime | undefined;
let detection: Promise<SandboxRuntime | undefined> | undefined;

/** Bac à sable détecté (undefined tant que la détection n'est pas terminée, ou s'il n'y en a pas). */
export function sandboxRuntime(): SandboxRuntime | undefined {
  return current;
}

/** Détecte le bac à sable disponible ; le résultat est mémorisé jusqu'à `resetSandbox`. */
export function detectSandbox(options: SandboxOptions): Promise<SandboxRuntime | undefined> {
  detection ??= (async () => {
    // Pour les tests : force le mode WSL avec un faux wsl.exe (voir test/vscode).
    const fakeWsl = process.env.SCC_TEST_FAKE_WSL;
    if (fakeWsl) {
      return probeWsl(fakeWsl, options);
    }
    if (process.platform === 'linux') {
      return detectNative(options);
    }
    if (process.platform === 'win32' && options.useWsl) {
      return probeWsl('wsl.exe', options);
    }
    return undefined;
  })().then((rt) => {
    current = rt;
    options.log(rt ? `Bac à sable des commandes : bubblewrap, ${rt.description}.` : 'Bac à sable des commandes indisponible : chaque commande devra être validée par l’hôte.');
    return rt;
  });
  return detection;
}

export function resetSandbox(): void {
  current = undefined;
  detection = undefined;
}

// ---- Linux natif ----

function detectNative(options: SandboxOptions): SandboxRuntime | undefined {
  const bwrap = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'].find((p) => fs.existsSync(p));
  if (!bwrap) {
    options.log('bubblewrap introuvable : installez-le (ex. « sudo apt install bubblewrap ») pour isoler les commandes.');
    return undefined;
  }
  const rootEntries: SandboxRuntime['rootEntries'] = [];
  for (const dir of ['/bin', '/sbin', '/lib', '/lib32', '/lib64']) {
    try {
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink()) {
        rootEntries.push({ path: dir, link: fs.readlinkSync(dir) });
      } else if (st.isDirectory()) {
        rootEntries.push({ path: dir });
      }
    } catch {
      // Absent sur cette distribution.
    }
  }
  const home = os.homedir();
  const pathDirs: string[] = [];
  const readOnly = new Set(options.extraReadOnly);
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!isToolchainDir(dir, home)) {
      continue;
    }
    try {
      if (fs.statSync(dir).isDirectory()) {
        pathDirs.push(dir);
        // Installation de Node hors de /usr : npm a besoin de <racine>/lib.
        if (path.posix.basename(dir) === 'bin' && fs.existsSync(path.join(dir, 'node'))) {
          readOnly.add(path.posix.dirname(dir));
        }
      }
    } catch {
      // Entrée du PATH inexistante.
    }
  }
  return {
    kind: 'native',
    description: 'Linux',
    launcher: bwrap,
    prefix: [],
    rootEntries,
    pathDirs,
    readOnly: [...readOnly],
    toSandbox: (p) => p,
  };
}

/** Dossier du PATH à exposer : ni /usr (déjà monté), ni la racine du dossier personnel, ni les lecteurs Windows. */
function isToolchainDir(dir: string, home: string): boolean {
  return (
    !!dir &&
    dir.startsWith('/') &&
    !dir.startsWith('/usr') &&
    !dir.startsWith('/mnt/') &&
    !['/bin', '/sbin', home, '/'].includes(dir)
  );
}

// ---- Windows + WSL ----

/** Script exécuté dans WSL : décrit la distribution, puis vérifie bubblewrap et l'environnement Linux. */
const WSL_PROBE = String.raw`
echo "DISTRO $WSL_DISTRO_NAME"
echo "HOME $HOME"
echo "MOUNT $(wslpath -a 'C:\' 2>/dev/null)"
command -v bwrap >/dev/null 2>&1 || { echo NOBWRAP; exit 0; }
bwrap --ro-bind / / --unshare-all --die-with-parent true >/dev/null 2>&1 || { echo BWRAPFAIL; exit 0; }
echo "BWRAP $(command -v bwrap)"
for d in /bin /sbin /lib /lib32 /lib64; do
  if [ -L "$d" ]; then echo "LINK $d $(readlink "$d")"; elif [ -d "$d" ]; then echo "DIR $d"; fi
done
old=$IFS; IFS=:
for d in $PATH; do
  [ -d "$d" ] || continue
  echo "PATHDIR $d"
  if [ "$(basename "$d")" = bin ] && [ -x "$d/node" ]; then echo "NODEROOT $(dirname "$d")"; fi
done
IFS=$old
`;

/** Installe bubblewrap avec le gestionnaire de paquets de la distribution (exécuté en root). */
const WSL_INSTALL_BWRAP = String.raw`
set -e
if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; apt-get update -q; apt-get install -y -q bubblewrap
elif command -v dnf >/dev/null 2>&1; then dnf install -y bubblewrap
elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install bubblewrap
elif command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm bubblewrap
elif command -v apk >/dev/null 2>&1; then apk add bubblewrap
else echo "Gestionnaire de paquets non reconnu : installez bubblewrap manuellement."; exit 3
fi
`;

export type WslStatus = 'absent' | 'noBubblewrap' | 'bubblewrapFails' | 'ready';

export interface WslInfo {
  status: WslStatus;
  /** Distribution utilisée (vide si WSL est absent). */
  distro: string;
  /** Racine de montage des lecteurs Windows, « /mnt/ » par défaut. */
  mountRoot: string;
  /** Explication lisible pour l'hôte, dans la langue demandée à `inspectWsl` / `parseWslProbe`. */
  detail: string;
  runtime?: SandboxRuntime;
}

/** Exécutable wsl.exe (remplaçable par un faux wsl.exe dans les tests). */
export function wslLauncher(): string {
  return process.env.SCC_TEST_FAKE_WSL ?? 'wsl.exe';
}

/** wsl.exe écrit ses propres messages en UTF-16 sans WSL_UTF8. */
const WSL_ENV = (): NodeJS.ProcessEnv => ({ ...process.env, WSL_UTF8: '1' });

function distroArgs(distro: string): string[] {
  return distro ? ['-d', distro] : [];
}

/**
 * Examine WSL : présence, distribution, bubblewrap (WSL 2 requis) et environnement du bac à sable.
 * `lang` : langue de `detail` (anglais par défaut).
 */
export async function inspectWsl(distro: string, extraReadOnly: string[] = [], launcher = wslLauncher(), lang: Lang = 'en'): Promise<WslInfo> {
  let out: string;
  try {
    out = await run(launcher, [...distroArgs(distro), '-e', 'sh', '-lc', WSL_PROBE], WSL_ENV(), 60_000);
  } catch (err) {
    return {
      status: 'absent',
      distro: '',
      mountRoot: '/mnt/',
      detail: roomT(lang, 'wsl.absent', { error: (err as Error).message }),
    };
  }
  return parseWslProbe(out, launcher, distro, extraReadOnly, lang);
}

/** Analyse la sortie de la sonde WSL (fonction pure, testée sans Windows). `lang` : langue de `detail`. */
export function parseWslProbe(out: string, launcher: string, requestedDistro: string, extraReadOnly: string[] = [], lang: Lang = 'en'): WslInfo {
  const lines = out.split(/\r?\n/);
  const value = (tag: string) => lines.find((l) => l.startsWith(`${tag} `))?.slice(tag.length + 1).trim() ?? '';
  const distro = value('DISTRO') || requestedDistro;
  const home = value('HOME');
  // « /mnt/c/ » -> racine de montage « /mnt/ » (configurable dans wsl.conf).
  const mountRoot = value('MOUNT').replace(/c\/?$/i, '') || '/mnt/';
  const base = { distro, mountRoot };
  const name = distro ? roomT(lang, 'wsl.distroName', { distro }) : 'WSL';

  if (lines.includes('NOBWRAP')) {
    return { ...base, status: 'noBubblewrap', detail: roomT(lang, 'wsl.noBubblewrap', { name }) };
  }
  if (lines.includes('BWRAPFAIL') || !value('BWRAP')) {
    return {
      ...base,
      status: 'bubblewrapFails',
      detail: roomT(lang, 'wsl.bubblewrapFails', { name, distro: distro || roomT(lang, 'wsl.distroPlaceholder') }),
    };
  }

  const rootEntries: SandboxRuntime['rootEntries'] = [];
  const pathDirs: string[] = [];
  const readOnly = new Set(extraReadOnly);
  for (const line of lines) {
    const [tag, ...rest] = line.split(' ');
    const arg = rest.join(' ');
    if (tag === 'LINK' && rest.length >= 2) {
      rootEntries.push({ path: rest[0], link: rest.slice(1).join(' ') });
    } else if (tag === 'DIR' && rest[0]) {
      rootEntries.push({ path: rest[0] });
    } else if (tag === 'PATHDIR' && isToolchainDir(arg, home)) {
      pathDirs.push(arg);
    } else if (tag === 'NODEROOT' && isToolchainDir(arg, home)) {
      readOnly.add(arg);
    }
  }
  return {
    ...base,
    status: 'ready',
    detail: roomT(lang, 'wsl.ready', { name }),
    runtime: {
      kind: 'wsl',
      description: `Linux (WSL${distro ? ` : ${distro}` : ''})`,
      launcher,
      prefix: [...distroArgs(requestedDistro), '-e', value('BWRAP')],
      rootEntries,
      pathDirs,
      readOnly: [...readOnly],
      env: WSL_ENV(),
      toSandbox: (p) => windowsToWsl(p, mountRoot, distro),
    },
  };
}

/** Installe bubblewrap dans la distribution (en root via wsl -u root, sans mot de passe). */
export async function installBubblewrapInWsl(distro: string, log: (message: string) => void, launcher = wslLauncher()): Promise<boolean> {
  try {
    const out = await run(launcher, [...distroArgs(distro), '-u', 'root', '-e', 'sh', '-c', WSL_INSTALL_BWRAP], WSL_ENV(), 10 * 60_000);
    log(out.trim());
    return true;
  } catch (err) {
    log(`Échec de l'installation de bubblewrap : ${(err as Error).message}`);
    return false;
  }
}

async function probeWsl(launcher: string, options: SandboxOptions): Promise<SandboxRuntime | undefined> {
  const info = await inspectWsl(options.wslDistro, options.extraReadOnly, launcher);
  if (!info.runtime) {
    options.log(info.detail);
  }
  return info.runtime;
}

/**
 * Chemin Windows -> chemin WSL : C:\a\b -> /mnt/c/a/b ; \\wsl.localhost\<distro>\x -> /x
 * pour la distribution utilisée. Les chemins déjà Linux (tests) sont gardés tels quels.
 */
export function windowsToWsl(p: string, mountRoot: string, distro: string): string | undefined {
  if (p.startsWith('/')) {
    return p;
  }
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(p);
  if (drive) {
    const rest = drive[2].replace(/\\/g, '/').replace(/\/+$/, '');
    return `${mountRoot}${drive[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
  }
  const unc = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\?(.*)$/i.exec(p);
  if (unc && (!distro || unc[1].toLowerCase() === distro.toLowerCase())) {
    return `/${unc[2].replace(/\\/g, '/')}`;
  }
  return undefined;
}

// ---- Arguments bubblewrap ----

export interface SandboxTarget {
  /** Dossiers du projet (chemins de l'hôte), montés en écriture. */
  folders: string[];
  /** Fichiers et dossiers protégés à masquer (chemins de l'hôte). */
  hidden: { path: string; dir: boolean }[];
  /** Dossier de travail (chemin de l'hôte). */
  cwd: string;
}

/** Arguments complets (launcher exclu) pour exécuter `command` dans le bac à sable. */
export function sandboxCommand(rt: SandboxRuntime, target: SandboxTarget, command: string): string[] {
  const map = (p: string) => {
    const mapped = rt.toSandbox(p);
    if (!mapped) {
      throw new I18nError('sandbox.error.unreachable', { path: p });
    }
    return mapped;
  };
  const args = [...rt.prefix, '--die-with-parent', '--new-session', '--unshare-all', '--clearenv'];
  for (const entry of rt.rootEntries) {
    args.push(...(entry.link ? ['--symlink', entry.link, entry.path] : ['--ro-bind', entry.path, entry.path]));
  }
  args.push('--ro-bind', '/usr', '/usr');
  for (const etc of ['/etc/alternatives', '/etc/ssl', '/etc/ca-certificates', '/etc/localtime']) {
    args.push('--ro-bind-try', etc, etc);
  }
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/home');
  for (const dir of new Set([...rt.pathDirs, ...rt.readOnly])) {
    args.push('--ro-bind-try', dir, dir);
  }
  for (const folder of target.folders) {
    const inside = map(folder);
    args.push('--bind', inside, inside);
  }
  // Après le montage du projet : recouvre les fichiers protégés par un fichier ou un dossier vide.
  for (const hidden of target.hidden) {
    const inside = rt.toSandbox(hidden.path);
    if (inside) {
      args.push(...(hidden.dir ? ['--tmpfs', inside] : ['--ro-bind', '/dev/null', inside]));
    }
  }
  const envPath = [...rt.pathDirs, '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  args.push(
    '--setenv', 'PATH', envPath,
    '--setenv', 'HOME', '/tmp/home',
    '--setenv', 'TERM', 'dumb',
    '--setenv', 'LANG', rt.kind === 'native' ? (process.env.LANG ?? 'C.UTF-8') : 'C.UTF-8',
    '--chdir', map(target.cwd),
    '/bin/sh', '-c', command,
  );
  return args;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('délai dépassé'));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(out);
      } else {
        reject(new Error(`code ${code} : ${out.trim().slice(0, 200)}`));
      }
    });
  });
}
