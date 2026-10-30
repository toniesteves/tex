// LaTeX completion for CodeMirror: commands and environments from the catalog plus the project's own definitions,
// labels after \ref, bibliography keys after \cite, files after \input / \includegraphics / \bibliography, packages
// and document classes.
import { snippet, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { t } from "../i18n";
import { basename, extname, relativePath } from "../util";
import { catalog, type CatalogItem } from "./catalog";
import type { ProjectIndex } from "./project-index";
import { isCiteCommand } from "./scan";

export interface CompletionHost {
  index(): ProjectIndex | null;
  /** Every file of the project. */
  files(): string[];
  /** The directory of the root file (relative file arguments start there). */
  mainDir(): string | null;
}

const COMMON = new Set([
  "\\section", "\\subsection", "\\begin", "\\end", "\\label", "\\ref", "\\eqref", "\\cite", "\\textbf", "\\emph", "\\textit",
  "\\item", "\\frac", "\\usepackage", "\\includegraphics", "\\caption", "\\input", "\\footnote", "\\chapter",
]);
const CLASSES = [
  "article", "report", "book", "beamer", "memoir", "amsart", "amsbook", "scrartcl", "scrreprt", "scrbook", "standalone",
  "letter", "exam", "IEEEtran", "llncs", "elsarticle", "revtex4-2", "acmart", "abntex2", "moderncv",
];
const REF_COMMAND = /^(?:[a-zA-Z]*ref|[cC]ref(?:range)?|labelcref|namecref|nameCref)$/;
const IMAGE = new Set(["pdf", "png", "jpg", "jpeg", "eps", "svg"]);

/** Applies a snippet, swallowing a `}` that auto-pairing already put after the cursor. */
function snippetOption(template: string, option: Omit<Completion, "apply">, swallowBrace = false): Completion {
  const apply = snippet(template);
  return {
    ...option,
    apply: (view: EditorView, completion: Completion, from: number, to: number) =>
      apply(view, completion, from, swallowBrace && view.state.sliceDoc(to, to + 1) === "}" ? to + 1 : to),
  };
}

const describe = (item: CatalogItem): string | undefined =>
  [item.detail, item.package].filter(Boolean).join(" · ") || undefined;

let commandLists: { text: Completion[]; math: Completion[] } | null = null;

function commandOptions(host: CompletionHost, math: boolean): Completion[] {
  // CodeMirror ranks by match first (a partial match loses 100 points) and then adds `boost` (−99…99), so only large
  // boosts move math commands below text commands in running text (`\sec` after `\section`), and the reverse in math.
  commandLists ??= (() => {
    const make = (mathFirst: boolean) => [
      ...catalog.commands.map((c) => snippetOption(c.insertText, { label: c.label, detail: describe(c), type: "keyword", boost: (COMMON.has(c.label) ? 5 : 0) - (mathFirst ? 20 : 0) })),
      ...catalog.mathCommands.map((c) => snippetOption(c.insertText, { label: c.label, detail: describe(c), type: "function", boost: mathFirst ? 20 : -99 })),
    ];
    return { text: make(false), math: make(true) };
  })();
  const own = (host.index()?.commands ?? []).map((c) =>
    snippetOption(`\\${c.name}${Array.from({ length: c.args }, (_, i) => `{\${${i + 1}}}`).join("")}`, {
      label: `\\${c.name}`, detail: t("Defined in project"), type: "variable", boost: 1,
    }),
  );
  return [...own, ...(math ? commandLists.math : commandLists.text)];
}

function environmentOptions(host: CompletionHost): Completion[] {
  const own = [...new Set(host.index()?.environments ?? [])].map((name) =>
    snippetOption(`${name}}\n\t\${0}\n\\end{${name}}`, { label: name, detail: t("Defined in project"), type: "variable", boost: 1 }, true),
  );
  return [...own, ...catalog.environments.map((e) => snippetOption(e.insertText, { label: e.label, detail: describe(e), type: "class" }, true))];
}

/** The innermost environment opened before `pos` and not closed yet. */
export function openEnvironment(text: string): string | null {
  const stack: string[] = [];
  for (const m of text.matchAll(/\\(begin|end)\s*\{([^{}]+)\}/g)) {
    if (m[1] === "begin") stack.push(m[2]!);
    else if (stack.at(-1) === m[2]) stack.pop();
  }
  return stack.at(-1) ?? null;
}

function endOptions(ctx: CompletionContext, host: CompletionHost): Completion[] {
  const open = openEnvironment(ctx.state.sliceDoc(Math.max(0, ctx.pos - 50000), ctx.pos));
  const names = new Set([...(open ? [open] : []), ...(host.index()?.environments ?? []), ...catalog.environments.map((e) => e.label)]);
  return [...names].map((name) =>
    snippetOption(`${name}}`, { label: name, type: "class", boost: name === open ? 99 : 0, detail: name === open ? t("Closes the open environment") : undefined }, true),
  );
}

function argumentOptions(command: string, host: CompletionHost): Completion[] | null {
  const index = host.index();
  const mainDir = host.mainDir();
  const files = (filter: (path: string) => boolean, dropExtension: boolean): Completion[] =>
    mainDir === null
      ? []
      : host.files().filter(filter).map((path) => {
          const rel = relativePath(mainDir, path);
          return { label: dropExtension ? rel.replace(/\.[^./]+$/, "") : rel, type: "text", detail: basename(path) };
        });
  if (REF_COMMAND.test(command)) {
    return (index?.labels ?? []).map((l) => ({ label: l.key, detail: l.context, info: `${basename(l.path)}:${l.line}`, type: "constant" }));
  }
  if (isCiteCommand(command)) {
    return [...(index?.bibliography.values() ?? [])].map((b) => ({
      label: b.key, detail: [b.author?.split(/ and |,/)[0], b.year].filter(Boolean).join(" ") || undefined, info: b.title, type: "constant",
    }));
  }
  switch (command) {
    case "input":
    case "include":
    case "subfile":
      return files((p) => extname(p) === "tex" && p !== index?.main, true);
    case "includegraphics":
    case "includepdf":
      return files((p) => IMAGE.has(extname(p)), false);
    case "bibliography":
      return files((p) => extname(p) === "bib", true);
    case "addbibresource":
      return files((p) => extname(p) === "bib", false);
    case "usepackage":
    case "RequirePackage":
      return catalog.packages.map((p) => ({ label: p.label, detail: p.detail, type: "namespace" }));
    case "documentclass":
      return CLASSES.map((label) => ({ label, type: "namespace" }));
    default:
      return null;
  }
}

/** Whether `before` (the text before the cursor) ends inside math, judged on the current paragraph. */
export function inMath(before: string): boolean {
  const paragraph = before.slice(before.lastIndexOf("\n\n") + 1).replace(/\\\$/g, "");
  const count = (re: RegExp, s = paragraph) => (s.match(re) ?? []).length;
  if (count(/\$\$/g) % 2 === 1 || count(/\$/g, paragraph.replace(/\$\$/g, "")) % 2 === 1) return true;
  if (count(/\\\(/g) > count(/\\\)/g) || count(/\\\[/g) > count(/\\\]/g)) return true;
  const env = /\\(begin|end)\{(?:equation|align|alignat|flalign|gather|multline|eqnarray|math|displaymath|dmath)\*?\}/g;
  let depth = 0;
  for (const m of before.matchAll(env)) depth += m[1] === "begin" ? 1 : -1;
  return depth > 0;
}

export function latexCompletion(host: CompletionHost): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(Math.max(0, ctx.pos - line.from - 400), ctx.pos - line.from);
    const environment = /\\(begin|end)\s*\{([^{}]*)$/.exec(before);
    if (environment) {
      return {
        from: ctx.pos - environment[2]!.length,
        options: environment[1] === "begin" ? environmentOptions(host) : endOptions(ctx, host),
        validFor: /^[^{}\s]*$/,
      };
    }
    const argument = /\\([a-zA-Z]+)\*?\s*(?:\[[^\]]*\]|<[^>]*>)*\{([^{}]*)$/.exec(before);
    if (argument) {
      const options = argumentOptions(argument[1]!, host);
      const value = argument[2]!;
      const item = value.slice(value.lastIndexOf(",") + 1).trimStart();
      return options ? { from: ctx.pos - item.length, options, validFor: /^[^{},\s]*$/ } : null;
    }
    const command = /\\[a-zA-Z@]*$/.exec(before);
    if (command) {
      const text = ctx.state.sliceDoc(Math.max(0, ctx.pos - 4000), ctx.pos);
      return { from: ctx.pos - command[0].length, options: commandOptions(host, inMath(text)), validFor: /^\\[a-zA-Z@]*$/ };
    }
    return null;
  };
}
