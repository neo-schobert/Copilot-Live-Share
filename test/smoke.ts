/**
 * Test de bout en bout sans VS Code : vrai serveur HTTP/WebSocket et vraie file
 * d'attente, avec un modèle simulé. Lancer avec « npm test ».
 */
import * as assert from 'assert/strict';
import * as http from 'http';
import { WebSocket } from 'ws';
import { ChatRoom, ModelBackend, ModelEvent, ModelRequest, ModelTurn, PendingReview } from '../src/chatRoom';
import { CLOSE_CODES, ServerMessage, SessionPolicy } from '../src/protocol';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installBubblewrapInWsl, parseWslProbe, sandboxCommand, SandboxRuntime, windowsToWsl } from '../src/sandbox';
import { ChatServer } from '../src/server';

const PORT = 37170;
const GUEST = 'guest-token-123';
const HOST = 'host-token-456';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Modèle factice : répond « Réponse à <question> » en plusieurs morceaux. Une
 * question contenant « outil » simule en plus une action d'outil (lecture de fichier).
 */
class FakeBackend implements ModelBackend {
  readonly calls: ModelTurn[][] = [];
  readonly modelIds: (string | undefined)[] = [];

  readonly outcomes: string[] = [];

  async ask({ turns, modelId, interaction, author, authorClientId }: ModelRequest, signal: AbortSignal) {
    this.calls.push(turns);
    this.modelIds.push(modelId);
    const question = turns[turns.length - 1].content.split('\n\n').pop() ?? '';
    const slow = question.includes('lent');
    const outcomes = this.outcomes;
    async function* events(): AsyncGenerator<ModelEvent> {
      // « modifie » : action dans le projet ; « réseau » : commande hors du projet (hôte seul).
      if (question.includes('modifie') || question.includes('réseau')) {
        const hostOnly = question.includes('réseau');
        const tool = {
          id: `a${outcomes.length}`,
          title: hostOnly ? 'Exécuter hors du projet' : 'Modifier src/a.ts',
          status: 'awaitingApproval' as const,
          approval: { kind: hostOnly ? ('command' as const) : ('write' as const), preview: '- a\n+ b', canShowDiff: !hostOnly, hostOnly },
        };
        yield { type: 'tool', tool };
        const outcome = await interaction.approval(tool);
        outcomes.push(`${outcome.decision}:${outcome.by}`);
        yield { type: 'tool', tool: { ...tool, status: outcome.decision === 'deny' ? 'rejected' : 'done', detail: outcome.by } };
      }
      if (question.includes('demande-moi')) {
        const tool = {
          id: 'q1',
          title: 'Question',
          status: 'awaitingAnswer' as const,
          question: { text: 'Quel framework ?', options: ['React', 'Vue'], requesterClientId: authorClientId, requesterName: author },
        };
        yield { type: 'tool', tool };
        const answer = await interaction.answer(tool);
        outcomes.push(`answer:${answer.text}:${answer.by}`);
        yield { type: 'tool', tool: { ...tool, status: 'done', answer: answer.text, answeredBy: answer.by } };
      }
      if (question.includes('outil')) {
        yield { type: 'text', text: 'Je regarde le fichier. ' };
        yield { type: 'tool', tool: { id: 't1', title: 'Lecture de src/a.ts', status: 'running' } };
        await sleep(20);
        yield { type: 'tool', tool: { id: 't1', title: 'Lecture de src/a.ts', status: 'done', detail: '3 lignes' } };
      }
      for (const word of `Réponse à « ${question} » terminée`.split(' ')) {
        if (signal.aborted) {
          return;
        }
        await sleep(slow ? 100 : 15);
        yield { type: 'text', text: `${word} ` };
      }
    }
    return { modelName: modelId ?? 'fake-model', events: events() };
  }
}

