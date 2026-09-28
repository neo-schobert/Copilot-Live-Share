import * as vscode from 'vscode';
import type { WorkspaceTools } from './agentTools';
import type { ModelBackend, ModelEvent, ModelRequest, ModelResponse } from './chatRoom';
import type { ModelInfo, ToolActivity } from './protocol';

/** Nombre maximal d'allers-retours modèle ↔ outils pour une question. */
const MAX_TOOL_ROUNDS = 25;

/**
 * Accès aux modèles Copilot via l'API Language Model de VS Code, avec une boucle
 * agent : le modèle peut appeler les outils de l'espace de travail, dont les
 * résultats lui sont renvoyés jusqu'à sa réponse finale.
 */
export class CopilotBackend implements ModelBackend {
  constructor(private readonly tools: WorkspaceTools) {}

  async ask(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const model = request.modelId ? await selectById(request.modelId) : await selectModel();
    const messages = request.turns.map((t) =>
      t.role === 'user'
        ? vscode.LanguageModelChatMessage.User(t.content)
        : vscode.LanguageModelChatMessage.Assistant(t.content),
    );
    return { modelName: model.name, events: this.run(model, messages, request.author, signal) };
  }

  private async *run(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    author: string,
    signal: AbortSignal,
  ): AsyncGenerator<ModelEvent> {
    const cts = new vscode.CancellationTokenSource();
    const onAbort = () => cts.cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    let tools = this.tools.definitions();
    let toolCounter = 0;

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        let response: vscode.LanguageModelChatResponse;
        try {
          response = await model.sendRequest(
            messages,
            {
              justification: 'Shared Copilot Chat envoie les questions des participants de la session partagée.',
              tools: tools.length ? tools : undefined,
            },
            cts.token,
          );
        } catch (err) {
          // Certains modèles n'acceptent pas les outils : on réessaie sans.
          if (tools.length && round === 0 && /tool/i.test(String((err as Error)?.message))) {
            tools = [];
            yield { type: 'text', text: "_Ce modèle ne prend pas en charge les outils : réponse sans accès aux fichiers._\n\n" };
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
          const id = `t${++toolCounter}`;
          const outcome = yield* this.runTool(id, call, author, signal);
          results.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(outcome)]));
          if (signal.aborted) {
            return;
          }
        }
        messages.push(vscode.LanguageModelChatMessage.User(results));
      }
      yield { type: 'text', text: `\n\n_Limite de ${MAX_TOOL_ROUNDS} étapes atteinte : reformulez ou découpez la demande._` };
    } finally {
      signal.removeEventListener('abort', onAbort);
      cts.dispose();
    }
  }

  /** Exécute un appel d'outil en publiant son avancement ; renvoie le texte à transmettre au modèle. */
  private async *runTool(
    id: string,
    call: vscode.LanguageModelToolCallPart,
    author: string,
    signal: AbortSignal,
  ): AsyncGenerator<ModelEvent, string> {
    const activity = (tool: ToolActivity): ModelEvent => ({ type: 'tool', tool });
    let prepared;
    try {
      prepared = await this.tools.prepare(call.name, call.input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield activity({ id, title: call.name, status: 'error', detail: message });
      return `Erreur : ${message}`;
    }

    const title = prepared.title;
    if (prepared.approval) {
      yield activity({ id, title, status: 'awaitingApproval', detail: "En attente de validation par l'hôte" });
      const approved = await this.tools.requestApproval(prepared, author);
      if (!approved || signal.aborted) {
        yield activity({ id, title, status: 'rejected', detail: "Refusé par l'hôte" });
        return "L'hôte a refusé cette action. Ne la retente pas telle quelle ; explique ce que tu voulais faire ou propose une alternative.";
      }
    }

    yield activity({ id, title, status: 'running' });
    try {
      const { result, summary } = await prepared.execute(signal);
      yield activity({ id, title, status: 'done', detail: summary });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield activity({ id, title, status: 'error', detail: message });
      return `Erreur : ${message}`;
    }
  }
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
  const family = vscode.workspace.getConfiguration('sharedCopilotChat').get<string>('modelFamily', '').trim();
  const match = family ? models.find((m) => m.family === family) : undefined;
  return (match ?? models[0])?.id ?? null;
}

async function selectById(id: string): Promise<vscode.LanguageModelChat> {
  const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', id });
  if (!model) {
    throw new Error("Le modèle choisi n'est plus disponible chez l'hôte. Choisissez-en un autre.");
  }
  return model;
}

async function selectModel(): Promise<vscode.LanguageModelChat> {
  const family = vscode.workspace.getConfiguration('sharedCopilotChat').get<string>('modelFamily', '').trim();
  const models = await vscode.lm.selectChatModels(family ? { vendor: 'copilot', family } : { vendor: 'copilot' });
  if (models.length > 0) {
    return models[0];
  }
  if (family) {
    const available = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    const families = [...new Set(available.map((m) => m.family))].join(', ');
    throw new Error(
      `Aucun modèle Copilot de la famille « ${family} ». ` +
        (families ? `Familles disponibles : ${families}.` : 'Aucun modèle Copilot disponible.'),
    );
  }
  throw new Error(
    "Aucun modèle Copilot disponible chez l'hôte. Vérifiez que GitHub Copilot Chat est installé et connecté.",
  );
}

function toReadableError(err: unknown): Error {
  if (err instanceof vscode.LanguageModelError) {
    switch (err.code) {
      case vscode.LanguageModelError.NoPermissions().code:
        return new Error(
          "L'hôte n'a pas autorisé Shared Copilot Chat à utiliser les modèles Copilot (consentement refusé ou en attente dans VS Code).",
        );
      case vscode.LanguageModelError.Blocked().code:
        return new Error('Requête bloquée par Copilot (quota atteint ou limite de débit). Réessayez plus tard.');
      case vscode.LanguageModelError.NotFound().code:
        return new Error("Le modèle Copilot demandé n'existe plus.");
    }
    return new Error(`Erreur du modèle : ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
