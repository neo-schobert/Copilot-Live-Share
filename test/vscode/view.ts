/**
 * Test d'intégration de la vue « Shared Copilot » avec deux VS Code (voir run.js --view) :
 * l'un héberge une session, l'autre la rejoint depuis sa vue, sans navigateur.
 * La synchronisation entre les deux instances passe par des fichiers.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SharedCopilotApi } from '../../src/extension';

const OUT = process.env.SCC_TEST_OUT!;
const SYNC = process.env.SCC_TEST_SYNC!;
const ROLE = process.env.SCC_VIEW_ROLE as 'host' | 'guest';
const GUEST_NAME = 'Invité VS Code';
const log: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    const ext = vscode.extensions.getExtension('neo-schobert.shared-copilot-chat')!;
    const api = (await ext.activate()) as SharedCopilotApi;
    ok(`extension activée (API proposées : ${ext.packageJSON.enabledApiProposals ? 'oui' : 'non, version Marketplace'})`);
    await vscode.commands.executeCommand('sharedCopilotChat.openChat');
    ok('vue « Shared Copilot » ouverte');

    if (ROLE === 'host') {
      await vscode.commands.executeCommand('sharedCopilotChat.host');
      const hosted = await until('démarrage de la session', () => api.hostedSession());
      if (api.viewState().mode !== 'host') throw new Error(`vue en mode ${api.viewState().mode}`);
      ok(`session hébergée, vue en mode hôte ; lien ${hosted.inviteLink.replace(/token=.*/, 'token=…')}`);
      fs.writeFileSync(linkFile, hosted.inviteLink);
      const names = await until(`arrivée de « ${GUEST_NAME} »`, () => {
        const p = api.hostedSession()?.participants ?? [];
        return p.includes(GUEST_NAME) ? p : undefined;
      });
      ok(`participants vus par l'hôte : ${names.join(', ')}`);
      fs.writeFileSync(doneFile, 'ok');
    } else {
      const link = await until("lien d'invitation de l'hôte", () => (fs.existsSync(linkFile) ? fs.readFileSync(linkFile, 'utf8') : undefined));
      await api.join(link, GUEST_NAME);
      if (api.viewState().mode !== 'guest') throw new Error(`vue en mode ${api.viewState().mode}`);
      ok('lien collé, vue en mode invité');
      await until("confirmation de l'hôte", () => fs.existsSync(doneFile) || undefined);
      ok("l'hôte voit ce participant : session rejointe depuis VS Code, sans navigateur");
    }
    log.push('RESULT: PASS');
  } catch (err) {
    const api = vscode.extensions.getExtension('neo-schobert.shared-copilot-chat')?.exports as SharedCopilotApi | undefined;
    log.push(`✗ [${ROLE}] ${(err as Error).message}`, `  · évènements de la vue : ${api?.viewEvents().join(' | ') || 'aucun'}`, 'RESULT: FAIL');
  }
  fs.writeFileSync(OUT, log.join('\n'));
}
