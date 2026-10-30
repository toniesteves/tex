// One open project: its files, tabs and buffers, the root file and engine, live compilation, the index and the
// diagnostics, and source ↔ PDF navigation. The UI only renders it and listens to its events.
import { Editor } from "./editor/editor";
import { t } from "./i18n";
import * as ipc from "./ipc";
import { dedupe, parseBlg, parseLog, type Diagnostic } from "./latex/log";
import { buildIndex, includeCandidates, referenceDiagnostics, type ProjectIndex } from "./latex/project-index";
import { scan } from "./latex/scan";
import { findSourceWord } from "./latex/sync";
import type { SyncClick } from "./pdf/viewer";
import { settings } from "./settings";
import { alert, ask } from "./ui/dialogs";
import { basename, Debouncer, dirname, Emitter, extname, isUnder, joinPath, relativePath } from "./util";

export type CompileState =
  | { status: "idle" }
  | { status: "running"; purpose: Purpose }
  | { status: "ok" | "failed"; ms: number }
  | { status: "error"; message: string }
  | { status: "cancelled" };
type Purpose = "live" | "build";

type Events = {
  tree: void;
  tabs: void;
  dirty: string;
  index: void;
  diagnostics: void;
  compile: void;
  pdf: { path: string; updated: boolean };
  highlight: { boxes: ipc.SyncBox[]; word: string | null };
  banners: void;
  cursor: { line: number; column: number; selection: string };
  vim: string | null;
};

const TEXT = new Set([
  "tex", "sty", "cls", "bib", "bst", "bbx", "cbx", "dtx", "ins", "ltx", "def", "cfg", "clo", "fd", "txt", "md", "tikz", "pgf",
  "csv", "dat", "lua", "py", "json", "yaml", "yml", "xml", "log", "bbl", "latexmkrc", "",
]);
export const isTextFile = (path: string): boolean => TEXT.has(extname(path)) || basename(path) === "latexmkrc";
/** Files TeX inputs: their unsaved text goes into live compiles. */
const TEX_INPUT = new Set(["tex", "sty", "cls", "ltx", "def", "cfg"]);
const ENGINES: ipc.Engine[] = ["pdflatex", "xelatex", "lualatex"];

export class Project {
  readonly events = new Emitter<Events>();
  readonly name: string;
  /** Set by the window right after both exist (the editor's callbacks need the project). */
  editor!: Editor;
  tree: ipc.FileNode[] = [];
  files: string[] = [];
  tabs: string[] = [];
  index: ProjectIndex | null = null;
  state: CompileState = { status: "idle" };
  log = "";
  pdf: string | null = null;
  tex: ipc.TexInfo | null = null;
  /** Dirty buffers whose file changed on disk (the user chooses between both versions). */
  readonly conflicts = new Set<string>();
  private encodings = new Map<string, ipc.Encoding>();
  private disk = new Map<string, string>();
  private cache = new Map<string, string | null>();
  private compileDiagnostics: Diagnostic[] = [];
  private lintDiagnostics: Diagnostic[] = [];
  private detectedMain: string | undefined;
  private live = new Debouncer(() => void this.compile("live"));
  private reindex = new Debouncer(() => void this.rebuildIndex());
  private follow = new Debouncer(() => void this.showInPdf({ quiet: true }));
  private unlisten: (() => void) | null = null;

  constructor(readonly root: string) {
    this.name = basename(root);
  }

  /** Lists the files, finds the root file, reopens the last tabs and starts watching the folder. */
  async start(initialFile?: string): Promise<void> {
    void ipc.detectTex().then((tex) => {
      this.tex = tex;
      this.events.emit("banners", undefined);
      this.events.emit("compile", undefined);
    });
    await this.refreshTree();
    await this.detectMain();
    const saved = settings.project(this.root);
    for (const path of saved.tabs ?? []) if (this.files.includes(path)) await this.open(path, { background: true });
    const first = initialFile ?? (saved.current && this.files.includes(saved.current) ? saved.current : this.mainFile);
    if (first) await this.open(first);
    await ipc.watchProject(this.root);
    this.unlisten = await ipc.onFsChanged((root, paths) => root === this.root && void this.fsChanged(paths));
    void this.rebuildIndex();
    if (settings.get("liveCompile")) void this.compile("live");
  }

  dispose(): void {
    this.live.cancel();
    this.reindex.cancel();
    this.unlisten?.();
    void ipc.unwatchProject(this.root);
    void ipc.cancelCompile(this.root);
  }