class Client {
  readonly messages: ServerMessage[] = [];
  closeCode: number | undefined;
  /** Discussion par défaut, reçue dans le welcome. */
  conv = '';
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.messages.push(JSON.parse(d.toString()) as ServerMessage));
    ws.on('close', (code) => (this.closeCode = code));
  }

  static async join(name: string, token = GUEST): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const c = new Client(ws);
    c.send({ type: 'hello', name, clientId: `${name}-client-id` });
    const welcome = await c.waitFor((m) => m.type === 'welcome');
    if (welcome.type === 'welcome') {
      c.conv = welcome.conversations[0].id;
    }
    return c;
  }

  ask(text: string, extra: object = {}) {
    this.send({ type: 'ask', conversationId: this.conv, text, ...extra });
  }

  send(msg: object) {
    this.ws.send(JSON.stringify(msg));
  }

  async waitFor(pred: (m: ServerMessage) => boolean, timeoutMs = 5000): Promise<ServerMessage> {
    const start = Date.now();
    for (;;) {
      const found = this.messages.find(pred);
      if (found) {
        return found;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error('timeout waiting for message');
      }
      await sleep(10);
    }
  }

  /** Messages liés au contenu du chat (sans welcome/participants, propres à chaque client). */
  chatStream(): string[] {
    return this.messages
      .filter((m) => m.type === 'entry' || m.type === 'chunk' || m.type === 'entryUpdate')
      .map((m) => JSON.stringify(m));
  }
}

function httpGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${PORT}${path}`, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

function wsRejected(path: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('open', () => resolve(101));
    ws.on('error', () => resolve(-1));
  });
}

async function main() {
  const backend = new FakeBackend();
  const policy: SessionPolicy = { reviewGuestQuestions: false, guestQuestionsPerHour: 0 };
  const reviews: PendingReview[] = [];
  const room = new ChatRoom(backend, {
    historyLength: () => 20,
    policy: () => policy,
    onReviewRequested: (pending) => reviews.push(pending),
    onInviteRequested: async (publicUrl, copy) => ({
      publicUrl: publicUrl ?? '',
      localUrl: `http://127.0.0.1:${PORT}`,
      link: `${publicUrl || `http://127.0.0.1:${PORT}`}/?token=${GUEST}`,
      copied: copy,
    }),
  });
  const server = new ChatServer(
    {
      port: PORT,
      guestToken: GUEST,
      hostToken: HOST,
      indexHtml: '<html><script src="client.js?token=__TOKEN__"></script></html>',
      assets: { '/client.js': { contentType: 'text/javascript', body: 'ok' } },
    },
    room,
  );
  await server.start();
  const results: string[] = [];
  const ok = (label: string) => {
    results.push(label);
    console.log(`  ✓ ${label}`);
  };

  // 0. Bac à sable sous Windows + WSL : conversion des chemins et arguments bubblewrap
  assert.equal(windowsToWsl('C:\\Users\\neo\\projet', '/mnt/', 'Ubuntu'), '/mnt/c/Users/neo/projet');
  assert.equal(windowsToWsl('D:\\', '/mnt/', 'Ubuntu'), '/mnt/d');
  assert.equal(windowsToWsl('e:/code/app', '/', ''), '/e/code/app');
  assert.equal(windowsToWsl('\\\\wsl.localhost\\Ubuntu\\home\\neo\\app', '/mnt/', 'Ubuntu'), '/home/neo/app');
  assert.equal(windowsToWsl('\\\\wsl$\\ubuntu\\srv', '/mnt/', 'Ubuntu'), '/srv');
  assert.equal(windowsToWsl('\\\\wsl.localhost\\Debian\\home\\x', '/mnt/', 'Ubuntu'), undefined);
  assert.equal(windowsToWsl('\\\\serveur\\partage\\x', '/mnt/', 'Ubuntu'), undefined);
  const wsl: SandboxRuntime = {
    kind: 'wsl',
    description: 'Linux (WSL : Ubuntu)',
    launcher: 'wsl.exe',
    prefix: ['-d', 'Ubuntu', '-e', '/usr/bin/bwrap'],
    rootEntries: [{ path: '/bin', link: 'usr/bin' }],
    pathDirs: ['/home/neo/.nvm/versions/node/v22/bin'],
    readOnly: ['/home/neo/.nvm/versions/node/v22'],
    toSandbox: (p) => windowsToWsl(p, '/mnt/', 'Ubuntu'),
  };
  const args = sandboxCommand(
    wsl,
    { folders: ['C:\\dev\\app'], hidden: [{ path: 'C:\\dev\\app\\.env', dir: false }], cwd: 'C:\\dev\\app\\src' },
    'npm test',
  );
  const at = (seq: string[]) => args.findIndex((_, i) => seq.every((v, j) => args[i + j] === v));
  assert.deepEqual(args.slice(0, 4), ['-d', 'Ubuntu', '-e', '/usr/bin/bwrap']);
  assert.ok(args.includes('--unshare-all') && args.includes('--clearenv'));
  assert.ok(at(['--bind', '/mnt/c/dev/app', '/mnt/c/dev/app']) >= 0);
  assert.ok(at(['--ro-bind', '/dev/null', '/mnt/c/dev/app/.env']) > at(['--bind', '/mnt/c/dev/app', '/mnt/c/dev/app']), 'masque après le montage du projet');
  assert.ok(at(['--chdir', '/mnt/c/dev/app/src']) >= 0);
  assert.ok(at(['--setenv', 'PATH', '/home/neo/.nvm/versions/node/v22/bin:/usr/local/bin:/usr/bin:/bin']) >= 0);
  assert.deepEqual(args.slice(-3), ['/bin/sh', '-c', 'npm test']);
  assert.ok(!args.some((a) => a.startsWith('/home/neo') && !a.includes('.nvm')), 'rien du dossier personnel hors chaîne d’outils');
  assert.throws(() => sandboxCommand(wsl, { folders: ['\\\\serveur\\x'], hidden: [], cwd: '\\\\serveur\\x' }, 'ls'), /inaccessible/);
  ok('Bac à sable WSL : chemins Windows convertis (C:, \\\\wsl.localhost), fichiers protégés masqués après le montage');

  // 0 bis. Sonde WSL : diagnostic et environnement du bac à sable
  const head = 'DISTRO Ubuntu\nHOME /home/neo\nMOUNT /mnt/c/\n';
  assert.equal(parseWslProbe(`${head}NOBWRAP\n`, 'wsl.exe', '').status, 'noBubblewrap');
  const wsl1 = parseWslProbe(`${head}BWRAPFAIL\n`, 'wsl.exe', '');
  assert.equal(wsl1.status, 'bubblewrapFails');
  assert.match(wsl1.detail, /wsl --set-version Ubuntu 2/);
  const ready = parseWslProbe(
    `${head}BWRAP /usr/bin/bwrap\nLINK /bin usr/bin\nDIR /etc\nPATHDIR /home/neo/.nvm/versions/node/v22/bin\nNODEROOT /home/neo/.nvm/versions/node/v22\n` +
      'PATHDIR /usr/bin\nPATHDIR /mnt/c/Windows/system32\nPATHDIR /home/neo\n',
    'wsl.exe',
    'Ubuntu',
  );
  assert.equal(ready.status, 'ready');
  assert.equal(ready.distro, 'Ubuntu');
  assert.deepEqual(ready.runtime?.pathDirs, ['/home/neo/.nvm/versions/node/v22/bin'], 'ni /usr, ni lecteurs Windows, ni dossier personnel');
  assert.deepEqual(ready.runtime?.readOnly, ['/home/neo/.nvm/versions/node/v22']);
  assert.deepEqual(ready.runtime?.prefix, ['-d', 'Ubuntu', '-e', '/usr/bin/bwrap']);
  assert.equal(ready.runtime?.toSandbox('C:\\dev\\app'), '/mnt/c/dev/app');
  const customMount = parseWslProbe('DISTRO Debian\nHOME /home/x\nMOUNT /c/\nBWRAP /usr/bin/bwrap\n', 'wsl.exe', '');
  assert.equal(customMount.mountRoot, '/');
  assert.equal(customMount.runtime?.toSandbox('C:\\dev'), '/c/dev');
  // Installation de bubblewrap : exécutée en root dans la distribution choisie.
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-fake-wsl-'));
  const fake = path.join(fakeDir, 'wsl.sh');
  fs.writeFileSync(fake, '#!/bin/sh\necho "ARGS $1 $2 $3 $4 $5 $6"\n', { mode: 0o755 });
  const installLog: string[] = [];
  assert.ok(await installBubblewrapInWsl('Ubuntu', (m) => installLog.push(m), fake));
  assert.match(installLog.join('\n'), /ARGS -d Ubuntu -u root -e sh/);
  fs.rmSync(fakeDir, { recursive: true, force: true });
  ok('Sonde WSL : bubblewrap absent, WSL 1, prêt (PATH filtré, montage personnalisé) ; installation en root');

  // 1. Authentification HTTP
  assert.equal((await httpGet('/')).status, 401);
  assert.equal((await httpGet('/?token=wrong')).status, 401);
  assert.equal((await httpGet('/client.js')).status, 401);
  const page = await httpGet(`/?token=${GUEST}`);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(`client.js?token=${GUEST}`));
  assert.equal((await httpGet(`/client.js?token=${GUEST}`)).status, 200);
  ok('HTTP : 401 sans token ou avec un mauvais token, 200 avec le bon');

  // 2. Authentification WebSocket
  assert.equal(await wsRejected('/ws'), 401);
  assert.equal(await wsRejected('/ws?token=wrong'), 401);
  assert.equal(await wsRejected(`/other?token=${GUEST}`), 401);
  ok('WebSocket : connexion refusée (401) sans token ou avec un mauvais token');

  // 3. Deux clients, deux questions simultanées : FIFO et même flux pour tous
  const alice = await Client.join('alice');
  const bob = await Client.join('bob');
  await alice.waitFor((m) => m.type === 'participants' && m.participants.length === 2);
  alice.ask('Question 1');
  bob.ask('Question 2');

  const doneCount = (c: Client) => c.messages.filter((m) => m.type === 'entryUpdate' && m.status === 'done').length;
  for (let i = 0; i < 300 && (doneCount(alice) < 2 || doneCount(bob) < 2); i++) {
    await sleep(10);
  }
  assert.equal(doneCount(alice), 2);
  assert.deepEqual(alice.chatStream(), bob.chatStream());
  ok('Deux navigateurs reçoivent exactement les mêmes messages et chunks');

  const events = alice.messages.filter((m) => m.type === 'entry' || m.type === 'entryUpdate');
  const assistantIds = events.flatMap((m) => (m.type === 'entry' && m.entry.kind === 'assistant' ? [m.entry] : []));
  assert.equal(assistantIds.length, 2);
  const firstDone = events.findIndex((m) => m.type === 'entryUpdate' && m.entryId === assistantIds[0].id && m.status === 'done');
  const secondStart = events.findIndex((m) => m.type === 'entry' && m.entry.id === assistantIds[1].id);
  assert.ok(firstDone < secondStart, 'la 2e réponse démarre après la fin de la 1re');
  assert.equal(assistantIds[0].replyToAuthor, 'alice');
  assert.equal(assistantIds[1].replyToAuthor, 'bob');
  const q = alice.messages.find((m) => m.type === 'queue' && m.queue.pending.length === 1);
  assert.ok(q, 'la file a exposé une question en attente');
  ok('Questions simultanées traitées une par une, dans l’ordre (FIFO)');

  // 4. Historique envoyé au modèle, préfixé par le pseudo
  const lastCall = backend.calls[1];
  assert.ok(lastCall.some((t) => t.role === 'user' && t.content.includes('alice: Question 1')));
  assert.ok(lastCall.some((t) => t.role === 'assistant' && t.content.includes('Question 1')));
  assert.ok(lastCall[lastCall.length - 1].content.endsWith('bob: Question 2'));
  ok('Historique envoyé au modèle avec le pseudo de chaque auteur');

  // 5. Contexte partagé
  room.addContext(alice.conv, { author: 'hôte', fileName: 'src/a.ts', languageId: 'typescript', range: 'lignes 1-2', code: 'const a = 1;' });
  await bob.waitFor((m) => m.type === 'entry' && m.entry.kind === 'context');
  ok('Contexte partagé diffusé à tous');

  // 6. Annulation : refusée pour un invité, acceptée pour l'hôte
  const host = await Client.join('hote', HOST);
  bob.ask('Question lente');
  await bob.waitFor((m) => m.type === 'chunk' && m.text.includes('Question'));
  bob.send({ type: 'cancel' });
  await bob.waitFor((m) => m.type === 'error' && m.message.includes("l'hôte"));
  host.send({ type: 'cancel' });
  await alice.waitFor((m) => m.type === 'entryUpdate' && m.status === 'cancelled');
  assert.ok(backend.calls[2].some((t) => t.content.includes('src/a.ts')), 'le contexte est envoyé au modèle');
  ok('Seul l’hôte peut annuler ; la réponse passe à « cancelled »');

  // 7. Discussions : création, historique séparé, renommage, suppression par l'hôte
  alice.send({ type: 'createConversation' });
  const created = await alice.waitFor((m) => m.type === 'conversation' && m.conversation.createdBy === 'alice');
  assert.ok(created.type === 'conversation');
  const conv2 = created.conversation.id;
  await bob.waitFor((m) => m.type === 'conversation' && m.conversation.id === conv2);
  const before = backend.calls.length;
  alice.send({ type: 'ask', conversationId: conv2, text: 'Question dans la discussion 2' });
  await alice.waitFor((m) => m.type === 'conversation' && m.conversation.id === conv2 && m.conversation.title === 'Question dans la discussion 2');
  for (let i = 0; i < 300 && backend.calls.length === before; i++) {
    await sleep(10);
  }
  const isolated = backend.calls[before];
  assert.ok(!isolated.some((t) => t.content.includes('Question 1')), "l'historique de la discussion 1 ne fuit pas");
  assert.ok(!isolated.some((t) => t.content.includes('src/a.ts')), 'le contexte de la discussion 1 ne fuit pas');
  ok('Nouvelle discussion : titre automatique, historique du modèle séparé');

  bob.send({ type: 'renameConversation', conversationId: conv2, title: '  Renommée  ' });
  await alice.waitFor((m) => m.type === 'conversation' && m.conversation.id === conv2 && m.conversation.title === 'Renommée');
  bob.send({ type: 'view', conversationId: conv2 });
  await alice.waitFor((m) => m.type === 'participants' && m.participants.some((p) => p.name === 'bob' && p.viewing === conv2));
  bob.send({ type: 'deleteConversation', conversationId: conv2 });
  await bob.waitFor((m) => m.type === 'error' && m.message.includes('supprimer'));
  host.send({ type: 'deleteConversation', conversationId: conv2 });
  await alice.waitFor((m) => m.type === 'conversationDeleted' && m.conversationId === conv2);
  ok('Renommage par tous, présence par discussion, suppression réservée à l’hôte');

  // 8. Choix du modèle
  const available = [
    { id: 'model-a', name: 'Model A', family: 'a' },
    { id: 'model-b', name: 'Model B', family: 'b' },
  ];
  room.setModels({ available, defaultId: 'model-a', guestsCanChoose: true });
  await alice.waitFor((m) => m.type === 'models' && m.models.available.length === 2);
  const waitIdle = async () => {
    for (let i = 0; i < 300 && room.isAnswering; i++) {
      await sleep(10);
    }
  };
  await waitIdle();
  alice.ask('Question modèle B', { modelId: 'model-b' });
  await alice.waitFor((m) => m.type === 'entryUpdate' && m.model === 'model-b' && m.status === 'done');
  alice.ask('Question modèle par défaut');
  await alice.waitFor((m) => m.type === 'entryUpdate' && m.model === 'model-a' && m.status === 'done');
  alice.ask('Question modèle inconnu', { modelId: 'nope' });
  await alice.waitFor((m) => m.type === 'error' && m.message.includes("n'est plus disponible"));
  room.setModels({ available, defaultId: 'model-a', guestsCanChoose: false });
  await bob.waitFor((m) => m.type === 'models' && !m.models.guestsCanChoose);
  bob.ask('Invité veut B', { modelId: 'model-b' });
  await bob.waitFor((m) => m.type === 'error' && m.message.includes('fixé le modèle'));
  host.ask('Hôte veut B', { modelId: 'model-b' });
  await host.waitFor((m) => m.type === 'entryUpdate' && m.status === 'done' && backend.modelIds.at(-1) === 'model-b');
  ok('Choix du modèle par question, modèle par défaut, restriction des invités');

  // 9. Actions d'outils et API hôte utilisée par le chat natif
  const local: ServerMessage[] = [];
  const unsubscribe = room.subscribe((m) => local.push(m));
  const hostQuestion = room.askAsHost(alice.conv, 'Utilise un outil stp', 'neo');
  await alice.waitFor((m) => m.type === 'tool' && m.tool.status === 'done');
  const toolAnswer = await alice.waitFor((m) => m.type === 'entryUpdate' && m.status === 'done' && room.answerTo(hostQuestion)?.id === m.entryId);
  assert.ok(toolAnswer);
  const answer = room.answerTo(hostQuestion)!;
  assert.deepEqual(answer.parts.map((p) => p.type), ['text', 'tool', 'text']);
  assert.equal(answer.parts[1].type === 'tool' && answer.parts[1].tool.status, 'done');
  assert.ok(!answer.text.includes('Lecture'), "le texte envoyé au modèle n'inclut pas les actions d'outils");
  assert.ok(local.some((m) => m.type === 'chunk') && local.some((m) => m.type === 'tool'), 'les abonnés locaux reçoivent le flux');
  assert.ok(alice.messages.some((m) => m.type === 'entry' && m.entry.kind === 'user' && m.entry.author === 'neo' && m.entry.isHost));
  ok("Actions d'outils diffusées et entrelacées au texte ; question de l'hôte depuis VS Code");

  const slowId = room.askAsHost(alice.conv, 'Encore une question lente', 'neo');
  const queuedId = room.askAsHost(alice.conv, 'Question à retirer', 'neo');
  room.cancelQuestion(queuedId);
  await alice.waitFor((m) => m.type === 'entry' && m.entry.kind === 'system' && m.entry.text.includes('retirée'));
  room.cancelQuestion(slowId);
  await alice.waitFor((m) => m.type === 'entryUpdate' && m.status === 'cancelled' && room.answerTo(slowId)?.id === m.entryId);
  assert.equal(room.answerTo(queuedId), undefined);
  unsubscribe();
  ok('Annulation depuis VS Code : réponse en cours arrêtée, question en attente retirée');

  // 10. Validations : auteur ou hôte dans le projet, hôte seul hors du projet ; questions de l'agent
  const toolMsg = (c: Client, status: string) =>
    c.waitFor((m) => m.type === 'tool' && m.tool.status === status && !c.messages.slice(c.messages.indexOf(m) + 1).some((n) => n.type === 'tool' && n.tool.id === m.tool.id));
  const lastTool = async (c: Client, status: string) => {
    const m = await toolMsg(c, status);
    return m.type === 'tool' ? m : undefined;
  };
  const waitAnswered = async (count: number) => {
    for (let i = 0; i < 300 && backend.outcomes.length < count; i++) {
      await sleep(10);
    }
  };

  alice.messages.length = 0;
  bob.messages.length = 0;
  host.messages.length = 0;
  alice.ask('Stp modifie le fichier');
  const pending1 = (await lastTool(bob, 'awaitingApproval'))!;
  bob.send({ type: 'approve', entryId: pending1.entryId, toolId: pending1.tool.id, decision: 'once' });
  await bob.waitFor((m) => m.type === 'error' && m.message.includes("l'auteur de la demande"));
  alice.send({ type: 'approve', entryId: pending1.entryId, toolId: pending1.tool.id, decision: 'session' });
  await alice.waitFor((m) => m.type === 'error' && m.message.includes('toute la session'));
  alice.send({ type: 'approve', entryId: pending1.entryId, toolId: pending1.tool.id, decision: 'once' });
  await waitAnswered(1);
  assert.equal(backend.outcomes[0], 'once:alice');
  ok("Action dans le projet : validée par l'auteur ; refusée à un tiers ; « pour la session » réservé à l'hôte");

  await waitIdle();
  alice.ask('Installe via le réseau');
  const pending2 = (await lastTool(alice, 'awaitingApproval'))!;
  assert.equal(pending2.tool.approval?.hostOnly, true);
  alice.send({ type: 'approve', entryId: pending2.entryId, toolId: pending2.tool.id, decision: 'once' });
  await alice.waitFor((m) => m.type === 'error' && m.message.includes('sort du projet'));
  host.send({ type: 'approve', entryId: pending2.entryId, toolId: pending2.tool.id, decision: 'deny' });
  await waitAnswered(2);
  assert.equal(backend.outcomes[1], 'deny:hote');
  ok("Commande hors du projet : seul l'hôte peut décider (refus de l'hôte transmis à l'agent)");

  await waitIdle();
  alice.ask('Stp demande-moi le framework');
  const pending3 = (await lastTool(bob, 'awaitingAnswer'))!;
  assert.equal(pending3.tool.question?.text, 'Quel framework ?', 'la question est visible par un autre participant');
  bob.send({ type: 'answer', entryId: pending3.entryId, toolId: pending3.tool.id, text: 'Vue' });
  await waitAnswered(3);
  assert.equal(backend.outcomes[2], 'answer:Vue:bob');
  alice.send({ type: 'answer', entryId: pending3.entryId, toolId: pending3.tool.id, text: 'React' });
  await alice.waitFor((m) => m.type === 'error' && m.message.includes("n'attend plus"));
  await alice.waitFor((m) => m.type === 'tool' && m.tool.id === 'q1' && m.tool.answer === 'Vue' && m.tool.answeredBy === 'bob');
  ok("Question de l'agent : visible par tous, n'importe qui répond, la première réponse l'emporte et revient à l'agent");

  await waitIdle();
  alice.ask('Stp modifie encore');
  const pending4 = (await lastTool(host, 'awaitingApproval'))!;
  assert.ok(room.pendingApproval(pending4.entryId, pending4.tool.id));
  host.send({ type: 'cancel' });
  await waitAnswered(4);
  assert.equal(backend.outcomes[3], 'deny:');
  assert.equal(room.pendingApproval(pending4.entryId, pending4.tool.id), undefined);
  ok("Annulation pendant une validation : l'action est refusée et la file repart");

  // 10 bis. Lien d'invitation depuis la page : réservé à l'hôte
  bob.send({ type: 'invite', copy: true });
  await bob.waitFor((m) => m.type === 'error' && m.message.includes("lien d'invitation"));
  host.send({ type: 'invite', publicUrl: 'https://demo.ngrok-free.app', copy: true });
  const invite = await host.waitFor((m) => m.type === 'invite');
  assert.ok(invite.type === 'invite' && invite.copied && invite.link === `https://demo.ngrok-free.app/?token=${GUEST}`);
  assert.ok(!bob.messages.some((m) => m.type === 'invite'), "le lien n'est envoyé qu'à l'hôte");
  ok("Lien d'invitation depuis le chat : réservé à l'hôte, envoyé à lui seul");

  // 11. Reconnexion avec le même pseudo : historique complet renvoyé
  bob.ws.close();
  await host.waitFor((m) => m.type === 'participants' && m.participants.length === 2);
  const bob2 = await Client.join('bob');
  const welcome = bob2.messages.find((m) => m.type === 'welcome');
  assert.ok(welcome && welcome.type === 'welcome');
  assert.equal(welcome.you.clientId, 'bob-client-id');
  assert.ok(welcome.history.length >= 6);
  ok('Reconnexion : même identité et historique complet');

  // 11 bis. Questions des invités soumises à l'hôte avant l'envoi au modèle
  policy.reviewGuestQuestions = true;
  policy.guestQuestionsPerHour = 1000;
  await waitIdle();
  const askAndGet = async (who: Client, text: string) => {
    who.ask(text);
    const m = await host.waitFor((x) => x.type === 'entry' && x.entry.kind === 'user' && x.entry.text === text);
    return m.type === 'entry' && m.entry.kind === 'user' ? m.entry : assert.fail('entrée attendue');
  };
  const calls = backend.calls.length;
  const toReview = await askAndGet(alice, 'Question à valider');
  assert.equal(toReview.review, 'pending');
  assert.deepEqual(
    reviews.map((r) => [r.entryId, r.author, r.text]),
    [[toReview.id, 'alice', 'Question à valider']],
    "l'extension est prévenue pour notifier l'hôte",
  );
  await sleep(100);
  assert.equal(backend.calls.length, calls, "rien n'est envoyé au modèle avant l'accord");
  bob2.send({ type: 'reviewQuestion', entryId: toReview.id, accept: true });
  await bob2.waitFor((m) => m.type === 'error' && m.message.includes("Seul l'hôte"));
  alice.send({ type: 'reviewQuestion', entryId: toReview.id, accept: true });
  await alice.waitFor((m) => m.type === 'error' && m.message.includes("Seul l'hôte"));
  host.send({ type: 'reviewQuestion', entryId: toReview.id, accept: true });
  await alice.waitFor((m) => m.type === 'questionReview' && m.entryId === toReview.id && m.review === 'approved' && m.by === 'hote');
  await alice.waitFor((m) => m.type === 'entry' && m.entry.kind === 'assistant' && m.entry.replyTo === toReview.id);
  await waitIdle();
  assert.equal(backend.calls.length, calls + 1);

  const refused = await askAndGet(alice, 'Question refusée');
  assert.ok(room.awaitingReviewOf(refused.id));
  assert.ok(room.reviewQuestion(refused.id, false, 'hote'));
  await alice.waitFor((m) => m.type === 'questionReview' && m.entryId === refused.id && m.review === 'rejected');
  assert.ok(!room.reviewQuestion(refused.id, true, 'hote'), 'une décision ne se prend qu’une fois');
  await sleep(100);
  assert.equal(backend.calls.length, calls + 1, 'question refusée : jamais envoyée au modèle');
  assert.ok(!room.entriesOf(refused.conversationId).some((e) => e.kind === 'assistant' && e.replyTo === refused.id));

  const own = await askAndGet(host, "Question de l'hôte");
  assert.equal(own.review, undefined, "les questions de l'hôte partent directement");
  await waitIdle();
  assert.equal(backend.calls.length, calls + 2);
  const welcomeAgain = (await Client.join('carol')).messages.find((m) => m.type === 'welcome');
  assert.ok(welcomeAgain?.type === 'welcome' && welcomeAgain.policy.reviewGuestQuestions, 'règles transmises aux arrivants');
  ok("Questions d'invités : envoyées au modèle seulement après l'accord de l'hôte, refus définitif, hôte non concerné");

  // 11 ter. Limite horaire des questions d'invités (pour toute la session)
  policy.guestQuestionsPerHour = 1;
  alice.ask('Une de trop');
  await alice.waitFor((m) => m.type === 'error' && m.message.includes('limité les questions des invités à 1 par heure') && m.message.includes('min'));
  assert.ok(!host.messages.some((m) => m.type === 'entry' && m.entry.kind === 'user' && m.entry.text === 'Une de trop'));
  policy.reviewGuestQuestions = false;
  bob2.ask('Sans validation mais limitée');
  await bob2.waitFor((m) => m.type === 'error' && m.message.includes('limité'));
  await askAndGet(host, "L'hôte n'est pas limité");
  await waitIdle();
  assert.equal(backend.calls.length, calls + 3);
  policy.guestQuestionsPerHour = 0;
  ok("Limite horaire : questions d'invités refusées au-delà, avec le délai d'attente ; l'hôte n'est pas limité");

  // 12. Arrêt : tous les clients sont prévenus et déconnectés
  room.dispose("L'hôte a arrêté la session.");
  await server.stop('Session ended');
  await sleep(50);
  for (const c of [alice, host, bob2]) {
    assert.ok(c.messages.some((m) => m.type === 'sessionEnded'));
    assert.equal(c.closeCode, CLOSE_CODES.sessionEnded);
  }
  assert.equal(await wsRejected(`/ws?token=${GUEST}`), -1);
  ok('Arrêt de session : clients notifiés, sockets fermées (code 4000), port libéré');

  console.log(`\n${results.length} vérifications réussies.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
