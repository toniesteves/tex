// A project window: toolbar, sidebar, tab pills, banners, the editor | PDF split, the Issues panel and the status bar.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { runCommand } from "../commands";
import { Editor } from "../editor/editor";
import { t, tn } from "../i18n";
import * as ipc from "../ipc";
import type { Diagnostic } from "../latex/log";
import { countWords } from "../latex/scan";
import { closeReader, openReader, pdfControls, reloadReader } from "../pdf/reader";
import { PdfViewer } from "../pdf/viewer";
import { Project } from "../project";
import { settings } from "../settings";
import { basename, dirname, h, joinPath } from "../util";
import { alert, ask, menuBelow, prompt, toast } from "./dialogs";
import { fileIcon, icon } from "./icons";
import { IssuesPanel } from "./issues";
import { Sidebar, type FileActions, type SidebarMode } from "./sidebar";

const ENGINE_NAMES: Record<ipc.Engine, string> = { pdflatex: "pdfLaTeX", xelatex: "XeLaTeX", lualatex: "LuaLaTeX" };

export class Workspace {
  readonly el = h("div", { class: "workspace" });
  readonly project: Project;
  readonly editor: Editor;
  readonly viewer = new PdfViewer();
  private sidebar: Sidebar;
  private issues: IssuesPanel;
  private title = h("div", { class: "title" });
  private tools = h("div", { class: "tools" });
  private tabs = h("div", { class: "tabs" });
  private banners = h("div", { class: "banners" });
  private pdfPane = h("div", { class: "pdf-pane" });
  private split = h("div", { class: "split" });
  private status = h("footer", { class: "statusbar" });
  private controls = h("div", { class: "pdf-controls" });
  private placeholder = h("div", { class: "pdf-placeholder" });
  private cursor = { line: 1, column: 1, selection: "" };
  private vimMode: string | null = null;
  private pdfGeneration = 0;
  private pdfPath: string | null = null;
  /** Called with the new PDF after every compile that produced one (the presentation follows it). */
  onPdf: ((path: string) => void) | null = null;

  constructor(root: string) {
    this.project = new Project(root);
    const project = this.project;
    const editorPane = h("div", { class: "editor-pane" });
    this.editor = new Editor(editorPane, {
      completion: { index: () => project.index, files: () => project.files, mainDir: () => (project.mainFile ? dirname(project.mainFile) : null) },
      onChange: (path) => project.didChange(path),
      onCursor: (line, column, selection) => project.didMoveCursor(line, column, selection),
      onCtrlClick: (path, pos) => void project.ctrlClick(path, pos),
      onVimMode: (mode) => project.events.emit("vim", mode),
      vimCommand: (command) => runCommand({ write: "file.save", writeAll: "file.saveAll", quit: "file.closeTab", make: "build.compile" }[command]),
    });
    project.editor = this.editor;
    this.sidebar = new Sidebar(project, this.fileActions());
    this.issues = new IssuesPanel(project, (d) => this.jumpTo(d), () => this.toggleIssues(false));
    const divider = h("div", { class: "divider", title: t("Drag to resize") }, this.grip(t("Hide PDF"), "", () => this.togglePdf(false)));
    this.pdfPane.append(this.viewer.el, this.placeholder, this.controls);
    this.split.append(editorPane, divider, this.pdfPane, this.grip(t("Show PDF"), "edge right flip", () => this.togglePdf(true)));
    this.el.append(
      this.sidebar.el,
      h("div", { class: "main" }, h("header", { class: "toolbar" }, Object.assign(this.button("file.closeProject", "home", t("Close Project")), { className: "tool home" }), this.title, this.tools), this.tabs, this.banners, this.split, this.issues.el, this.status,
        this.grip(t("Show Sidebar"), "edge left", () => this.toggleSidebar())),
    );
    this.resizable(divider);
    this.resizableSidebar();
    this.viewer.syncTrigger = settings.get("pdfSync");
    this.viewer.onSyncClick = (click) => void project.showSource(click);
    this.viewer.onChange = () => this.renderControls();

    const state = settings.project(root);
    this.el.classList.toggle("no-sidebar", !!state.sidebarHidden);
    this.split.classList.toggle("no-pdf", !!state.pdfHidden);
    this.split.style.setProperty("--split", String(state.split ?? 0.55));
    if (state.sidebarWidth) this.el.style.setProperty("--sidebar-width", `${state.sidebarWidth}px`);

    project.events.on("tabs", () => (this.renderTabs(), this.renderTitle(), this.renderTools(), this.renderStatus()));
    project.events.on("dirty", () => (this.renderTabs(), this.renderStatus()));
    project.events.on("compile", () => (this.renderTools(), this.renderStatus(), this.renderPlaceholder()));
    project.events.on("diagnostics", () => this.renderStatus());
    project.events.on("index", () => (this.renderTools(), this.renderStatus()));
    project.events.on("banners", () => this.renderBanners());
    project.events.on("cursor", (c) => ((this.cursor = c), this.renderStatus()));
    project.events.on("vim", (mode) => ((this.vimMode = mode), this.renderStatus()));
    project.events.on("pdf", ({ path }) => void this.loadPdf(path));
    project.events.on("highlight", ({ boxes, word }) => {
      if (this.split.classList.contains("no-pdf")) this.togglePdf(true);
      void this.viewer.highlight(boxes, word);
    });
    settings.onChange(() => {
      this.viewer.syncTrigger = settings.get("pdfSync");
      this.renderTools();
      this.renderStatus();
    });
    this.renderAll();
  }

