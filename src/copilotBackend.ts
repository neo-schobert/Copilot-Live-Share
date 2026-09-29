import * as vscode from 'vscode';
import type { PreparedCall, WorkspaceTools } from './agentTools';
import type { ModelBackend, ModelEvent, ModelRequest, ModelResponse, ModelTurn } from './chatRoom';
import type { ContextUsage, ModelInfo, ToolActivity } from './protocol';
import type { I18nText, Lang, Params } from './i18n/core';
import { I18nError, isRoomKey, renderRoomText, roomT, roomText } from './i18n/room';

/** Nombre maximal d'allers-retours modèle ↔ outils pour une question. */
const MAX_TOOL_ROUNDS = 25;

/**
 * Accès aux modèles Copilot via l'API Language Model de VS Code, avec une boucle
 * agent : le modèle peut appeler les outils de l'espace de travail, dont les
 * résultats lui sont renvoyés jusqu'à sa réponse finale.
 */
export class CopilotBackend implements ModelBackend {
  /** Ids d'actions uniques pour toute la session (ils servent aussi à retrouver les diffs). */
  private toolCounter = 0;

  constructor(
    private readonly tools: WorkspaceTools,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  async ask(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const model = request.modelId ? await selectById(request.modelId) : await selectModel();
    const messages = request.turns.map((t) =>
      t.role === 'user'
        ? vscode.LanguageModelChatMessage.User(t.content)
        : vscode.LanguageModelChatMessage.Assistant(t.content),
    );
    return { modelName: model.name, events: this.run(model, messages, request, signal) };
  }

  /** Tokens de ces messages (et des définitions d'outils, envoyées avec chaque requête). */
  async measure(turns: ModelTurn[], modelId?: string): Promise<ContextUsage | undefined> {
    const model = modelId ? await selectById(modelId) : await selectModel();
    if (!model.maxInputTokens) {
      return undefined;
    }
    const counts = await Promise.all([
      ...turns.map((t) => model.countTokens(t.content)),
      model.countTokens(JSON.stringify(this.tools.definitions())),
    ]);
    return { tokens: counts.reduce((a, b) => a + b, 0), max: model.maxInputTokens, model: model.name };
  }

  private async *run(
    initialModel: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ModelEvent> {
    const lang: Lang = request.lang ?? 'en';
    const cts = new vscode.CancellationTokenSource();
    const onAbort = () => cts.cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    let tools = request.noTools ? [] : this.tools.definitions();
    let model = initialModel;

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        let response: vscode.LanguageModelChatResponse;
        try {
          response = await model.sendRequest(
            messages,
            {
              justification: roomT(lang, 'model.justification'),
              tools: tools.length ? tools : undefined,
            },
            cts.token,
          );
        } catch (err) {
          // Le modèle « Auto » de Copilot peut refuser d'aiguiller une requête : on rejoue avec un modèle concret.
          if (isAutoRoutingError(err)) {
            const fallback = await concreteModel(model);
            if (fallback) {
              this.log(`Le modèle « ${model.name} » n'a pas pu aiguiller la requête : nouvel essai avec « ${fallback.name} ».`);
              model = fallback;
              round--;
              continue;
            }
          }
          // Certains modèles n'acceptent pas les outils : on réessaie sans.
          if (tools.length && round === 0 && /tool/i.test(String((err as Error)?.message))) {
            tools = [];
            yield { type: 'text', text: `${roomT(lang, 'model.noToolsNote')}\n\n` };
            round--;
            continue;
          }
          throw toReadableError(err);
        }

        let text = '';
        const calls: vscode.LanguageModelToolCallPart[] = [];
        try {
          for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
              text += part.value;
              yield { type: 'text', text: part.value };
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
              calls.push(part);
            }
          }
        } catch (err) {
          throw toReadableError(err);
        }
        if (!calls.length || signal.aborted) {
          return;
        }
        if (text && !text.endsWith('\n')) {
          yield { type: 'text', text: '\n\n' };
        }

        messages.push(
          vscode.LanguageModelChatMessage.Assistant([...(text ? [new vscode.LanguageModelTextPart(text)] : []), ...calls]),
        );
        const results: vscode.LanguageModelToolResultPart[] = [];
        for (const call of calls) {
          const id = `t${++this.toolCounter}`;
          const outcome = yield* this.runTool(id, call, request, signal, lang);
          results.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(outcome)]));
          if (signal.aborted) {
            return;
          }
        }
        // Les résultats sont accompagnés d'un texte : sans lui, le modèle « Auto » de Copilot
        // ne sait pas aiguiller la requête (« Auto mode needs a prompt or a command… »).
        messages.push(
          vscode.LanguageModelChatMessage.User([
            ...results,
            new vscode.LanguageModelTextPart(`Here are the results of the tools above. Continue your answer to ${request.author}'s request.`),
          ]),
        );
      }
      yield { type: 'text', text: `\n\n${roomT(lang, 'model.stepLimit', { max: MAX_TOOL_ROUNDS })}` };
    } finally {
      signal.removeEventListener('abort', onAbort);
      cts.dispose();
    }
  }

  /** Exécute un appel d'outil en publiant son avancement ; renvoie le texte à transmettre au modèle. */
  private async *runTool(
    id: string,
    call: vscode.LanguageModelToolCallPart,
    request: ModelRequest,
    signal: AbortSignal,
    lang: Lang,
  ): AsyncGenerator<ModelEvent, string> {
    const activity = (tool: ToolActivity): ModelEvent => ({ type: 'tool', tool });
    /** `detail` (langue de l'hôte) et `detailI18n` d'un texte traduisible. */
    const detailOf = (text: I18nText | undefined): Pick<ToolActivity, 'detail' | 'detailI18n'> =>
      text ? { detail: renderRoomText(lang, text), detailI18n: text } : {};
    /** Détail d'une erreur : traduisible si c'est une I18nError, texte brut sinon. */
    const errorDetail = (err: unknown): Pick<ToolActivity, 'detail' | 'detailI18n'> =>
      err instanceof I18nError ? detailOf(err.i18n) : { detail: err instanceof Error ? err.message : String(err) };
    let prepared: PreparedCall;
    try {
      prepared = await this.tools.prepare(call.name, call.input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield activity({ id, title: call.name, status: 'error', ...errorDetail(err) });
      return `Error: ${message}`;
    }
    const title = prepared.title;
    const titleI18n = prepared.titleI18n;
    const named = { id, title, ...(titleI18n ? { titleI18n } : {}) };

    // Question de l'agent aux participants : visible par tous, le premier qui répond l'emporte.
    if (prepared.question) {
      const question = { ...prepared.question, requesterClientId: request.authorClientId, requesterName: request.author };
      const tool = { ...named, status: 'awaitingAnswer' as const, question };
      yield activity(tool);
      const answer = await request.interaction.answer(tool);
      if (!answer.text) {
        yield activity({ ...tool, status: 'rejected', ...detailOf(roomText('tool.noAnswer')) });
        return 'No answer (request cancelled). Finish without assuming the answer.';
      }
      yield activity({ ...tool, status: 'done', answer: answer.text, answeredBy: answer.by });
      return `Answer from ${answer.by}: ${answer.text}`;
    }

    /** Décision sur l'action validée : suffixe des clés du détail (voir `doneDetail`). */
    let approvedAs: { kind: ApprovedKind; by: string } | undefined;
    const approval = prepared.approval;
    if (approval && this.tools.isGranted(approval)) {
      approvedAs = { kind: 'granted', by: '' };
    } else if (approval) {
      const request_ = { kind: approval.kind, preview: approval.preview, canShowDiff: approval.canShowDiff, hostOnly: approval.hostOnly };
      const tool = { ...named, status: 'awaitingApproval' as const, approval: request_ };
      if (approval.diff) {
        this.tools.rememberDiff(id, approval.diff);
      }
      yield activity(tool);
      const outcome = await request.interaction.approval(tool);
      this.tools.forgetDiff(id);
      if (outcome.decision === 'deny' || signal.aborted) {
        yield activity({
          ...tool,
          status: 'rejected',
          ...detailOf(outcome.by ? roomText('tool.deniedBy', { by: outcome.by }) : roomText('tool.cancelled')),
        });
        return 'The action was denied. Do not retry it as is; explain what you wanted to do or suggest an alternative.';
      }
      if (outcome.decision === 'session') {
        this.tools.grant(approval.kind);
      }
      approvedAs = { kind: outcome.decision === 'session' ? 'approvedSession' : 'approved', by: outcome.by };
      yield activity({ ...tool, status: 'running', ...detailOf(approvalText(approvedAs)) });
    } else {
      yield activity({ ...named, status: 'running' });
    }

    try {
      const { result, summary, summaryI18n } = await prepared.execute(signal);
      const detail = doneDetail(lang, summary, summaryI18n, approvedAs);
      yield activity({ ...named, status: 'done', ...detail, approval: approval && {
        kind: approval.kind, preview: approval.preview, canShowDiff: false, hostOnly: approval.hostOnly,
      } });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield activity({ ...named, status: 'error', ...errorDetail(err) });
      return `Error: ${message}`;
    }
  }
}

