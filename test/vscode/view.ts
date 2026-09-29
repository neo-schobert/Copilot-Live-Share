/**
 * Test d'intégration de la vue « Prompt Share » avec deux VS Code (voir run.js --view) :
 * l'un héberge une session, l'autre la rejoint depuis sa vue, sans navigateur.
 * La synchronisation entre les deux instances passe par des fichiers.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import type { PromptShareApi } from '../../src/extension';

const OUT = process.env.SCC_TEST_OUT!;
const SYNC = process.env.SCC_TEST_SYNC!;
const ROLE = process.env.SCC_VIEW_ROLE as 'host' | 'guest';
const GUEST_NAME = 'Invité VS Code';
const log: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const QUESTION = 'Question de test depuis VS Code';
const sync = (name: string) => path.join(SYNC, name);
const flag = (name: string) => fs.writeFileSync(sync(name), 'ok');
const flagged = (name: string) => fs.existsSync(sync(name)) || undefined;
const APP_PORT = 37195;

function httpGet(port: number, pathName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${pathName}`, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

/** Onglets d'éditeur Prompt Share (webviews) ouverts dans cette fenêtre. */
const chatTabs = () =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('promptShare.chat'));

function ok(message: string): void {
  log.push(`✓ [${ROLE}] ${message}`);
  fs.writeFileSync(OUT, log.join('\n'));
}

async function until<T>(what: string, fn: () => T | undefined, timeoutMs = 90_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) {
      return value;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`délai dépassé : ${what}`);
    }
    await sleep(250);
  }
}

