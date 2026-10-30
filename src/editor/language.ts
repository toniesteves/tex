// LaTeX highlighting: a CodeMirror stream tokenizer that knows commands, structure, environment names, math, reference
// arguments, comments, magic comments, verbatim and special characters. Colours are CSS variables (light and dark).
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StringStream } from "@codemirror/language";
import { Tag } from "@lezer/highlight";

const tags = {
  command: Tag.define(),
  structure: Tag.define(),
  environment: Tag.define(),
  math: Tag.define(),
  mathCommand: Tag.define(),
  reference: Tag.define(),
  comment: Tag.define(),
  magic: Tag.define(),
  brace: Tag.define(),
  special: Tag.define(),
  verbatim: Tag.define(),
};
type Token = keyof typeof tags;

const STRUCTURE = new Set([
  "part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph", "documentclass", "usepackage",
  "RequirePackage", "input", "include", "includeonly", "subfile", "import", "subimport", "maketitle", "tableofcontents",
  "appendix", "frontmatter", "mainmatter", "backmatter", "bibliography", "printbibliography", "addbibresource",
  "bibliographystyle", "frametitle",
]);
const REFERENCE_ARGUMENT = new Set([
  "label", "ref", "eqref", "pageref", "autoref", "nameref", "vref", "cref", "Cref", "cpageref", "labelcref", "input",
  "include", "includeonly", "subfile", "includegraphics", "includepdf", "usepackage", "RequirePackage", "documentclass",
  "bibliography", "addbibresource", "bibliographystyle", "lstinputlisting",
]);
const MATH_ENVIRONMENT = /^(?:equation|align|alignat|flalign|gather|multline|eqnarray|math|displaymath|dmath)\*?$/;
const VERBATIM_ENVIRONMENT = new Set(["verbatim", "verbatim*", "Verbatim", "Verbatim*", "BVerbatim", "LVerbatim", "lstlisting", "minted", "comment"]);

interface State {
  /** What closes the current math: `$`, `$$`, `\)`, `\]` or an environment. */
  math: null | "$" | "$$" | ")" | "]" | "env";
  mathEnv: string;
  /** Inside a verbatim environment: its name. It starts on the line after `\begin`. */
  verbatim: string | null;
  pendingVerbatim: string | null;
  /** The next `{…}` is an environment name or a reference; `inArg` while inside it. */
  arg: null | "begin" | "end" | "ref";
  inArg: null | "begin" | "end" | "ref";
}

function token(stream: StringStream, s: State): Token | null {
  if (stream.sol() && s.pendingVerbatim) {
    s.verbatim = s.pendingVerbatim;
    s.pendingVerbatim = null;
  }
  if (s.verbatim) {
    const end = stream.string.indexOf(`\\end{${s.verbatim}}`, stream.pos);
    if (end !== stream.pos) {
      stream.pos = end < 0 ? stream.string.length : end;
      return "verbatim";
    }
    s.verbatim = null;
  }
  if (s.inArg) {
    if (stream.eat("}")) {
      s.inArg = null;
      return "brace";
    }
    const name = stream.match(/^[^}%]+/) as RegExpMatchArray | null;
    if (!name) {
      stream.next();
      return null;
    }
    const value = name[0].trim();
    if (s.inArg === "ref") return "reference";
    if (s.inArg === "begin" && !s.math && MATH_ENVIRONMENT.test(value)) {
      s.math = "env";
      s.mathEnv = value;
    } else if (s.inArg === "end" && s.math === "env" && value === s.mathEnv) {
      s.math = null;
    } else if (s.inArg === "begin" && VERBATIM_ENVIRONMENT.has(value)) {
      s.pendingVerbatim = value;
    }
    return "environment";
  }

  const ch = stream.peek()!;
  if (ch === "%") {
    const magic = stream.match(/^%\s*!\s*(?:TEX|BIB)\b/i, false);
    stream.skipToEnd();
    return magic ? "magic" : "comment";
  }
  if (ch === "\\") {
    const command = stream.match(/^\\([a-zA-Z@]+)\*?/) as RegExpMatchArray | null;
    if (command) {
      const name = command[1]!;
      if (name === "verb") {
        const delimiter = stream.next();
        const end = delimiter ? stream.string.indexOf(delimiter, stream.pos) : -1;
        stream.pos = end < 0 ? stream.string.length : end + 1;
        return "verbatim";
      }
      if (name === "begin" || name === "end") {
        s.arg = name;
        return "structure";
      }
      s.arg = REFERENCE_ARGUMENT.has(name) || name.toLowerCase().includes("cite") ? "ref" : null;
      if (STRUCTURE.has(name)) return "structure";
      return s.math ? "mathCommand" : "command";
    }
    if (!s.math && (stream.match("\\(") || stream.match("\\["))) {
      s.math = stream.current() === "\\(" ? ")" : "]";
      return "math";
    }
    if ((s.math === ")" && stream.match("\\)")) || (s.math === "]" && stream.match("\\]"))) {
      s.math = null;
      return "math";
    }
    stream.next();
    stream.next();
    return s.math ? "mathCommand" : "command";
  }
  if (ch === "$") {
    const display = stream.match("$$");
    if (!display) stream.next();
    const kind = display ? "$$" : "$";
    if (s.math === kind) s.math = null;
    else if (!s.math) s.math = kind;
    return "math";
  }
  if (s.arg) {
    if (ch === "{") {
      stream.next();
      s.inArg = s.arg;
      s.arg = null;
      return "brace";
    }
    if (ch === "[") {
      const close = stream.string.indexOf("]", stream.pos);
      stream.pos = close < 0 ? stream.string.length : close + 1;
      return null;
    }
    if (stream.match(/^\s+/)) return null;
    s.arg = null;
  }
  if (ch === "{" || ch === "}") {
    stream.next();
    return "brace";
  }
  if ("&~^_#".includes(ch)) {
    stream.next();
    return "special";
  }
  if (!stream.match(/^[^\\$%{}&~^_#]+/)) stream.next();
  return s.math ? "math" : null;
}

export const latex = StreamLanguage.define<State>({
  name: "latex",
  startState: () => ({ math: null, mathEnv: "", verbatim: null, pendingVerbatim: null, arg: null, inArg: null }),
  token,
  // A blank line ends a paragraph, and with it any `$` left open while typing.
  blankLine: (s) => {
    if (s.math === "$") s.math = null;
    s.arg = null;
  },
  languageData: { commentTokens: { line: "%" } },
  tokenTable: tags,
});

export const latexHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.command, color: "var(--hl-command)" },
    { tag: tags.structure, color: "var(--hl-structure)" },
    { tag: tags.environment, color: "var(--hl-environment)" },
    { tag: tags.math, color: "var(--hl-math)" },
    { tag: tags.mathCommand, color: "var(--hl-math-command)" },
    { tag: tags.reference, color: "var(--hl-reference)" },
    { tag: tags.comment, color: "var(--hl-comment)", fontStyle: "italic" },
    { tag: tags.magic, color: "var(--hl-magic)", fontStyle: "italic" },
    { tag: tags.brace, color: "var(--hl-brace)" },
    { tag: tags.special, color: "var(--hl-special)" },
    { tag: tags.verbatim, color: "var(--hl-verbatim)" },
  ]),
);