  // ── Files and tabs ──────────────────────────────────────────────────────────────────────────────────────────────

  get current(): string | null {
    return this.editor.current;
  }

  relative(path: string): string {
    return isUnder(path, this.root) ? relativePath(this.root, path) : path;
  }

  async refreshTree(): Promise<void> {
    this.tree = await ipc.listTree(this.root);
    const files: string[] = [];
    const walk = (nodes: ipc.FileNode[]) => nodes.forEach((n) => (n.isDir ? walk(n.children ?? []) : files.push(n.path)));
    walk(this.tree);
    this.files = files;
    this.events.emit("tree", undefined);
  }

  isDirty(path: string): boolean {
    return this.editor.isDirty(path);
  }

  get dirtyFiles(): string[] {
    return this.tabs.filter((p) => this.editor.isDirty(p));
  }

  encodingOf(path: string): ipc.Encoding | undefined {
    return this.encodings.get(path);
  }

  /** Opens a text file in a tab (others go to the default application) and optionally reveals a position. */
  async open(path: string, options: { line?: number; column?: number; length?: number; background?: boolean } = {}): Promise<boolean> {
    if (!isTextFile(path)) {
      await ipc.openExternal(path);
      return false;
    }
    if (!this.editor.has(path)) {
      let file: ipc.TextFile;
      try {
        file = await ipc.readText(path);
      } catch (e) {
        await alert(t("“{name}” could not be opened", { name: basename(path) }), String(e));
        return false;
      }
      this.editor.open(path, file.text);
      this.disk.set(path, file.text);
      this.encodings.set(path, file.encoding);
      const at = this.current ? this.tabs.indexOf(this.current) + 1 : this.tabs.length;
      this.tabs.splice(at, 0, path);
      this.pushDiagnostics();
    }
    if (!options.background) {
      this.editor.show(path);
      if (options.line) this.editor.reveal(options.line, options.column, options.length);
      else this.editor.focus();
    }
    this.saveTabs();
    this.events.emit("tabs", undefined);
    return true;
  }

  async closeTab(path: string): Promise<boolean> {
    if (this.editor.isDirty(path)) {
      const answer = await ask({
        title: t("Save the changes to “{name}”?", { name: basename(path) }),
        message: t("Your changes will be lost if you don't save them."),
        buttons: [
          { label: t("Don't Save"), value: "discard", danger: true },
          { label: t("Cancel"), value: "cancel" },
          { label: t("Save"), value: "save", primary: true },
        ],
      });
      if (answer === "cancel" || (answer === "save" && !(await this.save(path)))) return false;
    }
    const i = this.tabs.indexOf(path);
    this.tabs.splice(i, 1);
    const wasCurrent = this.current === path;
    this.editor.close(path);
    this.disk.delete(path);
    this.conflicts.delete(path);
    const next = this.tabs[Math.min(i, this.tabs.length - 1)];
    if (wasCurrent && next) this.editor.show(next);
    this.saveTabs();
    this.events.emit("tabs", undefined);
    this.events.emit("banners", undefined);
    return true;
  }

  select(index: number): void {
    const path = this.tabs[index];
    if (path) void this.open(path);
  }

  cycle(delta: number): void {
    if (!this.tabs.length) return;
    const i = this.current ? this.tabs.indexOf(this.current) : -1;
    this.select((i + delta + this.tabs.length) % this.tabs.length);
  }

  private saveTabs(): void {
    settings.updateProject(this.root, { tabs: this.tabs, current: this.current ?? undefined });
  }

  async save(path: string): Promise<boolean> {
    const text = this.editor.text(path);
    if (text === undefined) return true;
    try {
      await ipc.writeText(path, text, this.encodings.get(path) ?? "utf-8");
    } catch (e) {
      await alert(t("“{name}” could not be saved", { name: basename(path) }), String(e));
      return false;
    }
    this.disk.set(path, text);
    this.cache.delete(path);
    this.editor.markSaved(path);
    this.conflicts.delete(path);
    this.events.emit("dirty", path);
    this.events.emit("banners", undefined);
    return true;
  }

  /** Saves the current file (and compiles, when that is on). */
  async saveCurrent(): Promise<void> {
    if (this.current && (await this.save(this.current)) && settings.get("compileOnSave")) void this.compile("build");
  }

  async saveAll(): Promise<boolean> {
    for (const path of this.dirtyFiles) if (!(await this.save(path))) return false;
    return true;
  }

