import * as vscode from 'vscode';
import type { ModelBackend, ModelResponse, ModelTurn } from './chatRoom';
import type { ModelInfo } from './protocol';

/** Accès aux modèles Copilot via l'API Language Model de VS Code. */
export class CopilotBackend implements ModelBackend {
  async ask(turns: ModelTurn[], signal: AbortSignal, modelId?: string): Promise<ModelResponse> {
    const model = modelId ? await selectById(modelId) : await selectModel();

    const cts = new vscode.CancellationTokenSource();
    const onAbort = () => cts.cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      cts.dispose();
    };

    const messages = turns.map((t) =>
      t.role === 'user'
        ? vscode.LanguageModelChatMessage.User(t.content)
        : vscode.LanguageModelChatMessage.Assistant(t.content),
    );

    let response: vscode.LanguageModelChatResponse;
    try {
      response = await model.sendRequest(
        messages,
        { justification: 'Shared Copilot Chat envoie les questions des participants de la session partagée.' },
        cts.token,
      );
    } catch (err) {
      cleanup();
      throw toReadableError(err);
    }

    async function* stream(): AsyncGenerator<string> {
      try {
        for await (const chunk of response.text) {
          yield chunk;
        }
      } catch (err) {
        throw toReadableError(err);
      } finally {
        cleanup();
      }
    }

    return { modelName: model.name, chunks: stream() };
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
