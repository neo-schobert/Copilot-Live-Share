// @ts-check
/**
 * Lance les tests d'intégration dans une instance VS Code isolée (profil et
 * extensions temporaires), sur un projet piégé créé pour l'occasion.
 * Usage : npm run test:vscode   (nécessite la commande « code » et un affichage).
 */
const { spawn } = require('child_process');
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

const out = path.join(tmp, 'result.txt');
const code = process.env.SCC_CODE_CLI ?? 'code';
const child = spawn(
  code,
  [
    ws,
    '--user-data-dir', path.join(tmp, 'user-data'),
    '--extensions-dir', path.join(tmp, 'extensions'),
    '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${path.join(root, 'dist', 'test', 'vscode', 'confine.js')}`,
  ],
  // Sous Windows, « code » est un script code.cmd : il faut passer par le shell.
  { env: { ...process.env, SCC_TEST_OUT: out, SCC_TEST_OUTSIDE: outside }, stdio: 'ignore', shell: process.platform === 'win32' },
);
child.on('error', (err) => {
  console.error(`Impossible de lancer « ${code} » : ${err.message}`);
  process.exit(1);
});

const deadline = Date.now() + 180_000;
const timer = setInterval(() => {
  const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (text.includes('RESULT:') || Date.now() > deadline) {
    clearInterval(timer);
    console.log(text || 'Aucun résultat (délai dépassé).');
    process.exit(text.includes('RESULT: PASS') ? 0 : 1);
  }
}, 1000);
