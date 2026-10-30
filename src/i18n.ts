// English text is the key; Brazilian Portuguese comes from a dictionary. The language follows the system unless the
// user picks one in Settings.
import { ptBR } from "./i18n.pt-BR";

export type Language = "system" | "en" | "pt-BR";

let dictionary: Record<string, string> | null = null;
export let locale = "en";

export function setLanguage(preference: Language): void {
  const lang = preference === "system" ? navigator.language : preference;
  dictionary = lang.toLowerCase().startsWith("pt") ? ptBR : null;
  locale = dictionary ? "pt-BR" : "en";
  document.documentElement.lang = locale;
}

const format = (value: string | number): string => (typeof value === "number" ? value.toLocaleString(locale) : value);

/** `t("Compiled in {s} s", { s: 0.4 })`. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const text = dictionary?.[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? format(vars[name]!) : match)) : text;
}

/** Singular or plural by count: `tn(n, "{n} word", "{n} words")`. */
export const tn = (n: number, one: string, other: string): string => t(n === 1 ? one : other, { n });

export const isPortuguese = (): boolean => locale === "pt-BR";
