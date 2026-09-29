/**
 * Traductions de Prompt Share : français, anglais, allemand. Partagé par l'extension,
 * le serveur de session et la page (navigateur ou webview) : aucune dépendance à Node
 * ni au DOM.
 *
 * Chaque domaine (page, extension, serveur) a son dictionnaire. Le français sert de
 * référence : les dictionnaires anglais et allemand sont typés sur ses clés, une clé
 * manquante est donc une erreur de compilation. Paramètres : « {nom} ».
 */

export type Lang = 'fr' | 'en' | 'de';

export const LANGS: readonly Lang[] = ['fr', 'en', 'de'];

/** Nom de chaque langue dans cette langue (sélecteurs). */
export const LANG_NAMES: Record<Lang, string> = { fr: 'Français', en: 'English', de: 'Deutsch' };

/** Préférence de langue : une langue, ou « auto » (langue de VS Code ou du navigateur). */
export type LangPreference = Lang | 'auto';

export type Params = Record<string, string | number>;

/** Texte à traduire chez chaque destinataire (messages du serveur, entrées de la discussion). */
export interface I18nText {
  key: string;
  params?: Params;
}

/** Première langue prise en charge parmi une préférence explicite puis des langues candidates ; anglais sinon. */
export function resolveLang(preference: string | null | undefined, ...candidates: (string | null | undefined)[]): Lang {
  for (const value of [preference, ...candidates]) {
    const base = value?.toLowerCase().split(/[-_]/)[0];
    if (base && (LANGS as readonly string[]).includes(base)) {
      return base as Lang;
    }
  }
  return 'en';
}

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

/** Remplace « {nom} » par la valeur du paramètre. */
export function format(template: string, params?: Params): string {
  return params ? template.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all)) : template;
}

export type Dictionary<K extends string> = Record<K, string>;

/** Traducteur d'un domaine : `t(lang, key, params)`. Clé inconnue (message d'une autre version) : la clé elle-même. */
export function translator<K extends string>(dicts: Record<Lang, Dictionary<K>>) {
  return (lang: Lang, key: K, params?: Params): string => format(dicts[lang][key] ?? dicts.en[key] ?? key, params);
}
