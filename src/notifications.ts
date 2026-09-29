import * as vscode from 'vscode';
import type { ApprovalDecision, ChatEntry, Conversation, ServerMessage, ToolActivity } from './protocol';
import { conversationTitle, roomText } from './i18n/extension';
import { t, uiLang } from './i18n/vscode';

/**
 * Notifications de la session dans VS Code, pour l'hôte comme pour un invité qui a rejoint
 * depuis VS Code. Suit les messages de la session et prévient quand une décision attend
 * l'utilisateur : question d'invité à accepter (hôte), action de l'agent à valider, question
 * de l'agent. Le nombre de décisions en attente s'affiche en pastille sur la vue et dans la
 * barre d'état. Les messages peuvent arriver en double (vue et onglets ont chacun leur
 * connexion) : tout est idempotent.
 */

export type NotificationLevel = 'decisions' | 'all' | 'off';

export interface NotifierIdentity {
  isHost: boolean;
  /** Identifiants de ce participant (vue et onglets, chat natif pour l'hôte). */
  clientIds: string[];
}

export interface NotifierActions {
  approve(entryId: string, toolId: string, decision: ApprovalDecision): void;
  review(entryId: string, accept: boolean): void;
  answer(entryId: string, toolId: string, text: string): void;
  /** Ouvre le chat sur une discussion. */
  open(conversationId: string): void;
  /** Hôte : ouvre le diff complet d'une modification proposée. */
  showDiff?(toolId: string): void;
}

interface Pending {
  kind: 'review' | 'approval' | 'question';
  conversationId: string;
  /** Réponse de l'agent concernée (actions et questions). */
  entryId: string;
}

export class SessionNotifier {
  private readonly entries = new Map<string, ChatEntry>();
  private readonly pending = new Map<string, Pending>();
  /** Déjà notifié : une seule notification par évènement, même reçu plusieurs fois. */
  private readonly notified = new Set<string>();
  private conversationList: Conversation[] = [];

  constructor(
    private readonly identity: () => NotifierIdentity | undefined,
    private readonly actions: NotifierActions,
    private readonly level: () => NotificationLevel,
    private readonly onPendingChange: (count: number, summary: string) => void,
    /** Questions de l'agent auxquelles l'hôte répond déjà par un autre moyen (chat natif). */
    private readonly skipQuestion: (tool: ToolActivity) => boolean = () => false,
  ) {}

  get conversations(): Conversation[] {
    return this.conversationList;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  reset(): void {
    this.entries.clear();
    this.pending.clear();
    this.notified.clear();
    this.conversationList = [];
    this.changed();
  }

  feed(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        this.conversationList = msg.conversations;
        for (const entry of msg.history) {
          this.onEntry(entry, false);
        }
        break;
      case 'conversation': {
        const i = this.conversationList.findIndex((c) => c.id === msg.conversation.id);
        this.conversationList = i < 0 ? [...this.conversationList, msg.conversation] : this.conversationList.map((c, j) => (j === i ? msg.conversation : c));
        break;
      }
      case 'conversationDeleted':
        this.conversationList = this.conversationList.filter((c) => c.id !== msg.conversationId);
        this.drop((p) => p.conversationId === msg.conversationId);
        break;
      case 'entry':
        this.onEntry(msg.entry, true);
        break;
      case 'tool': {
        const entry = this.entries.get(msg.entryId);
        if (entry?.kind === 'assistant') {
          this.onTool(entry.id, entry.conversationId, entry.replyTo, msg.tool);
        }
        break;
      }
      case 'entryUpdate':
        if (msg.status !== 'streaming') {
          this.drop((p) => p.entryId === msg.entryId && p.kind !== 'review');
          const entry = this.entries.get(msg.entryId);
          const question = entry?.kind === 'assistant' ? this.entries.get(entry.replyTo) : undefined;
          if (msg.status === 'done' && question?.kind === 'user' && this.isMine(question.clientId) && this.level() === 'all') {
            this.inform(`answer:${msg.entryId}`, t('notify.answered', { title: this.title(question.conversationId) }), question.conversationId);
          }
        }
        break;
      case 'questionReview': {
        this.pending.delete(`review:${msg.entryId}`);
        this.changed();
        const question = this.entries.get(msg.entryId);
        if (question?.kind === 'user') {
          question.review = msg.review;
          if (msg.review === 'rejected' && this.isMine(question.clientId) && !this.identity()?.isHost) {
            this.inform(`rejected:${msg.entryId}`, t('notify.rejected', { name: msg.by }), question.conversationId);
          }
        }
        break;
      }
      case 'sessionEnded':
        this.reset();
        break;
    }
  }

