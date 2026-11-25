/*
 * Interface language. English is the source language: every string in the code
 * is written in English and passed to t(); other languages map the English
 * text to a translation (src/locales/<lang>.ts). A missing translation falls
 * back to English.
 */
import { Fragment, ReactNode, createElement } from "react";
import { it } from "./locales/it";

export type Lang = "en" | "it";
/** What the user picked in Settings: a language, or the system one. */
export type LangSetting = "system" | Lang;

export const LANGUAGES: { id: Lang; name: string }[] = [
  { id: "en", name: "English" },
  { id: "it", name: "Italiano" },
];

const dictionaries: Record<Lang, Record<string, string> | null> = { en: null, it };

let current: Lang = "en";

/** The language to use for a setting: "system" follows Windows, English otherwise. */
export function resolveLang(setting: LangSetting | undefined): Lang {
  if (setting === "en" || setting === "it") return setting;
  const sys = (typeof navigator !== "undefined" ? navigator.language : "en").toLowerCase();
  return sys.startsWith("it") ? "it" : "en";
}

export function setLang(l: Lang) {
  current = l;
  if (typeof document !== "undefined") document.documentElement.lang = l;
}

export function lang(): Lang {
  return current;
}

/** Locale for dates and numbers (24-hour clock in both languages). */
export function locale(): string {
  return current === "it" ? "it-IT" : "en-GB";
}

function translate(text: string): string {
  return dictionaries[current]?.[text] ?? text;
}

/** Translate `text`, replacing `{name}` placeholders with `vars`. */
export function t(text: string, vars?: Record<string, string | number>): string {
  const s = translate(text);
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Like t(), for placeholders that are elements (e.g. a bold name). */
export function tn(text: string, vars: Record<string, ReactNode>): ReactNode {
  const parts = translate(text).split(/(\{\w+\})/);
  return createElement(
    Fragment,
    null,
    ...parts.map((p, i) => {
      const m = /^\{(\w+)\}$/.exec(p);
      return createElement(Fragment, { key: i }, m && m[1] in vars ? vars[m[1]] : p);
    }),
  );
}