type ApprovedKind = 'granted' | 'approvedSession' | 'approved';

function approvalText(approved: { kind: ApprovedKind; by: string }): I18nText {
  return approved.kind === 'granted' ? roomText('tool.granted') : roomText(`tool.${approved.kind}`, { by: approved.by });
}

/**
 * Détail d'une action terminée : résumé de l'outil, suivi de la décision de validation.
 * Les clés composées « <clé du résumé>.<décision> » existent pour les résumés des outils
 * validés (voir src/i18n/room.ts) ; sinon, texte brut dans la langue de l'hôte.
 */
function doneDetail(
  lang: Lang,
  summary: string | undefined,
  summaryI18n: I18nText | undefined,
  approved: { kind: ApprovedKind; by: string } | undefined,
): Pick<ToolActivity, 'detail' | 'detailI18n'> {
  let text: I18nText | undefined;
  if (!approved) {
    text = summaryI18n ?? (summary ? roomText('tool.summary.raw', { text: summary }) : undefined);
  } else if (!summary && !summaryI18n) {
    text = approvalText(approved);
  } else {
    const base = summaryI18n ?? roomText('tool.summary.raw', { text: summary! });
    const combined = `${base.key}.${approved.kind}`;
    const params: Params = { ...base.params, ...(approved.by ? { by: approved.by } : {}) };
    if (isRoomKey(combined)) {
      text = { key: combined, params };
    } else {
      const plain = [renderRoomText(lang, base), renderRoomText(lang, approvalText(approved))].join(' · ');
      return { detail: plain };
    }
  }
  return text ? { detail: renderRoomText(lang, text), detailI18n: text } : {};
}

