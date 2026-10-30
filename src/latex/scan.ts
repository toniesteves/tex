// Single-file LaTeX scanner, no I/O. Comments and verbatim bodies are masked first (replaced by spaces, offsets kept),
// so nothing inside them counts. Lines and columns are 1-based; columns are UTF-16 units, like CodeMirror positions.

export type HeadingKind = "part" | "chapter" | "section" | "subsection" | "subsubsection" | "paragraph" | "subparagraph" | "frame";
export type IncludeKind = "input" | "include" | "subfile" | "import" | "subimport" | "bibliography" | "addbibresource";

export interface Heading {
  kind: HeadingKind;
  level: number;
  title: string;
  offset: number;
  line: number;
}

export interface Label {
  key: string;
  offset: number;
  line: number;
  column: number;
  /** The innermost environment around the label (figure, equation, theorem…), else the heading before it. */
  context: string;
}

export interface KeyUse {
  key: string;
  line: number;
  column: number;
  length: number;
}

export interface Include {
  kind: IncludeKind;
  arg: string;
  /** The folder argument of `\import` and `\subimport`. */
  dir?: string;
  offset: number;
  line: number;
}

export interface CustomCommand {
  name: string;
  args: number;
}

export interface FileScan {
  headings: Heading[];
  labels: Label[];
  refs: KeyUse[];
  cites: KeyUse[];
  includes: Include[];
  bibitems: string[];
  commands: CustomCommand[];
  environments: string[];
  documentClass?: string;
  magicRoot?: string;
  magicProgram?: string;
  externalDocument: boolean;
  /** Offset of `\begin{document}`, or -1. */
  beginDocument: number;
}

const LEVELS: Record<string, [HeadingKind, number]> = {
  part: ["part", -1],
  chapter: ["chapter", 0],
  section: ["section", 1],
  subsection: ["subsection", 2],
  subsubsection: ["subsubsection", 3],
  paragraph: ["paragraph", 4],
  subparagraph: ["subparagraph", 5],
};
export const FRAME_LEVEL = 3;

const REF_COMMANDS = new Set([
  "ref", "eqref", "pageref", "autoref", "nameref", "vref", "cref", "Cref", "cpageref", "Cpageref", "labelcref",
  "crefrange", "Crefrange", "namecref", "nameCref",
]);
const VERBATIM_ENVIRONMENTS = new Set(["verbatim", "verbatim*", "Verbatim", "Verbatim*", "BVerbatim", "LVerbatim", "lstlisting", "minted", "comment"]);
const INCLUDES: Record<string, IncludeKind> = { input: "input", include: "include", subfile: "subfile", addbibresource: "addbibresource" };
const NEW_COMMANDS = new Set(["newcommand", "renewcommand", "providecommand", "DeclareRobustCommand"]);
const DOCUMENT_COMMANDS = new Set(["NewDocumentCommand", "RenewDocumentCommand", "ProvideDocumentCommand", "DeclareDocumentCommand"]);
const NEW_ENVIRONMENTS = new Set([
  "newenvironment", "renewenvironment", "NewDocumentEnvironment", "RenewDocumentEnvironment", "newtheorem",
  "declaretheorem", "newtcolorbox", "newtcbtheorem",
]);

export const isCiteCommand = (name: string): boolean => name.toLowerCase().includes("cite");

