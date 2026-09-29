/**
 * Test d'intégration exécuté dans un vrai VS Code (voir run.js) : confinement de
 * l'agent au projet. Le projet de test contient des pièges : .env, .git/config,
 * lien vers /etc, lien vers .env, lien cassé pointant hors du projet.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { PromptShareApi } from '../../src/extension';

const OUT = process.env.SCC_TEST_OUT!;
const OUTSIDE = process.env.SCC_TEST_OUTSIDE!;
const log: string[] = [];
const ac = new AbortController();

function ok(message: string): void {
  log.push(`✓ ${message}`);
  fs.writeFileSync(OUT, log.join('\n'));
}

async function refused(api: PromptShareApi, name: string, input: object, expected: RegExp, label: string): Promise<void> {
  try {
    const result = await (await api.tools.prepare(name, input)).execute(ac.signal);
    throw new Error(`${label} : pas refusé -> ${result.result.slice(0, 80)}`);
  } catch (err) {
    const message = (err as Error).message;
    if (!expected.test(message)) {
      throw new Error(`${label} : message inattendu -> ${message}`);
    }
    ok(`${label} : refusé (${message})`);
  }
}

export async function run(): Promise<void> {
  try {
    const api = (await vscode.extensions.getExtension('neo-schobert.prompt-share')!.activate()) as PromptShareApi;
    await api.sandboxReady;
    const sandbox = api.tools.sandboxDescription();
    const wslMode = !!process.env.SCC_TEST_FAKE_WSL;
    log.push(`  · bac à sable : ${sandbox ?? 'aucun'}${wslMode ? ' (mode WSL simulé)' : ''}`);
    if (wslMode && !sandbox?.includes('WSL')) throw new Error('mode WSL non détecté');
    const tools = api.tools;
    const exec = async (name: string, input: object) => (await tools.prepare(name, input)).execute(ac.signal);
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;

    const list = await exec('list_directory', { path: '.' });
    if (/\.env|\.git\b/.test(list.result)) throw new Error(`list_directory montre .env/.git : ${list.result}`);
    ok(`list_directory . : ${list.result.replace(/\n/g, ', ')}`);
    const found = await exec('find_files', { pattern: '**/*' });
    if (/\.env|\.git|link_out\//.test(found.result)) throw new Error(`find_files : ${found.result.slice(0, 300)}`);
    ok(`find_files **/* : ${found.result.replace(/\n/g, ', ')}`);
    for (const secret of ['SECRET123', 'token@github']) {
      const search = await exec('search_text', { query: secret });
      if (search.result.includes(secret)) throw new Error(`search_text fuit « ${secret} » : ${search.result}`);
    }
    ok('search_text : ni le contenu de .env ni celui de .git/config');

    await refused(api, 'read_file', { path: '.env' }, /Protected file/, 'read_file .env');
    await refused(api, 'read_file', { path: '.git/config' }, /Protected file/, 'read_file .git/config');
    const link = (name: string) => fs.lstatSync(path.join(root, name), { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
    if (link('link_env')) {
      await refused(api, 'read_file', { path: 'link_env' }, /Protected file/, 'read_file link_env (lien vers .env)');
    }
    if (link('link_out')) {
      const inside = fs.readdirSync(path.join(root, 'link_out'))[0];
      await refused(api, 'read_file', { path: `link_out/${inside}` }, /outside the workspace/, `read_file link_out/${inside} (lien vers un dossier système)`);
      await refused(api, 'list_directory', { path: 'link_out' }, /outside the workspace/, 'list_directory link_out');
    }
    await refused(api, 'read_file', { path: '../outside.txt' }, /outside the workspace/, 'read_file ../outside.txt');
    const systemFile = process.platform === 'win32' ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\win.ini` : '/etc/hostname';
    await refused(api, 'read_file', { path: systemFile }, /outside the workspace/, `read_file ${systemFile}`);
    if (link('dangling')) {
      await refused(api, 'create_file', { path: 'dangling', content: 'x' }, /Symbolic link/, 'create_file sur un lien cassé vers l’extérieur');
    }
    await refused(api, 'edit_file', { path: '.env', oldText: 'API', newText: 'X' }, /Protected file/, 'edit_file .env');
    if (fs.existsSync(path.join(OUTSIDE, 'created-through-link.txt'))) throw new Error('fichier créé hors du projet');

    const edit = await tools.prepare('edit_file', { path: 'src/a.ts', oldText: 'hello', newText: 'bonjour' });
    if (edit.approval?.kind !== 'write' || edit.approval.hostOnly) throw new Error('edit_file : validation inattendue');
    const inside = await tools.prepare('run_command', { command: 'echo ok' });
    const outside = await tools.prepare('run_command', { command: 'npm install', outsideProject: true });
    if (inside.approval?.hostOnly || !outside.approval?.hostOnly) throw new Error('run_command : hostOnly incorrect');
    tools.grant('command');
    if (tools.isGranted(outside.approval)) throw new Error('« pour la session » appliqué à une commande hors du projet');
    ok('validations : dans le projet, auteur ou hôte ; hors du projet, hôte seul, jamais couvert par « pour la session »');

    if (!sandbox) {
      log.push('  · bubblewrap indisponible : test du bac à sable ignoré');
    } else {
      const home = os.homedir();
      const probe = await (
        await tools.prepare('run_command', {
          command: [
            `test -e ${home}/.bashrc -o -e ${home}/.ssh -o -e ${home}/.config && echo HOME-VISIBLE || echo home-files-invisible`,
            `echo "home-contient=[$(ls -A ${home} 2>/dev/null | tr '\\n' ' ')]"`,
            `echo escape > ${OUTSIDE}/escape.txt 2>/dev/null; echo "env=[$(cat .env 2>/dev/null)]"`,
            `echo "gitconfig=[$(cat .git/config 2>/dev/null)]"`,
            'python3 -c "import socket; socket.create_connection((\'1.1.1.1\', 80), 2)" 2>/dev/null && echo NET-OK || echo net-blocked',
            'command -v node >/dev/null && node -e "console.log(\'node=\' + (1 + 1))" || echo node-absent',
            'echo projet > src/from-sandbox.txt && echo project-write-ok',
          ].join('; '),
        })
      ).execute(ac.signal);
      log.push(`  · sortie : ${probe.result.replace(/\n/g, ' | ')}`);
      if (probe.result.includes('HOME-VISIBLE')) throw new Error('fichiers du dossier personnel visibles');
      if (probe.result.includes('NET-OK')) throw new Error('réseau accessible');
      if (/SECRET123|token@/.test(probe.result)) throw new Error('fichier protégé lisible dans le bac à sable');
      if (fs.existsSync(path.join(OUTSIDE, 'escape.txt'))) throw new Error('écriture hors du projet réussie');
      if (!fs.existsSync(path.join(root, 'src', 'from-sandbox.txt'))) throw new Error('écriture dans le projet impossible');
      ok('bac à sable : dossier personnel invisible, pas de réseau, fichiers protégés masqués, écritures limitées au projet');
    }
    // Arrêt d'une commande hors bac à sable : la commande et ses sous-processus doivent s'arrêter.
    const marker = path.join(OUTSIDE, 'still-running.txt');
    const long = await tools.prepare('run_command', {
      command: process.platform === 'win32'
        ? `Start-Sleep -Seconds 3; Set-Content -Path '${marker}' -Value late`
        : `(sleep 3; echo late > '${marker}') & sleep 30`,
      outsideProject: true,
    });
    const abort = new AbortController();
    const started = Date.now();
    setTimeout(() => abort.abort(), 500);
    const stopped = await long.execute(abort.signal);
    await new Promise((r) => setTimeout(r, 4000));
    if (Date.now() - started > 20_000) throw new Error('commande non arrêtée');
    if (fs.existsSync(marker)) throw new Error("un sous-processus a survécu à l'arrêt");
    ok(`arrêt d'une commande hors bac à sable : processus et sous-processus arrêtés (${stopped.summary})`);
    // Démarrage complet d'une session (préparation de l'environnement comprise), puis arrêt.
    await vscode.commands.executeCommand('promptShare.startSession');
    if (!api.nativeChatActive()) throw new Error("la session n'a pas démarré");
    await vscode.commands.executeCommand('promptShare.stopSession');
    if (api.nativeChatActive()) throw new Error("la session ne s'est pas arrêtée");
    ok('Start Session / Stop Session : préparation de l’environnement puis démarrage et arrêt');
    log.push('RESULT: PASS');
  } catch (err) {
    log.push(`✗ ${(err as Error).message}`, 'RESULT: FAIL');
  }
  fs.writeFileSync(OUT, log.join('\n'));
}