  private onEntry(entry: ChatEntry, live: boolean): void {
    this.entries.set(entry.id, entry);
    const me = this.identity();
    if (!me) {
      return;
    }
    if (entry.kind === 'user') {
      if (entry.review === 'pending' && me.isHost) {
        this.pending.set(`review:${entry.id}`, { kind: 'review', conversationId: entry.conversationId, entryId: entry.id });
        this.changed();
        this.notifyReview(entry.id, entry.author, entry.text, entry.conversationId);
      } else if (live && !this.isMine(entry.clientId) && entry.review !== 'pending' && this.level() === 'all') {
        this.inform(
          `entry:${entry.id}`,
          t('notify.entry', { author: entry.author, title: this.title(entry.conversationId), text: excerpt(entry.text, 120) }),
          entry.conversationId,
        );
      }
    } else if (entry.kind === 'assistant' && entry.status === 'streaming') {
      for (const part of entry.parts) {
        if (part.type === 'tool') {
          this.onTool(entry.id, entry.conversationId, entry.replyTo, part.tool);
        }
      }
    }
  }

  private onTool(entryId: string, conversationId: string, replyTo: string, tool: ToolActivity): void {
    const key = `tool:${entryId}/${tool.id}`;
    const me = this.identity();
    if (!me) {
      return;
    }
    const question = this.entries.get(replyTo);
    const requester = question?.kind === 'user' ? question : undefined;
    if (tool.status === 'awaitingApproval' && tool.approval) {
      const mine = me.isHost || (!tool.approval.hostOnly && !!requester && this.isMine(requester.clientId));
      if (mine) {
        this.pending.set(key, { kind: 'approval', conversationId, entryId });
        this.changed();
        this.notifyApproval(key, entryId, conversationId, tool, requester?.author ?? '?');
      }
    } else if (tool.status === 'awaitingAnswer' && tool.question) {
      this.pending.set(key, { kind: 'question', conversationId, entryId });
      this.changed();
      if (!this.skipQuestion(tool)) {
        this.notifyQuestion(key, entryId, conversationId, tool);
      }
    } else if (this.pending.delete(key)) {
      this.changed();
    }
  }

  // ---- Notifications ----

  private shouldNotify(key: string): boolean {
    if (this.level() === 'off' || this.notified.has(key)) {
      return false;
    }
    this.notified.add(key);
    return true;
  }

  private notifyReview(entryId: string, author: string, text: string, conversationId: string): void {
    const key = `review:${entryId}`;
    if (!this.shouldNotify(key)) {
      return;
    }
    const accept = t('button.sendToModel');
    const reject = t('button.deny');
    const open = t('button.open');
    void this.ask(
      key,
      () => vscode.window.showInformationMessage(t('notify.review', { author, text: excerpt(text, 200) }), accept, reject, open),
      (choice) => {
        if (choice === open) {
          this.actions.open(conversationId);
          return true;
        }
        if (choice === accept || choice === reject) {
          this.actions.review(entryId, choice === accept);
        }
        return false;
      },
    );
  }