  /** Keeps the disk version of a conflicting file (or keeps the buffer, which will overwrite it on save). */
  async resolveConflict(path: string, keep: "disk" | "mine"): Promise<void> {
    if (keep === "disk") {
      const file = await ipc.readText(path);
      this.disk.set(path, file.text);
      this.editor.reload(path, file.text);
    }
    this.conflicts.delete(path);
    this.events.emit("banners", undefined);
  }

  private async fsChanged(paths: string[]): Promise<void> {
    await this.refreshTree();
    let sources = false;
    for (const path of paths) {
      this.cache.delete(path);
      if (/\.(tex|bib|sty|cls)$/.test(path)) sources = true;
      if (!this.editor.has(path)) continue;
      if (!this.files.includes(path)) {
        if (!this.editor.isDirty(path)) await this.closeTab(path);
        continue;
      }
      const file = await ipc.readText(path).catch(() => null);
      if (!file || file.text === this.disk.get(path)) continue; // unchanged, or our own save
      if (this.editor.isDirty(path)) {
        this.conflicts.add(path);
        this.events.emit("banners", undefined);
      } else {
        this.disk.set(path, file.text);
        this.editor.reload(path, file.text);
      }
    }
    if (sources) this.reindex.schedule(300);
  }

  /** Keeps tabs, buffers and the main file when a file or folder is renamed or moved. */
  async moved(from: string, to: string): Promise<void> {
    for (const path of [...this.tabs]) {
      if (!isUnder(path, from)) continue;
      const target = to + path.slice(from.length);
      this.editor.rename(path, target);
      this.tabs[this.tabs.indexOf(path)] = target;
      for (const map of [this.disk, this.encodings] as Map<string, unknown>[]) {
        if (map.has(path)) {
          map.set(target, map.get(path));
          map.delete(path);
        }
      }
    }
    const main = settings.project(this.root).main;
    if (main && isUnder(main, from)) settings.updateProject(this.root, { main: to + main.slice(from.length) });
    await this.refreshTree();
    await this.detectMain();
    this.saveTabs();
    this.events.emit("tabs", undefined);
  }

  // ── Root file and engine ────────────────────────────────────────────────────────────────────────────────────────

  /** The file to compile: a `% !TEX root` in the current file, else the chosen main file, else the detected one. */
  get mainFile(): string | undefined {
    const current = this.current;
    const magic = current && extname(current) === "tex" ? /^\s*%\s*!\s*TeX\s+root\s*=\s*(.+?)\s*$/im.exec(this.editor.text(current)?.split("\n", 20).join("\n") ?? "") : null;
    const fromMagic = magic && current ? joinPath(dirname(current), magic[1]!) : undefined;
    if (fromMagic && this.files.includes(fromMagic)) return fromMagic;
    const chosen = settings.project(this.root).main;
    return chosen && this.files.includes(chosen) ? chosen : this.detectedMain;
  }

  setMainFile(path: string | undefined): void {
    settings.updateProject(this.root, { main: path });
    this.afterMainChange();
  }

  private afterMainChange(): void {
    this.events.emit("tabs", undefined);
    void this.rebuildIndex();
    if (settings.get("liveCompile")) this.live.schedule(50);
  }

  /** `main.tex` when it has a `\documentclass`, else the shallowest file that has one. */
  private async detectMain(): Promise<void> {
    const candidates = this.files
      .filter((p) => extname(p) === "tex")
      .sort((a, b) => a.split("/").length - b.split("/").length || Number(basename(b) === "main.tex") - Number(basename(a) === "main.tex"));
    for (const path of candidates.slice(0, 200)) {
      const text = await this.read(path);
      if (text !== null && scan(text).documentClass) {
        this.detectedMain = path;
        return;
      }
    }
    this.detectedMain = undefined;
  }

  /** `% !TEX program` of the root file, else the project's choice, else the default. */
  get engine(): ipc.Engine {
    const magic = this.index?.program?.replace("latex", "") ?? "";
    const fromMagic = ENGINES.find((e) => magic && e.startsWith(magic));
    return fromMagic ?? settings.project(this.root).engine ?? settings.get("engine");
  }

  setEngine(engine: ipc.Engine | undefined): void {
    settings.updateProject(this.root, { engine });
    this.events.emit("compile", undefined);
    if (settings.get("liveCompile")) this.live.schedule(50);
  }

  get isBeamer(): boolean {
    return this.index?.documentClass === "beamer";
  }

