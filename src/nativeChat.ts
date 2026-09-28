import * as vscode from 'vscode';
import type { ChatRoom } from './chatRoom';
import type { AssistantEntry, ChatEntry, Conversation, QueueState, ServerMessage, ToolActivity, UserEntry } from './protocol';

/**
 * Affiche les discussions de la session dans le panneau Chat natif de VS Code
 * (API proposée « chatSessionsProvider »). L'hôte peut y relire l'historique et
 * poser des questions ; les réponses sont les mêmes que sur la page web.
 */

export const SESSION_TYPE = 'prompt-share';
const PARTICIPANT_ID = 'promptShare.session';

export class NativeChatBridge implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly controller: vscode.ChatSessionItemController;
  private queue: QueueState = { current: null, pending: [] };
  private refreshTimer: NodeJS.Timeout | undefined;
  private readonly unsubscribe: () => void;
  /**
   * Onglets d'éditeur affichant une discussion. VS Code charge le contenu d'une session une
   * seule fois et l'API ne permet pas d'y ajouter des tours : pour montrer en direct l'activité
   * des invités, on rouvre l'onglet. L'onglet de chat n'expose pas sa ressource ; on l'associe
   * à la discussion à son ouverture, par son titre.
   */
  private readonly tabs = new Map<vscode.Tab, string>();
  /** Discussions dont le contenu vient d'être fourni, en attente de leur onglet. */
  private pendingTabs: { conversationId: string; title: string; at: number }[] = [];
  /** Discussions dont l'onglet affiche un contenu dépassé (rouvert dès qu'il est visible). */
  private readonly stale = new Set<string>();
  /** Questions posées depuis le chat natif et suivies par leur propre requête. */
  private readonly ownedQuestions = new Set<string>();
  private askingFrom: string | undefined;

  /** Renvoie undefined si l'API proposée n'est pas disponible (extension installée sans --enable-proposed-api). */
  static tryCreate(room: ChatRoom, hostName: () => string, log: (message: string) => void): NativeChatBridge | undefined {
    try {
      return new NativeChatBridge(room, hostName);
    } catch (err) {
      log(`Intégration au chat natif indisponible : ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      return undefined;
    }
  }

  private constructor(
    private readonly room: ChatRoom,
    private readonly hostName: () => string,
  ) {
    this.controller = vscode.chat.createChatSessionItemController(SESSION_TYPE, async () => this.refresh());
    this.disposables.push(this.controller);

    this.controller.newChatSessionItemHandler = async () => {
      const conv = this.room.createConversationAsHost(this.hostName());
      const item = this.itemFor(conv);
      this.controller.items.add(item);
      return item;
    };

    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, (request, context, stream, token) =>
      this.handleRequest(request, context, stream, token),
    );
    participant.iconPath = new vscode.ThemeIcon('broadcast');
    this.disposables.push(participant);

    this.disposables.push(
      vscode.chat.registerChatSessionContentProvider(
        SESSION_TYPE,
        { provideChatSessionContent: (resource) => this.provideContent(resource) },
        participant,
      ),
    );

    this.unsubscribe = room.subscribe((msg) => this.onRoomMessage(msg));
    this.disposables.push(vscode.window.tabGroups.onDidChangeTabs((e) => this.onTabsChanged(e)));
    this.refresh();
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.unsubscribe();
    this.controller.items.replace([]);
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
  }

  // ---- Liste des sessions ----

  private onRoomMessage(msg: ServerMessage): void {
    const active = this.conversationActivity(msg);
    if (active) {
      this.markStale(active);
    }
    if (msg.type === 'queue') {
      this.queue = msg.queue;
    }
    if (msg.type === 'conversation' || msg.type === 'conversationDeleted' || msg.type === 'queue' || msg.type === 'entry') {
      // Regroupe les rafraîchissements (une réponse en streaming produit beaucoup de messages).
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.refresh(), 150);
    }
  }

  // ---- Mise à jour des onglets ouverts ----

  /** Activité d'un autre participant dans une discussion : son onglet doit être rechargé. */
  private conversationActivity(msg: ServerMessage): string | undefined {
    if (msg.type === 'conversationDeleted') {
      return msg.conversationId;
    }
    if (msg.type === 'questionReview') {
      return this.room.conversationOfEntry(msg.entryId);
    }
    if (msg.type !== 'entry' || msg.entry.conversationId === this.askingFrom) {
      return undefined;
    }
    const e = msg.entry;
    if (e.kind === 'user' || e.kind === 'context' || (e.kind === 'assistant' && !this.ownedQuestions.has(e.replyTo))) {
      return e.conversationId;
    }
    return undefined;
  }

  private onTabsChanged(e: vscode.TabChangeEvent): void {
    for (const tab of e.closed) {
      this.tabs.delete(tab);
    }
    // Le titre d'un onglet de chat peut n'arriver qu'après son ouverture.
    this.matchTabs([...e.opened, ...e.changed]);
    for (const tab of e.changed) {
      const conversationId = this.tabs.get(tab);
      if (conversationId && tab.isActive && this.stale.has(conversationId)) {
        void this.reload(conversationId);
      }
    }
  }

  /** Associe les onglets de chat récemment ouverts aux discussions dont le contenu vient d'être fourni. */
  private matchTabs(candidates: readonly vscode.Tab[]): void {
    const now = Date.now();
    this.pendingTabs = this.pendingTabs.filter((p) => now - p.at < 10_000);
    for (const tab of candidates) {
      if (!isChatTab(tab) || this.tabs.has(tab)) {
        continue;
      }
      const i = this.pendingTabs.findIndex((p) => p.title === tab.label);
      if (i >= 0) {
        this.tabs.set(tab, this.pendingTabs[i].conversationId);
        this.pendingTabs.splice(i, 1);
      }
    }
  }

  private markStale(conversationId: string): void {
    for (const [tab, id] of this.tabs) {
      if (id === conversationId) {
        this.stale.add(conversationId);
        if (tab.isActive) {
          void this.reload(conversationId);
        }
      }
    }
  }

  /** Rouvre l'onglet d'une discussion à la même place, sauf si l'hôte y attend une réponse. */
  private async reload(conversationId: string): Promise<void> {
    const entry = [...this.tabs].find(([, id]) => id === conversationId);
    if (!entry || this.hasOwnedRequest(conversationId)) {
      return;
    }
    const [tab] = entry;
    this.stale.delete(conversationId);
    this.tabs.delete(tab);
    const group = tab.group;
    const focused = group.isActive;
    await vscode.window.tabGroups.close(tab, true);
    if (this.room.getConversation(conversationId)) {
      await vscode.commands.executeCommand('vscode.open', resourceFor(conversationId), {
        viewColumn: group.viewColumn,
        preserveFocus: !focused,
        preview: false,
      });
    }
  }

  private hasOwnedRequest(conversationId: string): boolean {
    return [...this.ownedQuestions].some((q) => {
      const answer = this.room.answerTo(q);
      return this.room.entriesOf(conversationId).some((e) => e.id === q) && (!answer || answer.status === 'streaming');
    });
  }

  private refresh(): void {
    this.controller.items.replace(this.room.conversationList.map((c) => this.itemFor(c)));
  }

  private itemFor(conv: Conversation): vscode.ChatSessionItem {
    const item = this.controller.createChatSessionItem(resourceFor(conv.id), conv.title);
    const entries = this.room.entriesOf(conv.id);
    const questions = entries.filter((e) => e.kind === 'user').length;
    const authors = new Set(entries.flatMap((e) => (e.kind === 'user' ? [e.author] : [])));
    const answering = this.queue.current?.conversationId === conv.id;
    const waiting = this.queue.pending.some((q) => q.conversationId === conv.id);
    item.iconPath = new vscode.ThemeIcon('broadcast');
    item.status = answering || waiting ? vscode.ChatSessionStatus.InProgress : vscode.ChatSessionStatus.Completed;
    item.description = `${questions} question(s)${authors.size ? ` · ${[...authors].join(', ')}` : ''}`;
    item.tooltip = `Discussion partagée créée par ${conv.createdBy}`;
    const last = entries[entries.length - 1];
    item.timing = { created: conv.createdAt, lastRequestStarted: last?.timestamp };
    return item;
  }

  // ---- Contenu d'une session ----

  private provideContent(resource: vscode.Uri): vscode.ChatSession {
    const conversationId = conversationIdOf(resource);
    const conv = this.room.getConversation(conversationId);
    if (!conv) {
      return {
        title: 'Discussion supprimée',
        history: [new vscode.ChatResponseTurn2([new vscode.ChatResponseMarkdownPart("Cette discussion n'existe plus.")], {}, SESSION_TYPE)],
        requestHandler: undefined,
      };
    }

    this.pendingTabs.push({ conversationId, title: conv.title, at: Date.now() });
    // L'onglet peut déjà exister (réouverture) ou apparaître juste après.
    this.matchTabs(vscode.window.tabGroups.all.flatMap((g) => g.tabs));
    this.stale.delete(conversationId);

    const entries = this.room.entriesOf(conversationId);
    const answers = new Map<string, AssistantEntry>();
    for (const e of entries) {
      if (e.kind === 'assistant') {
        answers.set(e.replyTo, e);
      }
    }
    // Une réponse en cours est diffusée par activeResponseCallback : sa question doit être le dernier tour.
    const streamingQuestion = [...answers.values()].find((a) => a.status === 'streaming')?.replyTo;

    const history: (vscode.ChatRequestTurn | vscode.ChatResponseTurn2)[] = [];
    const pushQuestion = (e: ChatEntry) => history.push(requestTurn(this.promptOf(e)));
    for (const e of entries) {
      if (e.kind === 'context') {
        pushQuestion(e);
        history.push(responseTurn('_Contexte ajouté à la discussion._'));
      } else if (e.kind === 'user' && e.id !== streamingQuestion) {
        pushQuestion(e);
        const answer = answers.get(e.id);
        history.push(answer ? responseTurn(renderAnswer(answer)) : pendingTurn(e));
      }
    }

    let activeResponseCallback: vscode.ChatSession['activeResponseCallback'];
    if (streamingQuestion) {
      const question = entries.find((e) => e.id === streamingQuestion);
      if (question) {
        pushQuestion(question);
      }
      activeResponseCallback = async (stream, token) => {
        await this.followAnswer(streamingQuestion, stream, token, false);
      };
    }

    return {
      title: conv.title,
      history,
      activeResponseCallback,
      requestHandler: (request, context, stream, token) => this.handleRequest(request, context, stream, token),
    };
  }

  private promptOf(e: ChatEntry): string {
    if (e.kind === 'context') {
      const where = e.range ? `${e.fileName} (${e.range})` : e.fileName;
      return `📎 Contexte partagé par ${e.author} : ${where}\n\n\`\`\`${e.languageId}\n${e.code}\n\`\`\``;
    }
    if (e.kind === 'user') {
      return e.author === this.hostName() && e.isHost ? e.text : `${e.author} : ${e.text}`;
    }
    return '';
  }

  // ---- Questions posées depuis le chat natif ----

  private async handleRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> {
    const resource = context.chatSessionContext?.chatSessionItem.resource;
    const conversationId = resource ? conversationIdOf(resource) : undefined;
    if (!conversationId || !this.room.getConversation(conversationId)) {
      stream.markdown("Cette discussion n'existe plus dans la session partagée. Ouvrez-en une autre depuis la liste des sessions.");
      return {};
    }
    const modelId = request.model?.vendor === 'copilot' ? request.model.id : undefined;
    let questionId: string;
    this.askingFrom = conversationId;
    try {
      questionId = this.room.askAsHost(conversationId, request.prompt, this.hostName(), modelId);
    } catch (err) {
      return { errorDetails: { message: err instanceof Error ? err.message : String(err) } };
    } finally {
      this.askingFrom = undefined;
    }
    this.ownedQuestions.add(questionId);
    try {
      return await this.followAnswer(questionId, stream, token, true);
    } finally {
      this.ownedQuestions.delete(questionId);
      // Activité des invités pendant la réponse : l'onglet est rechargé maintenant.
      if (this.stale.has(conversationId)) {
        setTimeout(() => this.markStale(conversationId), 500);
      }
    }
  }

  /**
   * Diffuse dans le chat natif la réponse à une question, depuis la file d'attente
   * jusqu'à la fin du streaming. `owned` : la question vient de ce chat, l'annuler l'annule aussi dans la session.
   */
  private followAnswer(
    questionId: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    owned: boolean,
  ): Promise<vscode.ChatResult> {
    return new Promise((resolve) => {
      let answerId: string | undefined;
      let finished = false;
      const reported = new Set<string>();

      const finish = (result: vscode.ChatResult) => {
        if (finished) {
          return;
        }
        finished = true;
        unsubscribe();
        cancelListener.dispose();
        resolve(result);
      };

      const showTool = (tool: ToolActivity) => {
        const once = (suffix: string) => {
          const k = `${tool.id}:${suffix}`;
          const first = !reported.has(k);
          reported.add(k);
          return first;
        };
        if (tool.status === 'running') {
          stream.progress(tool.title);
        } else if (tool.status === 'awaitingApproval' && tool.approval && answerId && once('approval')) {
          // Carte de validation façon Copilot, avec boutons.
          const scope = tool.approval.hostOnly ? ' — hors du projet' : '';
          stream.markdown(`\n\n**${tool.title}**${scope}\n\n\`\`\`diff\n${tool.approval.preview}\n\`\`\`\n`);
          const args = (decision: string) => [answerId, tool.id, decision];
          stream.button({ command: 'promptShare.resolveApproval', title: 'Autoriser', arguments: args('once') });
          if (!tool.approval.hostOnly) {
            stream.button({ command: 'promptShare.resolveApproval', title: 'Autoriser pour la session', arguments: args('session') });
          }
          if (tool.approval.canShowDiff) {
            stream.button({ command: 'promptShare.showDiff', title: 'Voir les modifications', arguments: [tool.id] });
          }
          stream.button({ command: 'promptShare.resolveApproval', title: 'Refuser', arguments: args('deny') });
        } else if (tool.status === 'awaitingAnswer' && tool.question && answerId && once('question')) {
          stream.markdown(`\n\n❓ **${tool.question.text}**\n\n`);
          // Tout participant peut répondre, l'hôte aussi depuis le chat natif.
          for (const option of tool.question.options) {
            stream.button({ command: 'promptShare.answerQuestion', title: option, arguments: [answerId, tool.id, option] });
          }
          stream.button({ command: 'promptShare.answerQuestion', title: 'Répondre…', arguments: [answerId, tool.id] });
        } else if ((tool.status === 'done' || tool.status === 'rejected' || tool.status === 'error') && once('end')) {
          stream.markdown(`\n\n${toolLine(tool)}\n\n`);
        }
      };

      const showQueue = (queue: QueueState) => {
        const position = queue.pending.findIndex((q) => q.entryId === questionId);
        if (position >= 0) {
          stream.progress(`En attente dans la file (position ${position + 1})…`);
        }
      };

      // Réponse déjà commencée (session rouverte pendant le streaming) : on affiche l'existant.
      const existing = this.room.answerTo(questionId);
      if (existing) {
        answerId = existing.id;
        for (const part of existing.parts) {
          if (part.type === 'text') {
            stream.markdown(part.text);
          } else {
            showTool(part.tool);
          }
        }
        if (existing.status !== 'streaming') {
          resolve(resultFor(existing.status, existing.error));
          return;
        }
      } else {
        showQueue(this.queue);
      }

      const unsubscribe = this.room.subscribe((msg) => {
        switch (msg.type) {
          case 'entry':
            if (msg.entry.kind === 'assistant' && msg.entry.replyTo === questionId) {
              answerId = msg.entry.id;
              stream.progress('Le modèle répond…');
            }
            break;
          case 'chunk':
            if (msg.entryId === answerId) {
              stream.markdown(msg.text);
            }
            break;
          case 'tool':
            if (msg.entryId === answerId) {
              showTool(msg.tool);
            }
            break;
          case 'entryUpdate':
            if (msg.entryId === answerId && msg.status !== 'streaming') {
              finish(resultFor(msg.status, msg.error));
            }
            break;
          case 'queue':
            if (!answerId) {
              showQueue(msg.queue);
            }
            break;
          case 'conversationDeleted':
          case 'sessionEnded':
            finish({ errorDetails: { message: 'La discussion ou la session partagée a été fermée.' } });
            break;
        }
      });

      const cancelListener = token.onCancellationRequested(() => {
        if (owned) {
          this.room.cancelQuestion(questionId);
        }
        finish({});
      });
    });
  }
}

