import { describe, expect, it } from "vitest";
import { parseBib } from "./bib";
import { snippet } from "@codemirror/autocomplete";
import { EditorState, type Transaction } from "@codemirror/state";
import { catalog } from "./catalog";
import { inMath, openEnvironment } from "./completion";
import { parseLog } from "./log";
import { buildIndex, referenceDiagnostics } from "./project-index";
import { countWords, mask, scan } from "./scan";

import errorsLog from "./fixtures/errors.log?raw";
import missingLog from "./fixtures/missing.log?raw";

describe("scan", () => {
  it("masks comments and verbatim but keeps offsets", () => {
    const text = "a % \\label{x}\n\\verb|\\ref{y}| \\% b\n\\begin{verbatim}\n\\cite{z}\n\\end{verbatim}";
    const masked = mask(text);
    expect(masked.length).toBe(text.length);
    expect(masked).not.toMatch(/label|ref\{y|cite/);
    expect(masked).toContain("\\% b");
  });

  it("finds headings, labels with context, references and citations with exact positions", () => {
    const s = scan(
      [
        "% !TEX program = xelatex",
        "\\section[Short]{Long \\emph{title}}\\label{sec:a}",
        "\\begin{equation}\\label{eq:1} x \\end{equation}",
        "See \\ref{sec:a}, \\cref{eq:1, eq:2} and \\citep[p.~3]{knuth, lamport}.",
        "Line\\\\break \\nocite{*}",
      ].join("\n"),
    );
    expect(s.magicProgram).toBe("xelatex");
    expect(s.headings).toMatchObject([{ kind: "section", level: 1, title: "Long title", line: 2 }]);
    expect(s.labels).toMatchObject([
      { key: "sec:a", line: 2, column: 42, context: "Long title" },
      { key: "eq:1", line: 3, context: "equation" },
    ]);
    expect(s.refs.map((r) => [r.key, r.line, r.column, r.length])).toEqual([
      ["sec:a", 4, 10, 5],
      ["eq:1", 4, 24, 4],
      ["eq:2", 4, 30, 4],
    ]);
    expect(s.cites.map((c) => c.key)).toEqual(["knuth", "lamport"]);
  });

  it("finds includes, frames, definitions and the document class", () => {
    const s = scan(
      [
        "\\documentclass[11pt]{beamer}",
        "\\newcommand{\\R}{\\mathbb{R}}\\newcommand\\pair[2]{(#1,#2)}\\newcommand{\\opt}[2][x]{#1#2}",
        "\\NewDocumentCommand{\\norm}{m}{\\|#1\\|}\\def\\twice#1#2{#1#2}\\newtheorem{lemma}{Lemma}",
        "\\begin{document}\\input{sections/intro}\\include{ch/one}\\import{parts/}{p1}\\bibliography{refs,more}",
        "\\begin{frame}{First}\\end{frame}\\begin{frame}\\frametitle{Second}\\end{frame}",
      ].join("\n"),
    );
    expect(s.documentClass).toBe("beamer");
    expect(s.commands).toEqual([
      { name: "R", args: 0 },
      { name: "pair", args: 2 },
      { name: "opt", args: 1 },
      { name: "norm", args: 1 },
      { name: "twice", args: 2 },
    ]);
    expect(s.environments).toEqual(["lemma"]);
    expect(s.includes.map((i) => [i.kind, i.arg, i.dir])).toEqual([
      ["input", "sections/intro", undefined],
      ["include", "ch/one", undefined],
      ["import", "p1", "parts/"],
      ["bibliography", "refs", undefined],
      ["bibliography", "more", undefined],
    ]);
    expect(s.headings.map((h) => [h.kind, h.title])).toEqual([["frame", "First"], ["frame", "Second"]]);
  });

  it("counts words of running text only", () => {
    expect(countWords("Uma frase com acentuação e hífen-composto, 42 vezes.")).toBe(8);
    expect(countWords("Text $x+y$ and \\[ a=b \\] \\emph{emph} \\label{l} \\cite{k} % comment words")).toBe(3);
    expect(countWords("\\begin{equation} E = mc^2 \\end{equation} after")).toBe(1);
  });
});

describe("parseLog", () => {
  const ctx = { cwd: "/p", main: "/p/main.tex", overlays: {} };

  it("reads errors, warnings and bad boxes from a real pdflatex log", () => {
    const found = parseLog(errorsLog, ctx);
    const brief = found.map((d) => [d.severity, d.path.replace("/p/", ""), d.line, d.message]);
    expect(brief).toContainEqual(["error", "sections/a.tex", 3, "Undefined control sequence \\foo"]);
    expect(brief).toContainEqual(["error", "main.tex", 7, "Missing $ inserted."]);
    expect(brief).toContainEqual(["warning", "main.tex", 5, "Reference `sec:missing' on page 1 undefined"]);
    expect(brief).toContainEqual(["warning", "main.tex", 9, "Something odd happened here"]);
    expect(brief).toContainEqual(["info", "main.tex", 3, "Overfull \\hbox (411.60435pt too wide)"]);
    expect(found[0]!.severity).toBe("error");
    expect(found.find((d) => d.line === 3 && d.severity === "error")!.detail).toContain("l.3 Now \\foo");
  });

  it("reports a missing package once, without the fatal-error noise", () => {
    const found = parseLog(missingLog, { ...ctx, main: "/p/missing.tex" });
    expect(found.filter((d) => d.severity === "error")).toEqual([
      expect.objectContaining({ message: "LaTeX Error: File `doesnotexist.sty' not found.", path: "/p/missing.tex", line: 3, missingFile: "doesnotexist.sty" }),
    ]);
  });

  it("maps unsaved buffers compiled from the cache back to project files", () => {
    const log = "(/c/ov/0.tex\n/c/ov/0.tex:2: Undefined control sequence.\nl.2 \\oops\n\n)";
    const found = parseLog(log, { ...ctx, overlays: { "/c/ov/0.tex": "/p/sections/a.tex" } });
    expect(found).toMatchObject([{ path: "/p/sections/a.tex", line: 2, message: "Undefined control sequence \\oops" }]);
  });
});

describe("project index", () => {
  const files: Record<string, string> = {
    "/p/main.tex": "\\documentclass{article}\n\\begin{document}\n\\section{One}\\label{s1}\n\\input{sec/two}\n\\section{Three}\nSee \\ref{s2} \\ref{nope} \\cite{knuth} \\cite{ghost}\n\\bibliography{refs}\n\\end{document}",
    "/p/sec/two.tex": "\\section{Two}\\label{s2}\n\\subsection{Two A}\\label{s1}",
    "/p/refs.bib": "@book{knuth, title={The {\\TeX}book}, author={Donald Knuth}, year=1984}\n@string{x = \"y\"}",
  };
  const read = async (path: string) => files[path] ?? null;

  it("interleaves included files in the outline and aggregates labels and the bibliography", async () => {
    const index = await buildIndex("/p/main.tex", read);
    expect(index.files).toEqual(["/p/main.tex", "/p/sec/two.tex"]);
    const titles = (nodes: typeof index.outline): unknown[] => nodes.map((n) => (n.children.length ? [n.title, titles(n.children)] : n.title));
    expect(titles(index.outline)).toEqual([["One", ["s1"]], ["Two", ["s2", ["Two A", ["s1"]]]], "Three"]);
    expect([...index.bibliography.keys()]).toEqual(["knuth"]);
    expect(index.bibliography.get("knuth")!.title).toBe("The \\TeXbook");
  });

  it("warns about undefined references, duplicate labels and missing citations", async () => {
    const found = referenceDiagnostics(await buildIndex("/p/main.tex", read));
    expect(found.map((d) => [d.message, d.path.replace("/p/", ""), d.line])).toEqual([
      ["Reference ‘nope’ is not defined", "main.tex", 6],
      ["Label ‘s1’ is defined more than once", "main.tex", 3],
      ["Label ‘s1’ is defined more than once", "sec/two.tex", 2],
      ["Citation ‘ghost’ is not in the bibliography", "main.tex", 6],
    ]);
  });
});

describe("completion helpers", () => {
  it("has a consistent catalog: unique labels, environments that close themselves, fields CodeMirror can read", () => {
    for (const list of Object.values(catalog)) {
      const labels = list.map((item) => item.label);
      expect(labels.filter((label, i) => labels.indexOf(label) !== i)).toEqual([]);
    }
    for (const env of catalog.environments) {
      expect(env.insertText.startsWith(`${env.label}}`)).toBe(true);
      expect(env.insertText).toContain(`\\end{${env.label}}`);
    }
    // CodeMirror drops a backslash before a brace; field defaults cannot contain braces.
    for (const item of [...catalog.commands, ...catalog.mathCommands, ...catalog.environments]) {
      expect(item.insertText).not.toMatch(/\\[{}]|\$\{\d+:[^}]*\{/);
    }
  });

  it("inserts every catalog snippet as written, with the fields filled by their defaults", () => {
    for (const item of [...catalog.commands, ...catalog.mathCommands, ...catalog.environments]) {
      let state = EditorState.create({ doc: "" });
      snippet(item.insertText)({ state, dispatch: (tr: Transaction) => (state = tr.state) }, null, 0, 0);
      const expected = item.insertText.replace(/\$\{\d*\}/g, "").replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\s+/g, "");
      expect(state.doc.toString().replace(/\s+/g, ""), item.label).toBe(expected);
    }
  });

  it("knows math mode and the open environment", () => {
    expect(inMath("Text $x + \\al")).toBe(true);
    expect(inMath("Text $x$ and \\al")).toBe(false);
    expect(inMath("\\begin{align}\n a &= \\fr")).toBe(true);
    expect(openEnvironment("\\begin{itemize}\\begin{enumerate}\\end{enumerate}")).toBe("itemize");
  });

  it("parses bibliography entries", () => {
    expect(parseBib('@Article{a1,\n author = "Ada and Bob",\n date = {2020-01-02}\n}\n@comment{x,}')).toEqual([
      { key: "a1", type: "article", title: undefined, author: "Ada and Bob", year: "2020" },
    ]);
  });
});

describe("PDF → source word", () => {
  const text = ["\\section{Introdução}", "A palavra casa aparece aqui.", "Outra casa, e a casa azul.", "Eficiente."].join("\n");
  it("prefers the occurrence whose neighbours match", async () => {
    const { findSourceWord } = await import("./sync");
    const hit = findSourceWord(text, 3, "casa", "a ", " azul")!;
    expect(text.slice(hit.from, hit.to)).toBe("casa");
    expect(text.slice(hit.from - 2, hit.to + 5)).toBe("a casa azul");
  });
  it("ignores case, accents and ligatures, and matches hyphenation fragments", async () => {
    const { findSourceWord } = await import("./sync");
    expect(text.slice(...Object.values(findSourceWord(text, 1, "INTRODUCAO")!) as [number, number])).toBe("Introdução");
    expect(text.slice(...Object.values(findSourceWord(text, 4, "Eﬁcien")!) as [number, number])).toBe("Eficiente");
    expect(findSourceWord(text, 2, "section")).toBeNull();
  });
});