function isAutoRoutingError(err: unknown): boolean {
  return /auto mode|route a request/i.test(err instanceof Error ? err.message : String(err));
}

/** Premier modèle Copilot qui n'est pas le routeur « Auto ». */
async function concreteModel(current: vscode.LanguageModelChat): Promise<vscode.LanguageModelChat | undefined> {
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  return models.find((m) => m.id !== current.id && !/^auto$/i.test(m.family) && !/^auto$/i.test(m.id) && !/^auto\b/i.test(m.name));
}

/** Modèles Copilot disponibles, dédoublonnés et triés par nom. */
export async function listCopilotModels(): Promise<ModelInfo[]> {
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  const byId = new Map<string, ModelInfo>();
  for (const m of models) {
    byId.set(m.id, { id: m.id, name: m.name, family: m.family });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Modèle par défaut : premier de la famille configurée, sinon premier disponible. */
export function defaultModelId(models: ModelInfo[]): string | null {
  const family = vscode.workspace.getConfiguration('promptShare').get<string>('modelFamily', '').trim();
  const match = family ? models.find((m) => m.family === family) : undefined;
  return (match ?? models[0])?.id ?? null;
}

async function selectById(id: string): Promise<vscode.LanguageModelChat> {
  const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', id });
  if (!model) {
    throw new I18nError('model.error.gone');
  }
  return model;
}

async function selectModel(): Promise<vscode.LanguageModelChat> {
  const family = vscode.workspace.getConfiguration('promptShare').get<string>('modelFamily', '').trim();
  const models = await vscode.lm.selectChatModels(family ? { vendor: 'copilot', family } : { vendor: 'copilot' });
  if (models.length > 0) {
    return models[0];
  }
  if (family) {
    const available = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    const families = [...new Set(available.map((m) => m.family))].join(', ');
    throw families ? new I18nError('model.error.noFamily', { family, families }) : new I18nError('model.error.noFamilyNone', { family });
  }
  throw new I18nError('model.error.none');
}

function toReadableError(err: unknown): Error {
  if (err instanceof vscode.LanguageModelError) {
    switch (err.code) {
      case vscode.LanguageModelError.NoPermissions().code:
        return new I18nError('model.error.noPermissions');
      case vscode.LanguageModelError.Blocked().code:
        return new I18nError('model.error.blocked');
      case vscode.LanguageModelError.NotFound().code:
        return new I18nError('model.error.notFound');
    }
    return new I18nError('model.error.other', { message: err.message });
  }
  return err instanceof Error ? err : new Error(String(err));
}