/** Onglet du chat natif (TabInputChat existe à l'exécution mais pas dans les types stables). */
function isChatTab(tab: vscode.Tab): boolean {
  const TabInputChat = (vscode as unknown as { TabInputChat?: new () => unknown }).TabInputChat;
  return TabInputChat ? tab.input instanceof TabInputChat : false;
}

function resourceFor(conversationId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SESSION_TYPE, path: `/${conversationId}` });
}

function conversationIdOf(resource: vscode.Uri): string {
  return resource.path.replace(/^\//, '');
}

function requestTurn(prompt: string): vscode.ChatRequestTurn {
  return new vscode.ChatRequestTurn2(prompt, undefined, [], '', [], [], undefined, undefined, undefined) as unknown as vscode.ChatRequestTurn;
}

function responseTurn(markdown: string): vscode.ChatResponseTurn2 {
  return new vscode.ChatResponseTurn2([new vscode.ChatResponseMarkdownPart(markdown)], {}, SESSION_TYPE);
}

/** Question sans réponse : en attente de l'hôte (avec ses boutons), refusée, ou dans la file. */
function pendingTurn(question: UserEntry): vscode.ChatResponseTurn2 {
  if (question.review === 'rejected') {
    return responseTurn(`_Non envoyée au modèle : refusée par ${question.reviewedBy ?? "l'hôte"}._`);
  }
  if (question.review !== 'pending') {
    return responseTurn("_En attente dans la file d'attente…_");
  }
  const decide = (title: string, accept: boolean) =>
    new vscode.ChatResponseCommandButtonPart({ command: 'promptShare.reviewQuestion', title, arguments: [question.id, accept] });
  return new vscode.ChatResponseTurn2(
    [
      new vscode.ChatResponseMarkdownPart(`_Question de ${question.author} : l'envoyer au modèle avec votre compte ?_`),
      decide('Envoyer au modèle', true),
      decide('Refuser', false),
    ],
    {},
    SESSION_TYPE,
  );
}

function renderAnswer(answer: AssistantEntry): string {
  const body = answer.parts.map((p) => (p.type === 'text' ? p.text : `\n\n${toolLine(p.tool)}\n\n`)).join('');
  const header = answer.model ? `_${answer.model} · réponse à ${answer.replyToAuthor}_\n\n` : '';
  const footer =
    answer.status === 'cancelled' ? '\n\n_Réponse annulée._' : answer.status === 'error' ? `\n\n⚠️ ${answer.error ?? 'Erreur'}` : '';
  return `${header}${body || (answer.status === 'done' ? '_(réponse vide)_' : '')}${footer}`;
}

function toolLine(tool: ToolActivity): string {
  const icon = { done: '✓', error: '⚠️', rejected: '⛔', running: '⏳', awaitingApproval: '✋', awaitingAnswer: '❓' }[tool.status];
  const answer = tool.answer ? ` — réponse de ${tool.answeredBy ?? '?'} : « ${tool.answer} »` : '';
  return `> ${icon} ${tool.question ? tool.question.text : tool.title}${answer}${tool.detail ? ` — ${tool.detail}` : ''}`;
}

function resultFor(status: AssistantEntry['status'], error?: string): vscode.ChatResult {
  return status === 'error' ? { errorDetails: { message: error ?? 'Erreur du modèle.' } } : {};
}