/** The text with comments and verbatim bodies replaced by spaces (line breaks kept). */
export function mask(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "%") {
      const eol = text.indexOf("\n", i);
      const end = eol < 0 ? text.length : eol;
      blank(i, end);
      i = end;
    } else if (c !== "\\") {
      i++;
    } else if (text.startsWith("\\verb", i) && !/[a-zA-Z]/.test(text[i + 5] ?? "")) {
      let start = i + 5;
      if (text[start] === "*") start++;
      const delimiter = text[start];
      const close = delimiter && delimiter !== "\n" ? text.indexOf(delimiter, start + 1) : -1;
      const eol = text.indexOf("\n", start);
      const end = close >= 0 && (eol < 0 || close < eol) ? close : start;
      blank(start + 1, end);
      i = end + 1;
    } else if (text.startsWith("\\begin{", i)) {
      const close = text.indexOf("}", i + 7);
      const name = close > 0 ? text.slice(i + 7, close) : "";
      if (VERBATIM_ENVIRONMENTS.has(name)) {
        const end = text.indexOf(`\\end{${name}}`, close);
        blank(close + 1, end < 0 ? text.length : end);
        i = end < 0 ? text.length : end + name.length + 6;
      } else {
        i += 7;
      }
    } else {
      i += 2; // an escaped character: \% \\ \{ …
    }
  }
  return out.join("");
}

/** Offset → line and column. */
export class LineIndex {
  private starts = [0];
  constructor(text: string) {
    for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) this.starts.push(i + 1);
  }
  line(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
  column(offset: number): number {
    return offset - this.starts[this.line(offset) - 1]! + 1;
  }
}

const skipSpace = (text: string, i: number): number => {
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
};

/** Index of the bracket closing the one at `open` (escaped brackets do not count), or -1. */
function closing(text: string, open: number, o: string, c: string): number {
  let depth = 0;
  const limit = Math.min(text.length, open + 20000);
  for (let i = open; i < limit; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i;
  }
  return -1;
}

export interface Arg {
  start: number;
  end: number;
  next: number;
}

/** Skips spaces, a star and `[…]`/`<…>` groups (when `optional`), then reads one `{…}` group. */
export function readArg(text: string, from: number, optional = true): Arg | null {
  let i = skipSpace(text, from);
  if (text[i] === "*") i = skipSpace(text, i + 1);
  while (optional && (text[i] === "[" || text[i] === "<")) {
    const close = text[i] === "[" ? closing(text, i, "[", "]") : text.indexOf(">", i);
    if (close < 0) return null;
    i = skipSpace(text, close + 1);
  }
  if (text[i] !== "{") return null;
  const close = closing(text, i, "{", "}");
  return close < 0 ? null : { start: i + 1, end: close, next: close + 1 };
}

