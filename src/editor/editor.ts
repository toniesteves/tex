// The LaTeX editor: one CodeMirror view, one EditorState per open file (each keeps its own undo history and scroll
// position). Settings apply live to every open file through compartments.
import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, completionStatus, startCompletion } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, toggleComment } from "@codemirror/commands";
import { bracketMatching, indentUnit } from "@codemirror/language";
import { lintGutter, lintKeymap, setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { gotoLine, highlightSelectionMatches, openSearchPanel, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import {
  Decoration, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers,
  type Command, type DecorationSet, type KeyBinding,
} from "@codemirror/view";
import { getCM, vim, Vim } from "@replit/codemirror-vim";
import { latexCompletion, type CompletionHost } from "../latex/completion";
import type { Diagnostic } from "../latex/log";
import { settings } from "../settings";
import { latex, latexHighlighting } from "./language";

export interface EditorHost {
  completion: CompletionHost;
  /** The text of a file changed (typing, undo, reload). */
  onChange(path: string): void;
  onCursor(line: number, column: number, selection: string): void;
  onCtrlClick(path: string, pos: number): void;
  onVimMode(mode: string | null): void;
  vimCommand(command: "write" | "writeAll" | "quit" | "make"): void;
}

/** Bindings the command registry owns (so they can be changed in Settings), taken out of CodeMirror's keymaps. */
const OWNED: unknown[] = [toggleComment, indentMore, indentLess, openSearchPanel, gotoLine, startCompletion];
const builtInKeys: KeyBinding[] = [...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, ...lintKeymap]
  .filter((binding) => !OWNED.includes(binding.run));

const flashEffect = StateEffect.define<{ from: number; to: number } | null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    decorations = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(flashEffect)) continue;
      const range = effect.value;
      decorations = !range
        ? Decoration.none
        : range.from === range.to
          ? Decoration.set([Decoration.line({ class: "cm-flash-line" }).range(tr.state.doc.lineAt(range.from).from)])
          : Decoration.set([Decoration.mark({ class: "cm-flash" }).range(range.from, range.to)]);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Enter right after `\begin{x}` (with nothing after the cursor) also writes `\end{x}`, unless it is already closed. */
const closeEnvironment: Command = (view) => {
  const { state } = view;
  const selection = state.selection.main;
  if (!selection.empty) return false;
  const line = state.doc.lineAt(selection.head);
  const before = line.text.slice(0, selection.head - line.from);
  const open = /\\begin\{([^{}]+)\}(?:\[[^\]]*\]|\{[^{}]*\})*\s*$/.exec(before);
  if (!open || line.text.slice(selection.head - line.from).trim()) return false;
  const name = open[1]!;
  let depth = 0;
  for (const m of state.sliceDoc(selection.head, selection.head + 20000).matchAll(/\\(begin|end)\{([^{}]+)\}/g)) {
    if (m[2] !== name) continue;
    if (m[1] === "begin") depth++;
    else if (depth-- === 0) return false;
  }
  const indent = /^\s*/.exec(line.text)![0];
  const unit = state.facet(indentUnit);
  view.dispatch({
    changes: { from: selection.head, insert: `\n${indent}${unit}\n${indent}\\end{${name}}` },
    selection: EditorSelection.cursor(selection.head + 1 + indent.length + unit.length),
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
};

/** Tab: accept the open suggestion, else open suggestions after a completable prefix, else indent. */
const tab: Command = (view) => {
  if (acceptCompletion(view)) return true;
  const { state } = view;
  const selection = state.selection.main;
  if (selection.empty && completionStatus(state) === null && settings.get("autoComplete")) {
    const line = state.doc.lineAt(selection.head);
    const before = line.text.slice(0, selection.head - line.from);
    if (/\\[a-zA-Z@]+$|\\[a-zA-Z]+\*?(?:\[[^\]]*\])*\{[^{}]*$/.test(before)) return startCompletion(view);
  }
  if (!selection.empty) return indentMore(view);
  view.dispatch(state.replaceSelection(state.facet(indentUnit)), { scrollIntoView: true, userEvent: "input" });
  return true;
};

/** WebKit queues every auto-repeated key until the page has handled the previous one, so when drawing falls behind the
 * repeat rate a held arrow key keeps moving long after it is released. Repeats that waited longer than this are
 * dropped, only while their timestamps advance, in case a backend stamps every repeat with the time of the first press. */
const STALE_REPEAT_MS = 100;
let lastKeyStamp = 0;
const dropStaleRepeats = Prec.highest(EditorView.domEventHandlers({
  keydown(event) {
    const advancing = event.timeStamp > lastKeyStamp;
    lastKeyStamp = event.timeStamp;
    return event.repeat && advancing && performance.now() - event.timeStamp > STALE_REPEAT_MS;
  },
}));

/** The word at or right before `pos` (a control word counts without its backslash). */
export function wordAt(doc: Text, pos: number): { word: string; from: number; to: number } | null {
  const line = doc.lineAt(pos);
  const offset = pos - line.from;
  const left = /[\p{L}\p{N}]*$/u.exec(line.text.slice(0, offset))![0];
  const right = /^[\p{L}\p{N}]*/u.exec(line.text.slice(offset))![0];
  const word = left + right;
  return word ? { word, from: pos - left.length, to: pos + right.length } : null;
}

/** Colours from the app's CSS variables, so the editor follows the light and dark palettes. A theme (not plain CSS)
 * is needed to win over CodeMirror's base theme. */
const appearance = EditorView.theme({
  "&": { color: "var(--fg)", backgroundColor: "var(--bg)" },
  ".cm-content": { caretColor: "var(--fg)", padding: "6px 0 40vh" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--accent)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--selection)" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--fg-3)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg)", fontWeight: "600" },
  ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
  ".cm-selectionMatch": { backgroundColor: "var(--accent-soft)" },
  "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": { backgroundColor: "var(--accent-soft)", outline: "none" },
  ".cm-searchMatch": { backgroundColor: "rgba(245, 158, 11, 0.3)", outline: "none" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(245, 158, 11, 0.6)" },
  ".cm-tooltip": { backgroundColor: "var(--bg-raised)", color: "var(--fg)", border: "1px solid var(--line-strong)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--on-accent)" },
  ".cm-panels": { backgroundColor: "var(--bg-sidebar)", color: "var(--fg)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--line)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
  ".cm-textfield": { backgroundColor: "var(--bg-raised)", border: "1px solid var(--line-strong)", borderRadius: "6px", color: "var(--fg)" },
  ".cm-button": { backgroundColor: "var(--bg-raised)", backgroundImage: "none", border: "1px solid var(--line-strong)", borderRadius: "6px", color: "var(--fg)" },
});

// Vim comes first: its keys must win over every other keymap.
const compartments = {
  vim: new Compartment(),
  lineNumbers: new Compartment(),
  wrap: new Compartment(),
  activeLine: new Compartment(),
  autoPair: new Compartment(),
  completion: new Compartment(),
  indent: new Compartment(),
  font: new Compartment(),
};
type Configurable = keyof typeof compartments;

const EDITOR_SETTINGS = ["vim", "lineNumbers", "wrap", "activeLine", "autoPair", "autoComplete", "indentSize", "fontSize", "fontFamily", "lineHeight"] as const;
const editorSignature = (): string => JSON.stringify(EDITOR_SETTINGS.map((key) => settings.get(key)));

let vimHost: EditorHost | null = null;
let vimReady = false;
function defineVimCommands(): void {
  if (vimReady) return;
  vimReady = true;
  Vim.defineEx("write", "w", () => vimHost?.vimCommand("write"));
  Vim.defineEx("wall", "wa", () => vimHost?.vimCommand("writeAll"));
  Vim.defineEx("quit", "q", () => vimHost?.vimCommand("quit"));
  Vim.defineEx("xit", "x", () => {
    vimHost?.vimCommand("write");
    vimHost?.vimCommand("quit");
  });
  Vim.defineEx("make", "mak", () => vimHost?.vimCommand("make"));
}

export class Editor {
  readonly view: EditorView;
  private states = new Map<string, EditorState>();
  private saved = new Map<string, Text>();
  private scrolls = new Map<string, number>();
  private flashTimer: number | undefined;
  private signature = editorSignature();
  current: string | null = null;

  constructor(parent: HTMLElement, private readonly host: EditorHost) {
    defineVimCommands();
    vimHost = host;
    this.view = new EditorView({
      parent,
      state: EditorState.create({ doc: "", extensions: EditorView.editable.of(false) }),
      dispatchTransactions: (trs, view) => {
        view.update(trs);
        if (!this.current) return;
        this.states.set(this.current, view.state);
        if (trs.some((tr) => tr.docChanged)) host.onChange(this.current);
        if (trs.some((tr) => tr.docChanged || tr.selection)) this.reportCursor();
      },
    });
    settings.onChange(() => this.reconfigure());
  }

  private configurable(): Record<Configurable, Extension> {
    const size = settings.get("indentSize");
    return {
      vim: settings.get("vim") ? vim() : [],
      lineNumbers: settings.get("lineNumbers") ? [lineNumbers(), highlightActiveLineGutter()] : [],
      wrap: settings.get("wrap") ? EditorView.lineWrapping : [],
      activeLine: settings.get("activeLine") ? highlightActiveLine() : [],
      autoPair: settings.get("autoPair") ? closeBrackets() : [],
      completion: autocompletion({
        override: [latexCompletion(this.host.completion)], activateOnTyping: settings.get("autoComplete"), icons: false, maxRenderedOptions: 80,
      }),
      indent: [EditorState.tabSize.of(size), indentUnit.of(" ".repeat(size))],
      font: EditorView.theme({
        "&": { fontSize: `${settings.get("fontSize")}px` },
        ".cm-scroller": { fontFamily: settings.get("fontFamily") || "var(--mono)", lineHeight: String(settings.get("lineHeight")) },
      }),
    };
  }

  private extensions(): Extension[] {
    return [
      ...Object.entries(this.configurable()).map(([name, extension]) => compartments[name as Configurable].of(extension)),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      bracketMatching(),
      highlightSelectionMatches(),
      appearance,
      latex,
      latexHighlighting,
      lintGutter(),
      flashField,
      dropStaleRepeats,
      keymap.of([{ key: "Tab", run: tab, shift: indentLess }, { key: "Enter", run: closeEnvironment }, ...builtInKeys]),
      EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
      EditorView.domEventHandlers({
        mousedown: (event, view) => {
          if (!event.ctrlKey || event.button !== 0 || !this.current) return false;
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos === null) return false;
          event.preventDefault();
          view.dispatch({ selection: EditorSelection.cursor(pos) });
          this.host.onCtrlClick(this.current, pos);
          return true;
        },
      }),
    ];
  }

  has(path: string): boolean {
    return this.states.has(path);
  }

  open(path: string, text: string): void {
    if (this.states.has(path)) return;
    const state = EditorState.create({ doc: text, extensions: this.extensions() });
    this.states.set(path, state);
    this.saved.set(path, state.doc);
  }

  show(path: string): void {
    const state = this.states.get(path);
    if (!state || this.current === path) return;
    if (this.current) this.scrolls.set(this.current, this.view.scrollDOM.scrollTop);
    this.current = path;
    this.view.setState(state);
    const top = this.scrolls.get(path) ?? 0;
    requestAnimationFrame(() => (this.view.scrollDOM.scrollTop = top));
    this.watchVimMode();
    this.reportCursor();
  }

  close(path: string): void {
    this.states.delete(path);
    this.saved.delete(path);
    this.scrolls.delete(path);
    if (this.current === path) {
      this.current = null;
      this.view.setState(EditorState.create({ doc: "", extensions: EditorView.editable.of(false) }));
    }
  }

  /** Renames an open file (after a rename or a move on disk). */
  rename(from: string, to: string): void {
    for (const map of [this.states, this.saved, this.scrolls] as Map<string, unknown>[]) {
      if (map.has(from)) {
        map.set(to, map.get(from));
        map.delete(from);
      }
    }
    if (this.current === from) this.current = to;
  }

  text(path: string): string | undefined {
    return this.states.get(path)?.doc.toString();
  }

  isDirty(path: string): boolean {
    const state = this.states.get(path);
    const saved = this.saved.get(path);
    return !!state && !!saved && (state.doc.length !== saved.length || !state.doc.eq(saved));
  }

  markSaved(path: string): void {
    const state = this.states.get(path);
    if (state) this.saved.set(path, state.doc);
  }

  /** Replaces the text with the version on disk; the change can be undone. */
  reload(path: string, text: string): void {
    const state = this.states.get(path);
    if (!state) return;
    const spec = { changes: { from: 0, to: state.doc.length, insert: text } };
    if (path === this.current) this.view.dispatch(spec);
    else this.states.set(path, state.update(spec).state);
    this.saved.set(path, this.states.get(path)!.doc);
    this.host.onChange(path);
  }

  setDiagnostics(path: string, diagnostics: Diagnostic[]): void {
    const state = this.states.get(path);
    if (!state) return;
    const spec = setDiagnostics(state, diagnostics.filter((d) => d.line > 0).map((d) => toCodeMirror(state.doc, d)));
    if (path === this.current) this.view.dispatch(spec);
    else this.states.set(path, state.update(spec).state);
  }

  /** Puts the caret on a 1-based position, centres it and flashes the range (or the line). */
  reveal(line: number, column?: number, length = 0): void {
    const doc = this.view.state.doc;
    const target = doc.line(Math.min(Math.max(1, line), doc.lines));
    const from = column ? Math.min(target.to, target.from + column - 1) : target.from;
    this.revealRange(from, Math.min(target.to, from + length));
  }

  revealRange(from: number, to: number): void {
    this.view.dispatch({
      selection: EditorSelection.cursor(from),
      effects: [EditorView.scrollIntoView(from, { y: "center" }), flashEffect.of({ from, to })],
    });
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => this.view.dispatch({ effects: flashEffect.of(null) }), 1300);
    this.focus();
  }

  focus(): void {
    this.view.focus();
  }

  /** Runs one of CodeMirror's editing commands (from the command palette or a shortcut). */
  run(command: Command): void {
    if (!this.current) return;
    command(this.view);
    this.focus();
  }

  cursor(): { line: number; column: number; word: string | null } {
    const state = this.view.state;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    return { line: line.number, column: head - line.from + 1, word: wordAt(state.doc, head)?.word ?? null };
  }

  private reportCursor(): void {
    const { line, column } = this.cursor();
    const selection = this.view.state.selection.main;
    this.host.onCursor(line, column, selection.empty ? "" : this.view.state.sliceDoc(selection.from, selection.to));
  }

  private watchVimMode(): void {
    const cm = settings.get("vim") ? getCM(this.view) : null;
    this.host.onVimMode(cm ? "normal" : null);
    cm?.on("vim-mode-change", (e: { mode: string; subMode?: string }) => this.host.onVimMode(e.subMode ? `${e.mode} ${e.subMode}` : e.mode));
  }

  /** Applies changed editor settings to every open file (other settings changes are ignored). */
  private reconfigure(): void {
    const signature = editorSignature();
    if (signature === this.signature) return;
    this.signature = signature;
    const effects = Object.entries(this.configurable()).map(([name, extension]) => compartments[name as Configurable].reconfigure(extension));
    for (const [path, state] of this.states) {
      if (path === this.current) this.view.dispatch({ effects });
      else this.states.set(path, state.update({ effects }).state);
    }
    this.watchVimMode();
  }
}

function toCodeMirror(doc: Text, d: Diagnostic): CmDiagnostic {
  const line = doc.line(Math.min(d.line, doc.lines));
  let from: number;
  let to: number;
  if (d.column) {
    from = Math.min(line.to, line.from + d.column - 1);
    to = d.length ? Math.min(line.to, from + d.length) : from + (/^[\p{L}\p{N}\\@]+/u.exec(line.text.slice(from - line.from))?.[0].length ?? 0);
  } else {
    from = line.from + (line.text.length - line.text.trimStart().length);
    to = line.to;
  }
  return { from, to: Math.max(to, from), severity: d.severity, message: d.detail ? `${d.message}\n${d.detail}` : d.message, source: d.source };
}