  private notifyApproval(key: string, entryId: string, conversationId: string, tool: ToolActivity, author: string): void {
    if (!this.shouldNotify(key)) {
      return;
    }
    const approval = tool.approval!;
    const isHost = !!this.identity()?.isHost;
    const allow = t('button.allow');
    const allowSession = t('button.allowSession');
    const diff = t('button.viewChanges');
    const deny = t('button.deny');
    const open = t('button.open');
    const buttons = [
      allow,
      ...(isHost && !approval.hostOnly ? [allowSession] : []),
      ...(isHost && approval.canShowDiff && this.actions.showDiff ? [diff] : [open]),
      deny,
    ];
    const params = {
      author,
      title: roomText(uiLang(), tool.titleI18n, tool.title),
      preview: approval.preview.split('\n').slice(0, 6).join('\n'),
    };
    void this.ask(
      key,
      () => vscode.window.showWarningMessage(t(approval.hostOnly ? 'notify.approval.hostOnly' : 'notify.approval', params), ...buttons),
      (choice) => {
        if (choice === diff) {
          this.actions.showDiff?.(tool.id);
          return true;
        }
        if (choice === open) {
          this.actions.open(conversationId);
          return true;
        }
        const decision: ApprovalDecision | undefined =
          choice === allow ? 'once' : choice === allowSession ? 'session' : choice === deny ? 'deny' : undefined;
        if (decision) {
          this.actions.approve(entryId, tool.id, decision);
        }
        return false;
      },
    );
  }

  private notifyQuestion(key: string, entryId: string, conversationId: string, tool: ToolActivity): void {
    if (!this.shouldNotify(key)) {
      return;
    }
    const question = tool.question!;
    const free = t('button.answer');
    const open = t('button.open');
    const options = question.options.slice(0, 3);
    void this.ask(
      key,
      () => vscode.window.showInformationMessage(t('notify.question', { name: question.requesterName, text: question.text }), ...options, free, open),
      async (choice) => {
        if (choice === open) {
          this.actions.open(conversationId);
          return true;
        }
        const text =
          choice === free ? await vscode.window.showInputBox({ title: t('notify.answerAgent.title'), prompt: question.text, ignoreFocusOut: true }) : choice;
        if (text && this.pending.has(key)) {
          this.actions.answer(entryId, tool.id, text);
        }
        return false;
      },
    );
  }

  /**
   * Affiche une notification tant que la décision attend. `handle` renvoie true pour
   * la réafficher (ex. après « Voir les modifications » ou « Ouvrir »).
   */
  private async ask(key: string, show: () => Thenable<string | undefined>, handle: (choice: string | undefined) => boolean | Promise<boolean>): Promise<void> {
    for (;;) {
      const choice = await show();
      if (!this.pending.has(key)) {
        return; // Décidé ailleurs (chat, autre participant) ou session terminée.
      }
      if (!choice || !(await handle(choice))) {
        return;
      }
    }
  }

  /** Information simple (mode « all », question refusée), avec accès à la discussion. */
  private inform(key: string, text: string, conversationId: string): void {
    if (!this.shouldNotify(key)) {
      return;
    }
    const open = t('button.open');
    void vscode.window.showInformationMessage(t('notify.inform', { text }), open).then((choice) => {
      if (choice === open) {
        this.actions.open(conversationId);
      }
    });
  }

  // ---- Utilitaires ----

  private isMine(clientId: string): boolean {
    return !!this.identity()?.clientIds.includes(clientId);
  }

  private title(conversationId: string): string {
    return conversationTitle(uiLang(), this.conversationList.find((c) => c.id === conversationId)?.title);
  }

  private drop(pred: (p: Pending) => boolean): void {
    let changed = false;
    for (const [key, p] of this.pending) {
      if (pred(p)) {
        this.pending.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.changed();
    }
  }

  private changed(): void {
    const counts = { review: 0, approval: 0, question: 0 };
    for (const p of this.pending.values()) {
      counts[p.kind]++;
    }
    const parts = [
      counts.review ? t(counts.review === 1 ? 'pending.reviews.one' : 'pending.reviews.other', { count: counts.review }) : '',
      counts.approval ? t(counts.approval === 1 ? 'pending.approvals.one' : 'pending.approvals.other', { count: counts.approval }) : '',
      counts.question ? t(counts.question === 1 ? 'pending.questions.one' : 'pending.questions.other', { count: counts.question }) : '',
    ].filter(Boolean);
    this.onPendingChange(this.pending.size, parts.join(', '));
  }
}

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