  async start(initialFile?: string): Promise<void> {
    await this.project.start(initialFile);
    this.renderAll();
  }

  dispose(): void {
    this.project.dispose();
    this.viewer.clear();
    void closeReader(this.project.root);
  }

  private renderAll(): void {
    this.renderTitle();
    this.renderTools();
    this.renderTabs();
    this.renderBanners();
    this.renderStatus();
    this.renderPlaceholder();
    this.renderControls();
  }

  private renderTitle(): void {
    const current = this.project.current;
    this.title.replaceChildren(h("strong", null, this.project.name), h("span", null, current ? this.project.relative(current) : ""));
    void getCurrentWindow().setTitle(current ? `${this.project.name} — ${basename(current)}` : this.project.name).catch(() => {});
  }

  private button(command: string, iconName: string, label: string, options: { active?: boolean; primary?: boolean; disabled?: boolean; spin?: boolean } = {}): HTMLButtonElement {
    return h("button", {
      class: `tool${options.primary ? " primary" : ""}${options.active ? " active" : ""}`,
      title: label,
      "aria-label": label,
      disabled: options.disabled ?? false,
      onclick: () => runCommand(command),
    }, icon(options.spin ? "spinner" : iconName, 16));
  }

  private renderTools(): void {
    const p = this.project;
    const running = p.state.status === "running";
    const compile = this.button("build.compile", "play", t("Compile"), { primary: true, spin: running });
    compile.classList.toggle("spinning", running);
    const engine = h("button", { class: "tool engine", title: t("Engine and main file"), onclick: (e: MouseEvent) => this.engineMenu(e.currentTarget as HTMLElement) },
      h("span", null, ENGINE_NAMES[p.engine]), icon("chevron", 12));
    this.tools.replaceChildren(
      h("div", { class: "tool-group" }, compile, this.button("build.stop", "stop", t("Stop"), { disabled: !running }), engine),
      h("div", { class: "tool-group" },
        this.button("build.live", "bolt", t("Live compile"), { active: settings.get("liveCompile") }),
        this.button("view.pdf", "pdf", t("PDF preview"), { active: !this.split.classList.contains("no-pdf") }),
        this.button("view.issues", "warning", t("Issues"), { active: this.issues.visible }),
        p.isBeamer ? this.button("present.start", "present", t("Start presentation")) : null,
        this.button("view.settings", "gear", t("Settings")),
      ),
    );
  }