/** A heading title as plain text: labels removed, simple formatting unwrapped, whitespace collapsed. */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/\\label\s*\{[^}]*\}/g, "")
    .replace(/\\(?:[a-zA-Z]+)\*?\s*(?:\[[^\]]*\])?\{([^{}]*)\}/g, "$1")
    .replace(/\\\\|~/g, " ")
    .replace(/\\(?:[a-zA-Z]+)\*?/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The keys of a comma-separated argument, each with its exact position. */
function keys(text: string, arg: Arg, lines: LineIndex): KeyUse[] {
  const uses: KeyUse[] = [];
  let start = arg.start;
  for (const part of text.slice(arg.start, arg.end).split(",")) {
    const lead = part.length - part.trimStart().length;
    const key = part.trim();
    if (key && !/[#\\{}\s]/.test(key)) {
      const offset = start + lead;
      uses.push({ key, line: lines.line(offset), column: lines.column(offset), length: key.length });
    }
    start += part.length + 1;
  }
  return uses;
}

/** `\newcommand{\foo}[2][x]{…}` / `\newcommand\foo…` → the name, the offset after it. */
function definedName(text: string, from: number): { name: string; next: number } | null {
  const i = skipSpace(text, text[from] === "*" ? from + 1 : from);
  const direct = /^\\([a-zA-Z@]+)/.exec(text.slice(i, i + 80));
  if (direct) return { name: direct[1]!, next: i + direct[0].length };
  const arg = readArg(text, i, false);
  const inner = arg && /^\s*\\([a-zA-Z@]+)\s*$/.exec(text.slice(arg.start, arg.end));
  return inner && arg ? { name: inner[1]!, next: arg.next } : null;
}

export function scan(text: string): FileScan {
  const m = mask(text);
  const lines = new LineIndex(text);
  const result: FileScan = {
    headings: [], labels: [], refs: [], cites: [], includes: [], bibitems: [], commands: [], environments: [],
    externalDocument: false, beginDocument: -1,
  };
  for (const line of text.split("\n", 20)) {
    const magic = /^\s*%\s*!\s*TeX\s+(root|program|TS-program)\s*=\s*(.+?)\s*$/i.exec(line);
    if (magic?.[1]?.toLowerCase() === "root") result.magicRoot = magic[2];
    else if (magic) result.magicProgram = magic[2]!.toLowerCase();
  }

  const envs: string[] = [];
  let lastTitle = "";
  let untitledFrame: Heading | null = null;
  const re = /\\(?:([a-zA-Z@]+)|[^a-zA-Z@])/g; // `\\` is consumed whole, so `a\\b` has no `\b`
  for (let match: RegExpExecArray | null; (match = re.exec(m)); ) {
    const name = match[1];
    if (!name) continue;
    const at = match.index;
    const after = at + match[0].length;
    const level = LEVELS[name];
    if (level) {
      const arg = readArg(m, after);
      if (arg) {
        lastTitle = cleanTitle(text.slice(arg.start, arg.end));
        result.headings.push({ kind: level[0], level: level[1], title: lastTitle, offset: at, line: lines.line(at) });
      }
      continue;
    }
    if (REF_COMMANDS.has(name)) {
      const arg = readArg(m, after);
      if (arg) result.refs.push(...keys(m, arg, lines));
      if (arg && name.toLowerCase() === "crefrange") {
        const second = readArg(m, arg.next, false);
        if (second) result.refs.push(...keys(m, second, lines));
      }
      continue;
    }
    if (isCiteCommand(name)) {
      const arg = readArg(m, after);
      if (arg) result.cites.push(...keys(m, arg, lines).filter((k) => k.key !== "*"));
      continue;
    }
    const include = INCLUDES[name];
    if (include) {
      const arg = readArg(m, after);
      if (arg) result.includes.push({ kind: include, arg: m.slice(arg.start, arg.end).trim(), offset: at, line: lines.line(at) });
      continue;
    }
    if (NEW_COMMANDS.has(name)) {
      const defined = definedName(m, after);
      if (!defined) continue;
      const count = /^\s*\[\s*(\d)\s*\]/.exec(m.slice(defined.next, defined.next + 20));
      const optional = count && /^\s*\[\s*\d\s*\]\s*\[/.test(m.slice(defined.next, defined.next + 30));
      result.commands.push({ name: defined.name, args: Math.max(0, Number(count?.[1] ?? 0) - (optional ? 1 : 0)) });
      continue;
    }
    if (DOCUMENT_COMMANDS.has(name)) {
      const defined = definedName(m, after);
      const spec = defined && readArg(m, defined.next, false);
      if (defined && spec) result.commands.push({ name: defined.name, args: (m.slice(spec.start, spec.end).match(/[mvr]/g) ?? []).length });
      continue;
    }
    if (NEW_ENVIRONMENTS.has(name)) {
      const arg = readArg(m, after, false);
      if (arg) result.environments.push(m.slice(arg.start, arg.end).trim());
      continue;
    }
    switch (name) {
      case "begin": {
        const arg = readArg(m, after, false);
        if (!arg) break;
        const env = m.slice(arg.start, arg.end).trim();
        envs.push(env);
        if (env === "document") result.beginDocument = at;
        if (env === "frame") {
          const title = readArg(m, arg.next);
          const sameLine = title && !m.slice(arg.next, title.start).includes("\n\n");
          const heading: Heading = {
            kind: "frame", level: FRAME_LEVEL, title: title && sameLine ? cleanTitle(text.slice(title.start, title.end)) : "",
            offset: at, line: lines.line(at),
          };
          result.headings.push(heading);
          untitledFrame = heading.title ? null : heading;
        }
        break;
      }
      case "end": {
        const arg = readArg(m, after, false);
        const env = arg ? m.slice(arg.start, arg.end).trim() : "";
        const index = envs.lastIndexOf(env);
        if (index >= 0) envs.length = index;
        break;
      }
      case "frametitle": {
        const arg = readArg(m, after);
        if (arg && untitledFrame) untitledFrame.title = cleanTitle(text.slice(arg.start, arg.end));
        untitledFrame = null;
        break;
      }
      case "label": {
        const arg = readArg(m, after, false);
        const key = arg ? m.slice(arg.start, arg.end).trim() : "";
        if (!arg || !key || /[#\\]/.test(key)) break;
        const offset = arg.start + (m.slice(arg.start, arg.end).length - m.slice(arg.start, arg.end).trimStart().length);
        const env = envs.findLast((e) => e !== "document" && e !== "frame" && e !== "center");
        result.labels.push({ key, offset: at, line: lines.line(offset), column: lines.column(offset), context: env ?? lastTitle });
        break;
      }
      case "bibitem": {
        const arg = readArg(m, after);
        if (arg) result.bibitems.push(m.slice(arg.start, arg.end).trim());
        break;
      }
      case "bibliography": {
        const arg = readArg(m, after, false);
        if (arg) {
          for (const part of m.slice(arg.start, arg.end).split(",")) {
            if (part.trim()) result.includes.push({ kind: "bibliography", arg: part.trim(), offset: at, line: lines.line(at) });
          }
        }
        break;
      }
      case "import":
      case "subimport": {
        const dir = readArg(m, after);
        const file = dir && readArg(m, dir.next, false);
        if (dir && file) {
          result.includes.push({
            kind: name as IncludeKind, dir: m.slice(dir.start, dir.end).trim(), arg: m.slice(file.start, file.end).trim(), offset: at, line: lines.line(at),
          });
        }
        break;
      }
      case "documentclass": {
        const arg = readArg(m, after);
        if (arg) result.documentClass = m.slice(arg.start, arg.end).trim();
        break;
      }
      case "def": {
        const def = /^\s*\\([a-zA-Z@]+)((?:#\d)*)\s*\{/.exec(m.slice(after, after + 120));
        if (def) result.commands.push({ name: def[1]!, args: def[2]!.length / 2 });
        break;
      }
      case "DeclareMathOperator": {
        const defined = definedName(m, after);
        if (defined) result.commands.push({ name: defined.name, args: 0 });
        break;
      }
      case "externaldocument":
        result.externalDocument = true;
        break;
    }
  }
  return result;
}

const NON_TEXT_ARGUMENTS =
  /\\(?:label|[a-zA-Z]*ref|[a-zA-Z]*cite[a-zA-Z]*|input|include|subfile|import|subimport|includegraphics|includepdf|usepackage|RequirePackage|documentclass|bibliography(?:style)?|addbibresource|begin|end|url|[hv]space|setlength|addtolength|setcounter|newcommand|renewcommand|newenvironment|pagestyle|thispagestyle|color|definecolor)\*?\s*(?:\[[^\]]*\]|<[^>]*>)*(?:\{[^{}]*\})*/g;
const MATH =
  /\$\$[\s\S]*?\$\$|\$[^$]*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\\begin\{(equation|align|alignat|flalign|gather|multline|eqnarray|math|displaymath|dmath)(\*?)\}[\s\S]*?\\end\{\1\2\}/g;

/**
 * Words of running text, close to texcount's default rule: comments, math, verbatim, command names and arguments that
 * are not text (labels, references, file names…) do not count; the text of `\emph{…}`, titles and captions does.
 * Hyphenated words and words with accents count once; numbers count.
 */
export function countWords(text: string): number {
  const s = mask(text)
    .replace(/\\[$%&#_{}~^\\]/g, "  ")
    .replace(MATH, " ")
    .replace(NON_TEXT_ARGUMENTS, " ")
    .replace(/\\[a-zA-Z@]+\*?/g, " ");
  return (s.match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) ?? []).length;
}
