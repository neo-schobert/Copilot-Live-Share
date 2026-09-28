/**
 * Test de bout en bout sans VS Code : vrai serveur HTTP/WebSocket et vraie file
 * d'attente, avec un modèle simulé. Lancer avec « npm test ».
 */
import * as assert from 'assert/strict';
import * as http from 'http';
import { WebSocket } from 'ws';
import { ChatRoom, ModelBackend, ModelEvent, ModelRequest, ModelTurn } from '../src/chatRoom';
import { CLOSE_CODES, ServerMessage } from '../src/protocol';
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

  async ask({ turns, modelId }: ModelRequest, signal: AbortSignal) {
    this.calls.push(turns);
    this.modelIds.push(modelId);
    const question = turns[turns.length - 1].content.split('\n\n').pop() ?? '';
    const slow = question.includes('lent');
    async function* events(): AsyncGenerator<ModelEvent> {
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
  const room = new ChatRoom(backend, { historyLength: () => 20 });
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

  // 10. Reconnexion avec le même pseudo : historique complet renvoyé
  bob.ws.close();
  await host.waitFor((m) => m.type === 'participants' && m.participants.length === 2);
  const bob2 = await Client.join('bob');
  const welcome = bob2.messages.find((m) => m.type === 'welcome');
  assert.ok(welcome && welcome.type === 'welcome');
  assert.equal(welcome.you.clientId, 'bob-client-id');
  assert.ok(welcome.history.length >= 6);
  ok('Reconnexion : même identité et historique complet');

  // 11. Arrêt : tous les clients sont prévenus et déconnectés
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