  private engineMenu(anchor: HTMLElement): void {
    const p = this.project;
    const chosen = settings.project(p.root).engine;
    const texFiles = p.files.filter((f) => f.endsWith(".tex"));
    menuBelow(anchor, [
      ...(Object.keys(ENGINE_NAMES) as ipc.Engine[]).map((engine) => ({ label: ENGINE_NAMES[engine], checked: p.engine === engine, run: () => p.setEngine(engine) })),
      { label: t("Use the default engine"), checked: !chosen, run: () => p.setEngine(undefined) },
      "-" as const,
      ...texFiles.slice(0, 12).map((file) => ({ label: t("Main file: {name}", { name: p.relative(file) }), checked: file === p.mainFile, run: () => p.setMainFile(file) })),
      "-" as const,
      { label: t("Clean Auxiliary Files"), run: () => runCommand("build.clean") },
    ]);
  }

  private renderTabs(): void {
    const p = this.project;
    this.tabs.replaceChildren(
      ...p.tabs.map((path) => {
        const dirty = p.isDirty(path);
        const tab = h("div", {
          class: `tab${path === p.current ? " active" : ""}`,
          title: p.relative(path),
          onclick: () => void p.open(path),
          onauxclick: (e: MouseEvent) => e.button === 1 && void p.closeTab(path),
        },
          fileIcon(path),
          h("span", { class: "tab-name" }, basename(path)),
          path === p.mainFile ? h("span", { class: "main-star" }, icon("star", 11)) : null,
          h("button", {
            class: `tab-close${dirty ? " dirty" : ""}`,
            title: dirty ? t("Unsaved changes") : t("Close"),
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              void p.closeTab(path);
            },
          }, icon("close", 12)),
        );
        return tab;
      }),
    );
    this.tabs.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private renderBanners(): void {
    const p = this.project;
    const banners: HTMLElement[] = [];
    if (p.latexmkMissing) {
      const command = "sudo apt install latexmk";
      banners.push(h("div", { class: "banner warning" }, icon("warning"),
        h("span", null, t("latexmk was not found. Install it to compile:"), " ", h("code", null, command)),
        h("button", { onclick: () => void navigator.clipboard.writeText(command).then(() => toast(t("Copied"))) }, t("Copy command")),
        h("button", { onclick: () => void ipc.detectTex().then((tex) => ((p.tex = tex), this.renderBanners(), void p.compile("live"))) }, t("Check again"))));
    }
    for (const path of p.conflicts) {
      banners.push(h("div", { class: "banner" }, icon("info"),
        h("span", null, t("“{name}” changed on disk, and you have unsaved changes.", { name: basename(path) })),
        h("button", { onclick: () => void p.resolveConflict(path, "disk") }, t("Reload")),
        h("button", { onclick: () => void p.resolveConflict(path, "mine") }, t("Keep Mine"))));
    }
    this.banners.replaceChildren(...banners);
  }

  private renderStatus(): void {
    const p = this.project;
    const s = p.state;
    const all = p.diagnostics;
    const errors = all.filter((d) => d.severity === "error").length;
    const warnings = all.filter((d) => d.severity === "warning").length;
    const [stateIcon, stateText, stateClass] =
      s.status === "running" ? ["spinner", t("Compiling…"), "running"]
      : s.status === "ok" ? ["check", t("Compiled in {s} s", { s: Number((s.ms / 1000).toFixed(1)) }), "ok"]
      : s.status === "failed" ? ["error", tn(errors, "Failed: {n} error", "Failed: {n} errors"), "failed"]
      : s.status === "error" ? ["warning", s.message.split("\n")[0]!, "failed"]
      : s.status === "cancelled" ? ["stop", t("Stopped"), ""]
      : ["info", t("Not compiled yet"), ""];
    const words = p.index?.words ?? 0;
    const selected = this.cursor.selection ? countWords(this.cursor.selection) : null;
    const pages = this.viewer.pageCount;
    const wordText = selected !== null ? t("{n} of {total} words", { n: selected, total: words }) : tn(words, "{n} word", "{n} words");
    const capsule = (content: (Node | string | null)[], options: { title?: string; onclick?: () => void; class?: string } = {}) =>
      h(options.onclick ? "button" : "span", { class: `capsule ${options.class ?? ""}`, title: options.title, onclick: options.onclick }, ...content);
    const current = p.current;
    const encoding = current ? p.encodingOf(current) : undefined;
    const items = [
      capsule([icon(stateIcon, 13), stateText], { class: stateClass, onclick: () => (this.toggleIssues(true), s.status === "error" && this.issues.showLog()) }),
      capsule([icon("error", 13), String(errors), icon("warning", 13), String(warnings)], { title: t("Issues"), onclick: () => this.toggleIssues() }),
      h("span", { class: "spacer" }),
      capsule([ENGINE_NAMES[p.engine]], { title: t("Engine") }),
      p.tex?.distribution ? capsule([p.tex.distribution]) : null,
      encoding ? capsule([encoding === "latin-1" ? "Latin-1" : "UTF-8"]) : null,
      capsule([pages ? `${wordText} · ${tn(pages, "{n} page", "{n} pages")}` : wordText]),
      this.vimMode ? capsule([this.vimMode.toUpperCase()], { class: "vim" }) : null,
      current ? capsule([t("Ln {line}, Col {column}", { line: this.cursor.line, column: this.cursor.column })]) : null,
    ];
    this.status.replaceChildren(...items.filter((item): item is HTMLElement => item !== null));
  }