export async function run(): Promise<void> {
  const linkFile = path.join(SYNC, 'invite.txt');
  const doneFile = path.join(SYNC, 'done.txt');
  try {
    const ext = vscode.extensions.getExtension('neo-schobert.prompt-share')!;
    const api = (await ext.activate()) as PromptShareApi;
    ok(`extension activée (API proposées : ${ext.packageJSON.enabledApiProposals ? 'oui' : 'non, version Marketplace'})`);
    await vscode.commands.executeCommand('promptShare.openChat');
    ok('vue « Prompt Share » ouverte');

    if (ROLE === 'host') {
      await vscode.commands.executeCommand('promptShare.host');
      const hosted = await until('démarrage de la session', () => api.hostedSession());
      if (api.viewState().mode !== 'host') throw new Error(`vue en mode ${api.viewState().mode}`);
      ok(`session hébergée, vue en mode hôte ; lien ${hosted.inviteLink.replace(/token=.*/, 'token=…')}`);
      fs.writeFileSync(linkFile, hosted.inviteLink);
      const names = await until(`arrivée de « ${GUEST_NAME} »`, () => {
        const p = api.hostedSession()?.participants ?? [];
        return p.includes(GUEST_NAME) ? p : undefined;
      });
      ok(`participants vus par l'hôte : ${names.join(', ')}`);

      // Question de l'invité : décision en attente (pastille, barre d'état, notification).
      await until("décision en attente pour l'hôte", () => api.pendingDecisions() === 1 || undefined, 30_000);
      const [questionId] = await until('question en attente', () => {
        const ids = api.hostedSession()?.awaitingReview ?? [];
        return ids.length ? ids : undefined;
      });
      ok("question de l'invité : 1 décision en attente pour l'hôte (pastille et barre d'état)");

      // Discussion ouverte dans un onglet d'éditeur, titré comme la discussion.
      const conv = api.conversations()[0];
      api.openTab(conv.id);
      const tab = await until("onglet de l'hôte titré", () => chatTabs().find((t) => t.label === QUESTION), 30_000);
      if (api.openTabs().join() !== conv.id) throw new Error(`onglets : ${api.openTabs().join()}`);
      ok(`discussion ouverte dans un onglet d'éditeur (« ${tab.label} », groupe ${tab.group.viewColumn})`);
      api.openTab(conv.id);
      await sleep(500);
      if (chatTabs().length !== 1) throw new Error('onglet dupliqué');

      await vscode.commands.executeCommand('promptShare.reviewQuestion', questionId, false);
      await until('plus de décision en attente', () => api.pendingDecisions() === 0 || undefined, 10_000);
      ok('question refusée : la décision disparaît de la pastille');
      flag('refused.txt');

      await until("onglet de l'invité", () => flagged('guest-tab.txt'));
      const after = api.hostedSession()?.participants ?? [];
      if (after.length !== 2) throw new Error(`participants après l'ouverture des onglets : ${after.join(', ')}`);
      ok(`vue et onglets d'un même participant : toujours ${after.length} participants (${after.join(', ')})`);

      // Application locale de l'hôte, partagée depuis le chat.
      const app = http.createServer((req, res) => res.end(`app-hote:${req.url}`));
      await new Promise<void>((r) => app.listen(APP_PORT, '127.0.0.1', () => r()));
      if (!api.sendToSession({ type: 'shareApp', port: APP_PORT, label: 'Serveur de dev' })) throw new Error('partage non envoyé');
      flag('app-shared.txt');
      const body = await until("l'invité ouvre l'application", () => (fs.existsSync(sync('app-ok.txt')) ? fs.readFileSync(sync('app-ok.txt'), 'utf8') : undefined), 30_000);
      if (body !== 'app-hote:/depuis-invite') throw new Error(`réponse de l'application chez l'invité : ${body}`);
      ok("application de l'hôte (localhost:37195) partagée et ouverte chez l'invité par le relais");
      app.close();
      fs.writeFileSync(doneFile, 'ok');
    } else {
      const link = await until("lien d'invitation de l'hôte", () => (fs.existsSync(linkFile) ? fs.readFileSync(linkFile, 'utf8') : undefined));
      await api.join(link, GUEST_NAME);
      if (api.viewState().mode !== 'guest') throw new Error(`vue en mode ${api.viewState().mode}`);
      ok('lien collé, vue en mode invité');
      const conv = await until('discussions de la session', () => api.conversations()[0], 30_000);
      await until('question envoyée', () => api.sendToSession({ type: 'ask', conversationId: conv.id, text: QUESTION }) || undefined, 30_000);
      ok("question envoyée à l'hôte");
      await until("refus de l'hôte", () => flagged('refused.txt'));
      api.openTab(conv.id);
      const tab = await until("onglet de l'invité titré", () => chatTabs().find((t) => t.label === QUESTION), 30_000);
      ok(`invité : discussion ouverte dans un onglet d'éditeur (« ${tab.label} »)`);
      await sleep(1500); // Laisse l'onglet se connecter avant la vérification de l'hôte.
      flag('guest-tab.txt');
      await until("application partagée par l'hôte", () => flagged('app-shared.txt'));
      await sleep(500);
      const localPort = await api.localPortOfApp(APP_PORT);
      const body = await httpGet(localPort, '/depuis-invite');
      fs.writeFileSync(sync('app-ok.txt'), body);
      ok(`application de l'hôte ouverte sur localhost:${localPort} (relais) : « ${body} »`);
      await until("confirmation de l'hôte", () => fs.existsSync(doneFile) || undefined);
      ok("l'hôte voit ce participant : session rejointe depuis VS Code, sans navigateur");
    }
    log.push('RESULT: PASS');
  } catch (err) {
    const api = vscode.extensions.getExtension('neo-schobert.prompt-share')?.exports as PromptShareApi | undefined;
    log.push(`✗ [${ROLE}] ${(err as Error).message}`, `  · évènements de la vue : ${api?.viewEvents().join(' | ') || 'aucun'}`,
      `  · journal : ${api?.logs().slice(-12).join(' | ') || 'vide'}`, 'RESULT: FAIL');
  }
  fs.writeFileSync(OUT, log.join('\n'));
}
