// TeX and BibTeX logs → diagnostics on project files. The log must be unwrapped (`max_print_line=10000`, set by the
// Rust side) and come from `-file-line-error`.
import { joinPath, normalizePath } from "../util";

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: Severity;
  message: string;
  path: string;
  /** 1-based; 0 when the message has no line. */
  line: number;
  column?: number;
  /** UTF-16 length of the underlined span starting at `column`. */
  length?: number;
  source: "latex" | "bibtex" | "reference";
  detail?: string;
  missingFile?: string;
}

export interface LogContext {
  /** The directory TeX ran in. */
  cwd: string;
  /** The root file, for messages without a file. */
  main: string;
  /** Cache path → project path of the buffers compiled unsaved. */
  overlays: Record<string, string>;
}

const FILE_NAME = /\.(tex|sty|cls|cfg|def|clo|fd|aux|toc|lof|lot|bbl|out|nav|ind|ltx|dtx|bib|lua|mkii|tikz|map|pfb|enc)$/i;
const looksLikePath = (s: string): boolean => /^(\.{1,2})?\//.test(s) || FILE_NAME.test(s);

function resolver(ctx: LogContext): (p: string) => string {
  return (p) => {
    const abs = p.startsWith("/") ? normalizePath(p) : joinPath(ctx.cwd, p);
    return ctx.overlays[abs] ?? abs;
  };
}

interface ErrorContext {
  line?: number;
  detail: string;
  /** The control sequence at the end of the `l.N` line ("Undefined control sequence"). */
  token?: string;
  /** Lines that belong to the error (their parentheses are user text). */
  span: number;
}

/** The `l.N …` lines after an error: its line number and the source context. */
function errorContext(lines: string[], from: number): ErrorContext {
  for (let i = from; i < Math.min(lines.length, from + 12); i++) {
    const line = lines[i]!;
    const at = /^l\.(\d+) (.*)$/.exec(line);
    if (at) {
      const token = /(\\[a-zA-Z@]+|\\.)\s*$/.exec(at[2]!)?.[1];
      return { line: Number(at[1]), detail: `${line}\n${lines[i + 1] ?? ""}`.trimEnd(), token, span: i + 2 - from };
    }
    // Another error starts: this one has no context. ("Emergency stop" belongs to a missing-file error.)
    const next = /^(\S.*?):\d+: (.*)$/.exec(line);
    if (line.startsWith("! ") || (next && looksLikePath(next[1]!) && next[2] !== "Emergency stop.")) break;
  }
  return { detail: "", span: 0 };
}

/** A warning and its continuation lines (`(pkg)   …`, or anything up to the next blank line). */
function warningText(lines: string[], from: number, first: string): { text: string; span: number } {
  let text = first;
  let i = from;
  while (i < lines.length && lines[i] !== "" && !/^(?:\.{0,2}\/|! |LaTeX |Package |Class )/.test(lines[i]!)) {
    text += " " + lines[i]!.replace(/^\([^)]*\)\s*/, "").trim();
    i++;
  }
  return { text: text.replace(/\s+/g, " ").trim(), span: i - from };
}

export function parseLog(log: string, ctx: LogContext): Diagnostic[] {
  const resolve = resolver(ctx);
  const lines = log.split(/\r?\n/);
  const stack: (string | null)[] = [];
  const current = (): string => stack.findLast((f) => f !== null) ?? ctx.main;
  const found: Diagnostic[] = [];
  let userText = 0; // following lines whose parentheses are not the file stack

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fileLine = /^(\S.*?):(\d+): (.*)$/.exec(line);
    if (fileLine && looksLikePath(fileLine[1]!)) {
      const message = fileLine[3]!.trim();
      const context = errorContext(lines, i + 1);
      userText = context.span;
      if (!message.startsWith("==> Fatal error") && message !== "Emergency stop.") {
        found.push({
          severity: "error",
          message: context.token && message.startsWith("Undefined control sequence") ? `Undefined control sequence ${context.token}` : message,
          path: resolve(fileLine[1]!),
          line: Number(fileLine[2]),
          source: "latex",
          detail: context.detail || undefined,
        });
      }
      continue;
    }
    if (line.startsWith("! ")) {
      const context = errorContext(lines, i + 1);
      userText = context.span;
      const message = line.slice(2).trim();
      if (message !== "Emergency stop." && !message.startsWith("==> Fatal error")) {
        found.push({
          severity: "error", message, path: current(), line: context.line ?? 0, source: "latex", detail: context.detail || undefined,
          missingFile: /File [`']([^']+)' not found/.exec(message)?.[1],
        });
      }
      continue;
    }
    const warning = /^(LaTeX Font|LaTeX|Package \S+|Class \S+) Warning: (.*)$/.exec(line) ?? /^(pdfTeX) warning(?: \([^)]*\))?: (.*)$/.exec(line);
    if (warning) {
      const { text, span } = warningText(lines, i + 1, warning[2]!);
      userText = span;
      const at = /\s*on input line (\d+)\.?$/.exec(text);
      const message = at ? text.slice(0, at.index) : text;
      const info = warning[1] === "LaTeX Font" || /Rerun to get|may have changed/.test(message);
      found.push({ severity: info ? "info" : "warning", message, path: current(), line: Number(at?.[1] ?? 0), source: "latex" });
      continue;
    }
    const box = /^((?:Over|Under)full \\[hv]box \([^)]*\)).*?(?:at lines? (\d+)|detected at line (\d+))/.exec(line);
    if (box) {
      found.push({ severity: "info", message: box[1]!, path: current(), line: Number(box[2] ?? box[3]), source: "latex" });
      let j = i + 1;
      while (j < lines.length && lines[j] !== "") j++;
      userText = j - i;
      continue;
    }
    if (userText > 0) {
      userText--;
      continue;
    }
    for (let k = 0; k < line.length; k++) {
      if (line[k] === "(") {
        const token = /^[^\s()[\]{}<>"]*/.exec(line.slice(k + 1))![0];
        stack.push(token && looksLikePath(token) ? resolve(token) : null);
      } else if (line[k] === ")") {
        stack.pop();
      }
    }
  }
  return dedupe(found);
}

/** BibTeX's `.blg`: database entries it could not find, files it could not open, syntax errors with their line. */
export function parseBlg(blg: string, ctx: LogContext): Diagnostic[] {
  const found: Diagnostic[] = [];
  const lines = blg.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const warning = /^Warning--(.*)$/.exec(line);
    if (warning) {
      found.push({ severity: "warning", message: warning[1]!, path: ctx.main, line: 0, source: "bibtex" });
      continue;
    }
    const at = /^-+line (\d+) of file (.+)$/.exec(line);
    if (at && i > 0) {
      found.push({ severity: "error", message: lines[i - 1]!.trim(), path: joinPath(ctx.cwd, at[2]!.trim()), line: Number(at[1]), source: "bibtex" });
      continue;
    }
    if (/^I couldn't open (?:database|style) file|^I found no \\(?:bibdata|bibstyle|citation)/.test(line)) {
      found.push({ severity: "error", message: line.trim(), path: ctx.main, line: 0, source: "bibtex" });
    }
  }
  return dedupe(found);
}

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Without duplicates; errors first, then by file and line. */
export function dedupe(list: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return list
    .filter((d) => {
      const key = `${d.severity}|${d.path}|${d.line}|${d.column ?? ""}|${d.message}`;
      return !seen.has(key) && seen.add(key);
    })
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.path.localeCompare(b.path) || a.line - b.line);
}