  private renderPlaceholder(): void {
    const p = this.project;
    const visible = !this.viewer.loaded;
    this.placeholder.hidden = !visible;
    if (!visible) return;
    const running = p.state.status === "running";
    this.placeholder.replaceChildren(icon(running ? "spinner" : "pdf", 36),
      h("p", null, running ? t("Compiling…") : p.mainFile ? t("The PDF appears here after the first compile.") : t("Open or create a .tex file with \\documentclass.")));
    this.placeholder.classList.toggle("spinning", running);
  }

  private renderControls(): void {
    const v = this.viewer;
    this.controls.hidden = !v.loaded;
    const pdf = this.pdfPath;
    this.controls.replaceChildren(
      ...pdfControls(v),
      h("button", { class: "detach", title: t("Open in a separate window"), onclick: () => pdf && void openReader(this.project.root, this.project.name, pdf) }, icon("detach", 14)),
    );
  }

  private async loadPdf(path: string): Promise<void> {
    const generation = ++this.pdfGeneration;
    const data = await ipc.readBytes(path).catch(() => null);
    if (!data || generation !== this.pdfGeneration) return;
    this.pdfPath = path;
    reloadReader(this.project.root, path);
    await this.viewer.load(data).catch((e) => console.error("PDF not shown", e));
    this.renderPlaceholder();
    this.renderStatus();
    this.onPdf?.(path);
  }

  private resizable(divider: HTMLElement): void {
    let box = this.split.getBoundingClientRect();
    this.drag(divider, () => (box = this.split.getBoundingClientRect()), (x) => {
      const ratio = Math.min(0.85, Math.max(0.15, (x - box.left) / box.width));
      this.split.style.setProperty("--split", String(ratio));
    }, () => settings.updateProject(this.project.root, { split: Number(this.split.style.getPropertyValue("--split")) }));
  }

  private resizableSidebar(): void {
    const handle = h("div", { class: "sidebar-handle", title: t("Drag to resize") }, this.grip(t("Hide Sidebar"), "flip", () => this.toggleSidebar()));
    this.sidebar.el.append(handle);
    let left = 0;
    let width = 0;
    this.drag(handle, () => (left = this.sidebar.el.getBoundingClientRect().left), (x) => {
      width = Math.round(Math.min(600, Math.max(160, x - left)));
      this.el.style.setProperty("--sidebar-width", `${width}px`);
    }, () => width && settings.updateProject(this.project.root, { sidebarWidth: width }));
  }

