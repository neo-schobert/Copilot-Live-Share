/**
 * Test d'intégration optionnel (npm run test:tunnel) : ouvre un vrai tunnel depuis la page
 * de l'hôte, vérifie son état et son lien, puis le ferme. Demande Internet et, pour ngrok,
 * un jeton déjà configuré (`ngrok config add-authtoken`). SCC_TUNNEL choisit le service.
 */
import * as fs from 'fs';
import * as https from 'https';
import * as vscode from 'vscode';
import type { PromptShareApi } from '../../src/extension';

const OUT = process.env.SCC_TEST_OUT!;
const PROVIDER = (process.env.SCC_TUNNEL ?? 'ngrok') as 'cloudflare' | 'ngrok';
const log: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ok(message: string): void {
  log.push(`✓ ${message}`);
  fs.writeFileSync(OUT, log.join('\n'));
}

async function until<T>(what: string, fn: () => T | undefined, timeoutMs = 60_000): Promise<T> {
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

function status(url: string): Promise<number> {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'ngrok-skip-browser-warning': 'true' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', () => resolve(-1));
  });
}

export async function run(): Promise<void> {
  let api: PromptShareApi | undefined;
  try {
    api = (await vscode.extensions.getExtension('neo-schobert.prompt-share')!.activate()) as PromptShareApi;
    await vscode.commands.executeCommand('promptShare.openChat');
    await vscode.commands.executeCommand('promptShare.host');
    const hosted = await until('session', () => api!.hostedSession());
    const token = new URL(hosted.inviteLink).searchParams.get('token');
    await until('page de l’hôte connectée', () => api!.sendToSession({ type: 'view', conversationId: 'x' }) || undefined, 30_000);

    api.sendToSession({ type: 'startTunnel', provider: PROVIDER });
    await until('ouverture en cours', () => (api!.hostedSession()?.tunnel.status === 'starting' ? true : undefined), 10_000);
    const on = await until('tunnel ouvert', () => {
      const t = api!.hostedSession()?.tunnel;
      if (t?.status === 'error') throw new Error(`échec du tunnel : ${t.error}`);
      return t?.status === 'on' ? t : undefined;
    });
    if (on.provider !== PROVIDER || !on.url || !on.since) throw new Error(`état inattendu : ${JSON.stringify(on)}`);
    ok(`tunnel ${on.provider} ouvert depuis la page : ${on.url}`);
    const clip = await vscode.env.clipboard.readText();
    if (!clip.startsWith(on.url)) throw new Error(`lien copié inattendu : ${clip}`);
    ok('lien d’invitation copié dans le presse-papier');
    let code = 0;
    for (let i = 0; i < 10 && code !== 200; i++, await sleep(1500)) {
      code = await status(`${on.url}/?token=${token}`);
    }
    if (code !== 200) throw new Error(`page inaccessible par le tunnel (HTTP ${code})`);
    ok('page de la session accessible par le tunnel');

    api.sendToSession({ type: 'stopTunnel' });
    await until('tunnel fermé', () => (api!.hostedSession()?.tunnel.status === 'off' ? true : undefined), 15_000);
    await sleep(2000);
    const after = await status(`${on.url}/?token=${token}`);
    if (after === 200) throw new Error('la page répond encore après la fermeture');
    ok(`tunnel fermé depuis la page : le lien ne répond plus (HTTP ${after})`);
    await vscode.commands.executeCommand('promptShare.stopSession');
    log.push('RESULT: PASS');
  } catch (err) {
    log.push(`✗ ${(err as Error).message}`, `  · journal : ${api?.logs().slice(-10).join(' | ')}`, 'RESULT: FAIL');
  }
  fs.writeFileSync(OUT, log.join('\n'));
}
