/**
 * Test d'intégration exécuté dans un vrai VS Code (voir run.js), API proposées actives :
 * une discussion ouverte dans un onglet du chat natif suit en direct l'activité d'un invité.
 */
import * as fs from 'fs';
import * as vscode from 'vscode';
import { WebSocket } from 'ws';
import type { PromptShareApi } from '../../src/extension';
import type { ServerMessage } from '../../src/protocol';

const OUT = process.env.SCC_TEST_OUT!;
const log: string[] = [];

function ok(message: string): void {
  log.push(`✓ ${message}`);
  fs.writeFileSync(OUT, log.join('\n'));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, check: () => T | undefined, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`délai dépassé : ${what}`);
    }
    await sleep(200);
  }
}

const chatTabs = () =>
  vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof (vscode as unknown as { TabInputChat: new () => unknown }).TabInputChat);

export async function run(): Promise<void> {
  try {
    const api = (await vscode.extensions.getExtension('neo-schobert.prompt-share')!.activate()) as PromptShareApi;
    await vscode.commands.executeCommand('promptShare.startSession');
    if (!api.nativeChatActive()) throw new Error('chat natif inactif');
    const link = new URL(api.hostedSession()!.inviteLink);

    // Un invité rejoint la session par WebSocket, comme la page web.
    const messages: ServerMessage[] = [];
    const ws = new WebSocket(`ws://${link.host}/ws?token=${link.searchParams.get('token')}`);
    await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
    ws.on('message', (d) => messages.push(JSON.parse(d.toString()) as ServerMessage));
    ws.send(JSON.stringify({ type: 'hello', name: 'Alice', clientId: 'alice' }));
    const welcome = await until('welcome', () => messages.find((m) => m.type === 'welcome'));
    const conv = welcome.type === 'welcome' ? welcome.conversations[0] : undefined;
    if (!conv) throw new Error('aucune discussion');
    const ask = (text: string) => ws.send(JSON.stringify({ type: 'ask', conversationId: conv.id, text }));

    await vscode.commands.executeCommand('vscode.open', vscode.Uri.from({ scheme: 'prompt-share', path: `/${conv.id}` }));
    const first = await until('onglet du chat natif', () => chatTabs()[0]);
    ok(`discussion ouverte dans un onglet du chat natif (« ${first.label} »)`);

    // Onglet visible : il est rouvert dès que l'invité écrit.
    ask('Question de Alice');
    const second = await until('onglet rouvert', () => chatTabs().find((t) => t !== first));
    if (chatTabs().length !== 1) throw new Error(`${chatTabs().length} onglets de chat au lieu d'un`);
    if (!second.isActive) throw new Error("l'onglet rouvert n'est pas au premier plan");
    ok(`onglet visible : rouvert avec la question de l'invité (« ${second.label} »)`);

    // Pas de boucle : l'onglet reste stable une fois l'activité terminée.
    let stable = chatTabs()[0];
    await sleep(3000);
    stable = await until('onglet stable', () => {
      const current = chatTabs()[0];
      return current === stable ? current : ((stable = current), undefined);
    });
    await sleep(3000);
    if (chatTabs()[0] !== stable) throw new Error("l'onglet est rouvert en boucle");
    ok('pas de réouverture en boucle');

    // Question d'invité en attente de l'hôte : refusée depuis le chat natif (bouton = commande).
    const pending = messages.find((m) => m.type === 'entry' && m.entry.kind === 'user' && m.entry.text === 'Question de Alice');
    if (pending?.type !== 'entry' || pending.entry.kind !== 'user' || pending.entry.review !== 'pending') {
      throw new Error("la question de l'invité n'attend pas l'accord de l'hôte");
    }
    await vscode.commands.executeCommand('promptShare.reviewQuestion', pending.entry.id, false);
    await until('refus reçu par l’invité', () =>
      messages.find((m) => m.type === 'questionReview' && m.entryId === pending.entry.id && m.review === 'rejected'),
    );
    stable = await until('onglet rouvert après le refus', () => chatTabs().find((t) => t !== stable && t.isActive));
    ok('question d’invité en attente de l’hôte, refusée depuis le chat natif : onglet mis à jour');

    // Onglet masqué : rien ne bouge tant qu'il n'est pas affiché, puis il est rouvert.
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'src', 'a.ts'));
    await vscode.window.showTextDocument(doc, { viewColumn: stable.group.viewColumn, preview: false });
    await until('onglet masqué', () => (!stable.isActive ? true : undefined));
    ask('Deuxième question de Alice');
    await sleep(3000);
    if (chatTabs()[0] !== stable) throw new Error('onglet masqué rouvert alors qu’il est invisible');
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.from({ scheme: 'prompt-share', path: `/${conv.id}` }));
    const third = await until('onglet rouvert à l’affichage', () => chatTabs().find((t) => t !== stable && t.isActive));
    ok(`onglet masqué : laissé en paix, puis rouvert quand il est affiché (« ${third.label} »)`);

    ws.close();
    await vscode.commands.executeCommand('promptShare.stopSession');
    log.push('RESULT: PASS');
  } catch (err) {
    log.push(`✗ ${(err as Error).message}`, 'RESULT: FAIL');
  }
  fs.writeFileSync(OUT, log.join('\n'));
}