  /** Drags a divider; a press on its grip that does not move counts as a click on the grip. */
  private drag(handle: HTMLElement, start: () => void, move: (x: number) => void, done: () => void): void {
    // Mouse clicks on the grip are decided on pointerup below; the keyboard still clicks it (detail 0).
    handle.addEventListener("click", (e) => e.detail > 0 && e.stopPropagation(), true);
    handle.addEventListener("pointerdown", (e) => {
      handle.setPointerCapture(e.pointerId);
      const grip = (e.target as Element).closest<HTMLElement>(".grip");
      let dragging = false;
      start();
      const onMove = (ev: PointerEvent) => {
        dragging ||= Math.abs(ev.clientX - e.clientX) > 3;
        if (dragging) move(ev.clientX);
      };
      const up = () => {
        handle.removeEventListener("pointermove", onMove);
        if (dragging) done();
        else grip?.click();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", up, { once: true });
    });
  }

  /** A chevron pill that collapses a panel from its divider (click) or resizes it (drag), or ("edge") brings a hidden one back. */
  private grip(label: string, variant: string, run: () => void): HTMLButtonElement {
    return h("button", { class: `grip ${variant}`, title: label, "aria-label": label, onclick: run }, icon("chevron", 12));
  }

  // ── Panels ──────────────────────────────────────────────────────────────────────────────────────────────────────

  toggleSidebar(): void {
    const hidden = !this.el.classList.toggle("no-sidebar");
    settings.updateProject(this.project.root, { sidebarHidden: !hidden });
  }

  showSidebar(mode: SidebarMode): void {
    if (this.el.classList.contains("no-sidebar")) this.toggleSidebar();
    this.sidebar.show(mode);
  }

  togglePdf(show = this.split.classList.contains("no-pdf")): void {
    this.split.classList.toggle("no-pdf", !show);
    settings.updateProject(this.project.root, { pdfHidden: !show });
    this.renderTools();
  }

  toggleIssues(show?: boolean): void {
    this.issues.toggle(show);
    this.renderTools();
  }

  showLog(): void {
    this.toggleIssues(true);
    this.issues.showLog();
  }

  /** Next (or previous) issue after the cursor, across files in the panel's order. */
  nextIssue(direction: 1 | -1): void {
    const list = this.project.diagnostics.filter((d) => d.line > 0);
    if (!list.length) return;
    const here = { path: this.project.current ?? "", line: this.cursor.line };
    const index = list.findIndex((d) => (d.path === here.path ? d.line > here.line : d.path > here.path));
    const next = direction === 1 ? list[index < 0 ? 0 : index] : list[(index < 0 ? list.length : index) - 1] ?? list.at(-1);
    if (next) this.jumpTo(next);
  }

  private jumpTo(d: Diagnostic): void {
    if (d.line > 0) void this.project.open(d.path, { line: d.line, column: d.column, length: d.length });
    else void this.project.open(d.path);
  }

  // ── File actions (sidebar menu and commands) ────────────────────────────────────────────────────────────────────

  fileActions(): FileActions {
    const p = () => this.project;
    const failed = (title: string) => (e: unknown) => void alert(title, String(e));
    return {
      newFile: async (dir) => {
        const name = await prompt({ title: t("New File"), label: t("Name"), value: "untitled.tex", selectStem: true, ok: t("Create") });
        if (!name) return;
        const path = joinPath(dir, name);
        await ipc.createFile(path).then(async () => (await p().refreshTree(), await p().open(path)), failed(t("The file could not be created")));
      },
      newFolder: async (dir) => {
        const name = await prompt({ title: t("New Folder"), label: t("Name"), value: "", ok: t("Create") });
        if (name) await ipc.createDir(joinPath(dir, name)).then(() => p().refreshTree(), failed(t("The folder could not be created")));
      },
      rename: async (path) => {
        const name = await prompt({ title: t("Rename"), label: t("New name"), value: basename(path), selectStem: true, ok: t("Rename") });
        if (!name || name === basename(path)) return;
        const target = joinPath(dirname(path), name);
        await ipc.renamePath(path, target).then(() => p().moved(path, target), failed(t("The item could not be renamed")));
      },
      duplicate: async (path) => {
        await ipc.duplicatePath(path, t("copy")).then(() => p().refreshTree(), failed(t("The item could not be duplicated")));
      },
      trash: async (path) => {
        const answer = await ask({
          title: t("Move “{name}” to the trash?", { name: basename(path) }),
          buttons: [{ label: t("Cancel"), value: "cancel" }, { label: t("Move to Trash"), value: "trash", danger: true }],
        });
        if (answer !== "trash") return;
        await ipc.trashPath(path).then(() => p().refreshTree(), failed(t("The item could not be moved to the trash")));
      },
      reveal: (path) => void ipc.revealPath(path),
      setMain: (path) => p().setMainFile(path),
    };
  }
}
