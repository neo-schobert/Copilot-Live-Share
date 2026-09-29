import * as vscode from 'vscode';
import { Lang, LangPreference, Params, resolveLang } from './core';
import { ExtensionKey, extensionT } from './extension';

/** Préférence de l'utilisateur (réglage promptShare.language). */
export function languagePreference(): LangPreference {
  return vscode.workspace.getConfiguration('promptShare').get<LangPreference>('language', 'auto');
}

/** Langue de l'interface de l'extension : réglage, sinon langue de VS Code, sinon anglais. */
export function uiLang(): Lang {
  const preference = languagePreference();
  return resolveLang(preference === 'auto' ? undefined : preference, vscode.env.language);
}

/** Texte de l'extension dans la langue de l'utilisateur. */
export function t(key: ExtensionKey, params?: Params): string {
  return extensionT(uiLang(), key, params);
}