  // ── Editing events (from the editor) ────────────────────────────────────────────────────────────────────────────

  didChange(path: string): void {
    this.events.emit("dirty", path);
    if (extname(path) === "tex" || extname(path) === "bib") this.reindex.schedule(300);
    if (settings.get("liveCompile") && TEX_INPUT.has(extname(path))) this.live.schedule(settings.get("liveDelay"));
  }

  didMoveCursor(line: number, column: number, selection: string): void {
    this.events.emit("cursor", { line, column, selection });
    if (settings.get("followCursor") && !selection && this.pdf) this.follow.schedule(600);
  }

  // ── Compilation ─────────────────────────────────────────────────────────────────────────────────────────────────

  get latexmkMissing(): boolean {
    return this.tex !== null && !this.tex.tools.latexmk;
  }

  async compile(purpose: Purpose): Promise<void> {
    const main = this.mainFile;
    if (!main || this.latexmkMissing) {
      this.state = { status: "error", message: main ? t("latexmk was not found") : t("No main file") };
      this.events.emit("compile", undefined);
      return;
    }
    if (purpose === "build" && !(await this.saveAll())) return;
    this.live.cancel();
    this.state = { status: "running", purpose };
    this.events.emit("compile", undefined);
    const overlays = this.dirtyFiles
      .filter((p) => TEX_INPUT.has(extname(p)))
      .map((path) => ({ path, text: this.editor.text(path)!, encoding: this.encodings.get(path) ?? "utf-8" }));
    let result: ipc.CompileResult;
    try {
      result = await ipc.compile({ root: this.root, main, engine: this.engine, overlays, export: purpose === "build" });
    } catch (e) {
      this.state = { status: "error", message: String(e) };
      this.events.emit("compile", undefined);
      return;
    }
    if (result.status === "cancelled") return; // a newer compile runs, or the user stopped this one
    const context = { cwd: result.cwd, main, overlays: result.overlays };
    this.compileDiagnostics = [...parseLog(result.log, context), ...(result.bibtexLog ? parseBlg(result.bibtexLog, context) : [])];
    this.log = result.log || result.message || "";
    const failed = result.status !== "ok" || this.compileDiagnostics.some((d) => d.severity === "error");
    this.state = result.status === "error" ? { status: "error", message: result.message ?? "" } : { status: failed ? "failed" : "ok", ms: result.durationMs };
    if (result.pdf && (result.pdfUpdated || this.pdf !== result.pdf)) {
      this.pdf = result.pdf;
      this.events.emit("pdf", { path: result.pdf, updated: result.pdfUpdated });
    }
    this.pushDiagnostics();
    this.events.emit("compile", undefined);
  }

  stop(): void {
    this.live.cancel();
    void ipc.cancelCompile(this.root);
    if (this.state.status === "running") this.state = { status: "cancelled" };
    this.events.emit("compile", undefined);
  }

  async cleanAuxiliaryFiles(): Promise<void> {
    await ipc.cleanCache(this.root);
    this.state = { status: "idle" };
    void this.compile("live");
  }

  // ── Index and diagnostics ───────────────────────────────────────────────────────────────────────────────────────

  /** A file's text for the index: the buffer when it is open, else the disk (cached until it changes). */
  private async read(path: string): Promise<string | null> {
    const open = this.editor?.text(path);
    if (open !== undefined) return open;
    if (!this.cache.has(path)) this.cache.set(path, await ipc.readText(path).then((f) => f.text, () => null));
    return this.cache.get(path)!;
  }

  private async rebuildIndex(): Promise<void> {
    const main = this.mainFile;
    this.index = main ? await buildIndex(main, (p) => this.read(p)) : null;
    this.lintDiagnostics = this.index ? referenceDiagnostics(this.index) : [];
    this.pushDiagnostics();
    this.events.emit("index", undefined);
  }

