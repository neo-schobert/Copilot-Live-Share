// @ts-check
/**
 * Lance les tests d'intégration dans une instance VS Code isolée (profil et
 * extensions temporaires), sur un projet piégé créé pour l'occasion.
 * Usage : npm run test:vscode   (nécessite la commande « code » et un affichage).
 */
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-vscode-test-'));
const outside = path.join(tmp, 'outside');
const ws = path.join(tmp, 'workspace');
fs.mkdirSync(outside);
fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
fs.mkdirSync(path.join(ws, '.git'));
fs.writeFileSync(path.join(ws, 'src', 'a.ts'), 'export const a = 1; // hello\n');
fs.writeFileSync(path.join(ws, '.env'), 'API_KEY=SECRET123\n');
fs.writeFileSync(path.join(ws, '.git', 'config'), '[remote]\nurl=https://token@github.com/x\n');
fs.writeFileSync(path.join(tmp, 'outside.txt'), 'hors du projet\n');
// Liens symboliques : sous Windows, leur création peut exiger des droits (mode développeur) ; le test s'adapte.
const systemDir = process.platform === 'win32' ? process.env.SystemRoot ?? 'C:\\Windows' : '/etc';
for (const [target, name] of [
  [systemDir, 'link_out'],
  ['.env', 'link_env'],
  [path.join(outside, 'created-through-link.txt'), 'dangling'],
]) {
  try {
    fs.symlinkSync(target, path.join(ws, name), name === 'link_out' ? 'junction' : 'file');
  } catch (err) {
    console.warn(`Lien ${name} non créé (${err.code}) : vérifications correspondantes ignorées.`);
  }
}

// --wsl : simule Windows + WSL avec un faux wsl.exe qui exécute ses arguments sous Linux.
const env = { ...process.env };
if (process.argv.includes('--wsl')) {
  const fake = path.join(tmp, 'fake-wsl.sh');
  fs.writeFileSync(fake, '#!/bin/sh\n[ "$1" = "-d" ] && shift 2\n[ "$1" = "-u" ] && shift 2\n[ "$1" = "-e" ] && shift\nexec "$@"\n', { mode: 0o755 });
  env.SCC_TEST_FAKE_WSL = fake;
}

const code = process.env.SCC_CODE_CLI ?? 'code';

/** Lance une instance VS Code isolée et renvoie une promesse du texte de résultat. */
function launch(name, { workspace, devPath, testFile, extraEnv = {} }) {
  const out = path.join(tmp, `result-${name}.txt`);
  const child = spawn(
    code,
    [
      workspace,
      '--user-data-dir', path.join(tmp, `user-data-${name}`),
      '--extensions-dir', path.join(tmp, `extensions-${name}`),
      '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
      `--extensionDevelopmentPath=${devPath}`,
      `--extensionTestsPath=${path.join(root, 'dist', 'test', 'vscode', testFile)}`,
    ],
    // Sous Windows, « code » est un script code.cmd : il faut passer par le shell.
    { env: { ...env, ...extraEnv, SCC_TEST_OUT: out, SCC_TEST_OUTSIDE: outside }, stdio: 'ignore', shell: process.platform === 'win32' },
  );
  child.on('error', (err) => {
    console.error(`Impossible de lancer « ${code} » : ${err.message}`);
    process.exit(1);
  });
  return new Promise((resolve) => {
    const deadline = Date.now() + 180_000;
    const timer = setInterval(() => {
      const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
      if (text.includes('RESULT:') || Date.now() > deadline) {
        clearInterval(timer);
        resolve(text || `[${name}] aucun résultat (délai dépassé).`);
      }
    }, 1000);
  });
}

async function main() {
  let results;
  if (process.argv.includes('--view')) {
    // Vue « Shared Copilot » : deux VS Code, l'un héberge, l'autre rejoint. On teste le VSIX
    // du Marketplace (sans API proposées), extrait et chargé comme extension de développement.
    const vsix = fs.readdirSync(root).find((f) => f.endsWith('.vsix'));
    if (!vsix) {
      console.error('Aucun .vsix : lancez d’abord « npm run package:marketplace ».');
      process.exit(1);
    }
    const unpacked = path.join(tmp, 'vsix');
    fs.mkdirSync(unpacked);
    execFileSync(process.platform === 'win32' ? 'tar.exe' : 'unzip', process.platform === 'win32' ? ['-xf', path.join(root, vsix), '-C', unpacked] : ['-q', path.join(root, vsix), '-d', unpacked]);
    const sync = path.join(tmp, 'sync');
    fs.mkdirSync(sync);
    const devPath = path.join(unpacked, 'extension');
    const guestWs = path.join(tmp, 'guest-workspace');
    fs.mkdirSync(guestWs);
    results = await Promise.all([
      launch('hote', { workspace: ws, devPath, testFile: 'view.js', extraEnv: { SCC_VIEW_ROLE: 'host', SCC_TEST_SYNC: sync } }),
      launch('invite', { workspace: guestWs, devPath, testFile: 'view.js', extraEnv: { SCC_VIEW_ROLE: 'guest', SCC_TEST_SYNC: sync } }),
    ]);
  } else {
    results = [await launch('confine', { workspace: ws, devPath: root, testFile: 'confine.js' })];
  }
  console.log(results.join('\n'));
  process.exit(results.every((r) => r.includes('RESULT: PASS')) ? 0 : 1);
}

void main();
