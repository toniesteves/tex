import { describe, expect, it } from "vitest";
import { ptBR } from "./i18n.pt-BR";

// Every text the code translates, read from the sources: t("…"), both forms of tn(n, "…", "…"), command and
// template titles and descriptions, command categories and the Settings tabs.
const sources = import.meta.glob<string>(["./**/*.ts", "!./**/*.test.ts", "!./i18n.pt-BR.ts"], { query: "?raw", import: "default", eager: true });

function usedKeys(): Set<string> {
  const keys = new Set(["General", "Editor", "TeX", "Shortcuts"]);
  const unescape = (s: string) => JSON.parse(`"${s}"`) as string;
  for (const [path, source] of Object.entries(sources)) {
    for (const m of source.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(unescape(m[1]!));
    for (const m of source.matchAll(/\btn\([^,]+,\s*"((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(unescape(m[1]!)).add(unescape(m[2]!));
    for (const m of source.matchAll(/category: "(\w+)"/g)) keys.add(m[1]!);
    if (path.endsWith("/app.ts") || path.endsWith("/templates.ts")) {
      for (const m of source.matchAll(/\b(?:title|description): "((?:[^"\\]|\\.)*)"/g)) keys.add(unescape(m[1]!));
    }
  }
  return keys;
}

describe("Brazilian Portuguese", () => {
  it("translates every text of the interface, and nothing else", () => {
    const used = usedKeys();
    expect([...used].filter((key) => !(key in ptBR))).toEqual([]);
    expect(Object.keys(ptBR).filter((key) => !used.has(key))).toEqual([]);
  });

  it("keeps the placeholders of every text", () => {
    const names = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    expect(Object.entries(ptBR).filter(([en, pt]) => names(en) !== names(pt))).toEqual([]);
  });
});