  /** Compile, BibTeX and reference diagnostics. LaTeX's own undefined-reference warnings are dropped when the live
   * check already reports the key, and so are its summary warnings. */
  get diagnostics(): Diagnostic[] {
    const reported = new Set(this.lintDiagnostics.map((d) => /‘(.+)’/.exec(d.message)?.[1]));
    const compile = this.compileDiagnostics.filter((d) => {
      if (/^There were undefined (references|citations)/.test(d.message)) return false;
      const key = /^(?:Reference|Citation) `([^']+)' on page/.exec(d.message)?.[1];
      return !key || !reported.has(key);
    });
    return dedupe([...compile, ...this.lintDiagnostics]);
  }

  private pushDiagnostics(): void {
    const all = this.diagnostics;
    for (const path of this.tabs) this.editor.setDiagnostics(path, all.filter((d) => d.path === path));
    this.events.emit("diagnostics", undefined);
  }

  // ── Navigation ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** Source → PDF at the cursor (or a given position); `quiet` skips the message when nothing is found. */
  async showInPdf(at?: { path: string; line: number; column: number; word: string | null; quiet?: boolean } | { quiet: boolean }): Promise<void> {
    const position = at && "path" in at ? at : this.current ? { path: this.current, ...this.editor.cursor() } : null;
    if (!position || !this.pdf) return;
    const boxes = await ipc.synctexForward(this.root, this.pdf, position.path, position.line, position.column).catch(() => []);
    if (boxes.length) this.events.emit("highlight", { boxes, word: position.word });
  }

  /** PDF → source: SyncTeX gives the line, the clicked word gives the exact place. */
  async showSource(click: SyncClick): Promise<void> {
    if (!this.pdf) return;
    const location = await ipc.synctexInverse(this.root, this.pdf, click.page, click.x, click.y).catch(() => null);
    if (!location || !isUnder(location.path, this.root) || !isTextFile(location.path)) return;
    if (!(await this.open(location.path))) return;
    const text = this.editor.text(location.path) ?? "";
    const hit = findSourceWord(text, location.line, click.word, click.before, click.after, location.column);
    if (hit) this.editor.revealRange(hit.from, hit.to);
    else this.editor.reveal(location.line);
  }

  /** Ctrl+click: an included file opens, a reference goes to its label, a citation to its entry; else Show in PDF. */
  async ctrlClick(path: string, pos: number): Promise<void> {
    const text = this.editor.text(path) ?? "";
    const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
    const line = text.slice(lineStart, text.indexOf("\n", pos) < 0 ? undefined : text.indexOf("\n", pos));
    for (const m of line.matchAll(/\\([a-zA-Z]+)\*?\s*(?:\[[^\]]*\])*(?:\{[^{}]*\})?\{([^{}]*)\}/g)) {
      const argStart = lineStart + m.index! + m[0].length - 1 - m[2]!.length;
      if (pos < argStart || pos > argStart + m[2]!.length) continue;
      let offset = argStart;
      const item = m[2]!.split(",").find((part) => (offset += part.length + 1) > pos)?.trim() ?? m[2]!.trim();
      if (await this.followArgument(m[1]!, item, path)) return;
    }
    const lineNumber = text.slice(0, pos).split("\n").length;
    const word = /[\p{L}\p{N}]*$/u.exec(text.slice(lineStart, pos))![0] + /^[\p{L}\p{N}]*/u.exec(text.slice(pos))![0];
    await this.showInPdf({ path, line: lineNumber, column: pos - lineStart + 1, word: word || null });
  }

  private async followArgument(command: string, arg: string, from: string): Promise<boolean> {
    const main = this.mainFile;
    if (/ref$|^[cC]ref|^labelcref/.test(command)) {
      const label = this.index?.labels.find((l) => l.key === arg);
      if (label) await this.open(label.path, { line: label.line, column: label.column, length: arg.length });
      return !!label;
    }
    if (command.toLowerCase().includes("cite")) {
      for (const bib of this.index?.bibFiles ?? []) {
        const at = (await this.read(bib))?.split("\n").findIndex((l) => new RegExp(`@\\w+\\s*[{(]\\s*${arg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*,`).test(l));
        if (at !== undefined && at >= 0) return this.open(bib, { line: at + 1 });
      }
      return false;
    }
    const kinds: Record<string, Parameters<typeof includeCandidates>[0]["kind"]> = {
      input: "input", include: "include", subfile: "subfile", bibliography: "bibliography", addbibresource: "addbibresource",
    };
    const kind = kinds[command];
    const base = main ? dirname(main) : dirname(from);
    const candidates = kind
      ? includeCandidates({ kind, arg, offset: 0, line: 0 }, base, dirname(from))
      : command === "includegraphics"
        ? ["", ".pdf", ".png", ".jpg", ".jpeg", ".eps"].map((ext) => joinPath(base, arg + ext))
        : command === "usepackage"
          ? [joinPath(base, `${arg}.sty`)]
          : [];
    const target = candidates.find((c) => this.files.includes(c));
    if (target) await this.open(target);
    return !!target;
  }
}
