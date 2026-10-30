// The application shell: the Welcome screen or one project per window, every command, global shortcuts, opening
// folders and files (dialogs, drag and drop, the command line) and closing with unsaved changes.
import { startCompletion } from "@codemirror/autocomplete";
import { indentLess, indentMore, toggleComment } from "@codemirror/commands";
import { gotoLine, openSearchPanel } from "@codemirror/search";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { commandForCombo, comboFromEvent, defineCommands, isShortcut, runCommand, type Command } from "./commands";
import { t } from "./i18n";
import * as ipc from "./ipc";
import { isPresenting, reloadPresentation, startPresentation, stopPresentation } from "./present/controller";
import { settings } from "./settings";
import { alert, ask, isModalOpen, toast } from "./ui/dialogs";
import { newProject } from "./ui/new-project";
import { commandPalette, quickOpen } from "./ui/palette";
import { onLanguageChange, openSettings, recording } from "./ui/settings-view";
import { welcome } from "./ui/welcome";
import { Workspace } from "./ui/workspace";
import { basename, dirname, hashString, isUnder } from "./util";

/** In Vim mode these stay with Vim while the editor has the focus. */
const VIM_KEYS = new Set(["Ctrl+B", "Ctrl+D", "Ctrl+E", "Ctrl+F", "Ctrl+H", "Ctrl+R", "Ctrl+U", "Ctrl+V", "Ctrl+W", "Ctrl+Y"]);

export class App {
  private workspace: Workspace | null = null;
  private welcomeScreen: { el: HTMLElement; destroy(): void } | null = null;
  private home: string | null = null;

  constructor(private readonly root: HTMLElement) {
    this.defineCommands();
    document.addEventListener("keydown", (e) => this.onKey(e), true);
    document.addEventListener("contextmenu", (e) => {
      if (!(e.target as HTMLElement).closest("input, textarea, .cm-content, .log-view, .textLayer")) e.preventDefault();
    });
    onLanguageChange(() => (this.workspace?.project.dirtyFiles.length ? toast(t("Save your files, then reopen the window to change the language.")) : location.reload()));
  }

  async start(): Promise<void> {
    this.home = await homeDir().catch(() => null);
    void getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "drop" && e.payload.paths[0]) void this.openPath(e.payload.paths[0]);
    });
    void getCurrentWindow().onCloseRequested(async (e) => {
      if (!(await this.confirmClose())) return e.preventDefault();
      stopPresentation();
      this.workspace?.dispose();
    });
    const params = new URLSearchParams(location.search);
    const project = params.get("project");
    if (project) return this.openProject(project, params.get("file") ?? undefined);
    const launch = getCurrentWindow().label === "main" ? await invoke<string[]>("launch_paths").catch(() => []) : [];
    if (launch[0]) return this.openPath(launch[0]);
    this.showWelcome();
  }

  private get project() {
    return this.workspace?.project ?? null;
  }

  private showWelcome(): void {
    this.welcomeScreen?.destroy();
    this.welcomeScreen = welcome({
      newProject: () => runCommand("file.newProject"),
      openFolder: () => runCommand("file.openFolder"),
      openFile: () => runCommand("file.openFile"),
      openRecent: (path) => void this.openProject(path),
    }, this.home);
    this.root.replaceChildren(this.welcomeScreen.el);
    void getCurrentWindow().setTitle("Tex");
  }

  /** A folder opens as a project; a file opens its folder with the file selected. */
  async openPath(path: string): Promise<void> {
    const isDir = await ipc.listTree(path).then(() => true, () => false);
    if (isDir) return this.openProject(path);
    const project = this.project;
    if (project && isUnder(path, project.root)) return void project.open(path);
    return this.openProject(dirname(path), path);
  }

  /** In this window when it shows the Welcome screen, else in a window of its own (reused if already open). */
  async openProject(root: string, file?: string): Promise<void> {
    if (this.workspace && this.workspace.project.root !== root) {
      const label = `project-${hashString(root)}`;
      const existing = await WebviewWindow.getByLabel(label);
      if (existing) return void existing.setFocus();
      const query = `?project=${encodeURIComponent(root)}${file ? `&file=${encodeURIComponent(file)}` : ""}`;
      new WebviewWindow(label, { url: `/${query}`, title: basename(root), width: 1280, height: 820, minWidth: 720, minHeight: 480 });
      return;
    }
    if (this.workspace) {
      if (file) void this.workspace.project.open(file);
      return;
    }
    const exists = await ipc.listTree(root).then(() => true, () => false);
    if (!exists) {
      settings.removeRecent(root);
      await alert(t("“{name}” was not found", { name: basename(root) }), root);
      return this.showWelcome();
    }
    this.welcomeScreen?.destroy();
    this.welcomeScreen = null;
    const workspace = new Workspace(root);
    this.workspace = workspace;
    workspace.onPdf = (pdf) => reloadPresentation(pdf);
    this.root.replaceChildren(workspace.el);
    history.replaceState(null, "", `?project=${encodeURIComponent(root)}`);
    settings.addRecent(root, basename(root));
    await workspace.start(file);
  }

  private async closeProject(): Promise<void> {
    if (!this.workspace || !(await this.confirmClose())) return;
    stopPresentation();
    this.workspace.dispose();
    this.workspace = null;
    history.replaceState(null, "", "/");
    this.showWelcome();
  }

  /** Asks about unsaved files; false when the user cancels. */
  private async confirmClose(): Promise<boolean> {
    const dirty = this.project?.dirtyFiles ?? [];
    if (!dirty.length) return true;
    const answer = await ask({
      title: dirty.length === 1
        ? t("Save the changes to “{name}”?", { name: basename(dirty[0]!) })
        : t("Save the changes to {n} files?", { n: dirty.length }),
      message: t("Your changes will be lost if you don't save them."),
      buttons: [
        { label: t("Don't Save"), value: "discard", danger: true },
        { label: t("Cancel"), value: "cancel" },
        { label: t("Save All"), value: "save", primary: true },
      ],
    });
    return answer === "discard" || (answer === "save" && (await this.project!.saveAll()));
  }

  private onKey(e: KeyboardEvent): void {
    if (recording || isModalOpen()) return;
    const combo = comboFromEvent(e);
    if (!combo || !isShortcut(combo)) return;
    if (settings.get("vim") && VIM_KEYS.has(combo) && (e.target as HTMLElement | null)?.closest?.(".cm-editor")) return;
    const command = commandForCombo(combo);
    if (!command) return;
    e.preventDefault();
    e.stopPropagation();
    runCommand(command.id);
  }

  private defineCommands(): void {
    const ws = () => this.workspace!;
    const p = () => this.workspace!.project;
    const hasProject = () => this.workspace !== null;
    const hasFile = () => !!this.workspace?.project.current;
    const hasPdf = () => !!this.workspace?.project.pdf;
    const edit = (command: Parameters<Workspace["editor"]["run"]>[0]) => () => ws().editor.run(command);
    const file = (c: Omit<Command, "category">): Command => ({ category: "File", ...c });
    const editing = (c: Omit<Command, "category" | "enabled">): Command => ({ category: "Edit", enabled: hasFile, ...c });
    const view = (c: Omit<Command, "category">): Command => ({ category: "View", ...c });
    const build = (c: Omit<Command, "category">): Command => ({ category: "Build", enabled: hasProject, ...c });
    defineCommands([
      file({
        id: "file.newProject", title: "New Project…", keys: "Ctrl+Shift+N",
        run: async () => {
          const recent = settings.get("recents")[0];
          const folder = await newProject(recent ? dirname(recent.path) : this.home ?? "/", this.home);
          if (folder) await this.openProject(folder);
        },
      }),
      file({
        id: "file.openFolder", title: "Open Folder…", keys: "Ctrl+O",
        run: async () => {
          const folder = await open({ directory: true, title: t("Open Folder"), defaultPath: this.project?.root ?? this.home ?? undefined });
          if (typeof folder === "string") await this.openProject(folder);
        },
      }),
      file({
        id: "file.openFile", title: "Open File…",
        run: async () => {
          const path = await open({ title: t("Open File"), defaultPath: this.project?.root ?? this.home ?? undefined, filters: [{ name: "LaTeX", extensions: ["tex", "bib", "sty", "cls", "ltx"] }] });
          if (typeof path === "string") await this.openPath(path);
        },
      }),
      file({ id: "file.newFile", title: "New File…", keys: "Ctrl+N", enabled: hasProject, run: () => ws().fileActions().newFile(p().current ? dirname(p().current!) : p().root) }),
      file({ id: "file.newFolder", title: "New Folder…", enabled: hasProject, run: () => ws().fileActions().newFolder(p().current ? dirname(p().current!) : p().root) }),
      file({ id: "file.save", title: "Save", keys: "Ctrl+S", enabled: hasFile, run: () => p().saveCurrent() }),
      file({ id: "file.saveAll", title: "Save All", keys: "Ctrl+Alt+S", enabled: hasProject, run: () => p().saveAll() }),
      file({ id: "file.rename", title: "Rename File…", enabled: hasFile, run: () => ws().fileActions().rename(p().current!) }),
      file({ id: "file.closeTab", title: "Close Tab", keys: "Ctrl+W", enabled: hasFile, run: () => p().closeTab(p().current!) }),
      file({ id: "file.closeProject", title: "Close Project", enabled: hasProject, run: () => this.closeProject() }),
      file({ id: "file.quickOpen", title: "Quick Open…", keys: "Ctrl+P", enabled: hasProject, run: () => quickOpen(p()) }),
      file({ id: "file.reveal", title: "Show in File Manager", enabled: hasProject, run: () => ipc.revealPath(p().current ?? p().root) }),

      editing({ id: "edit.find", title: "Find", keys: "Ctrl+F", run: edit(openSearchPanel) }),
      editing({
        id: "edit.replace", title: "Replace", keys: "Ctrl+H",
        run: () => {
          ws().editor.run(openSearchPanel);
          ws().editor.view.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]")?.focus();
        },
      }),
      editing({ id: "edit.goToLine", title: "Go to Line…", keys: "Ctrl+G", run: edit(gotoLine) }),
      editing({ id: "edit.toggleComment", title: "Toggle Comment", keys: "Ctrl+/", run: edit(toggleComment) }),
      editing({ id: "edit.indent", title: "Indent", keys: "Ctrl+]", run: edit(indentMore) }),
      editing({ id: "edit.outdent", title: "Outdent", keys: "Ctrl+[", run: edit(indentLess) }),
      editing({ id: "edit.complete", title: "Show Completions", keys: "Ctrl+Space", run: edit(startCompletion) }),

      view({ id: "view.palette", title: "Command Palette…", keys: "Ctrl+Shift+P", run: () => commandPalette() }),
      view({ id: "view.settings", title: "Settings…", keys: "Ctrl+,", run: () => openSettings() }),
      view({ id: "view.shortcuts", title: "Keyboard Shortcuts…", run: () => openSettings("shortcuts") }),
      view({ id: "view.sidebar", title: "Toggle Sidebar", keys: "Ctrl+Alt+B", enabled: hasProject, run: () => ws().toggleSidebar() }),
      view({ id: "view.files", title: "Show Files", enabled: hasProject, run: () => ws().showSidebar("files") }),
      view({ id: "view.outline", title: "Show Outline", enabled: hasProject, run: () => ws().showSidebar("outline") }),
      view({ id: "view.pdf", title: "Toggle PDF Preview", keys: "Ctrl+Alt+P", enabled: hasProject, run: () => ws().togglePdf() }),
      view({ id: "view.issues", title: "Toggle Issues", keys: "Ctrl+Shift+M", enabled: hasProject, run: () => ws().toggleIssues() }),
      view({ id: "view.log", title: "Show Log", enabled: hasProject, run: () => ws().showLog() }),
      view({ id: "view.zoomIn", title: "Zoom In on the PDF", keys: "Ctrl+=", enabled: hasPdf, run: () => ws().viewer.zoomIn() }),
      view({ id: "view.zoomOut", title: "Zoom Out on the PDF", keys: "Ctrl+-", enabled: hasPdf, run: () => ws().viewer.zoomOut() }),
      view({ id: "view.zoomFit", title: "Fit the PDF to the Width", keys: "Ctrl+0", enabled: hasPdf, run: () => ws().viewer.fitWidth() }),

      build({ id: "build.compile", title: "Compile", keys: "Ctrl+B", run: () => p().compile("build") }),
      build({ id: "build.stop", title: "Stop Compiling", keys: "Ctrl+.", enabled: () => this.project?.state.status === "running", run: () => p().stop() }),
      build({ id: "build.live", title: "Toggle Live Compile", run: () => settings.set("liveCompile", !settings.get("liveCompile")) }),
      build({ id: "build.pdflatex", title: "Use pdfLaTeX", run: () => p().setEngine("pdflatex") }),
      build({ id: "build.xelatex", title: "Use XeLaTeX", run: () => p().setEngine("xelatex") }),
      build({ id: "build.lualatex", title: "Use LuaLaTeX", run: () => p().setEngine("lualatex") }),
      build({ id: "build.setMain", title: "Set Current File as Main File", enabled: () => !!this.project?.current?.endsWith(".tex"), run: () => p().setMainFile(p().current!) }),
      build({ id: "build.clean", title: "Clean Auxiliary Files", run: () => p().cleanAuxiliaryFiles() }),
      build({ id: "build.showInPdf", title: "Show in PDF", keys: "Ctrl+Shift+J", enabled: () => hasFile() && hasPdf(), run: () => p().showInPdf() }),
      build({ id: "build.openPdf", title: "Open PDF in Another App", enabled: hasPdf, run: () => ipc.openExternal(p().pdf!) }),
      build({ id: "build.nextIssue", title: "Next Issue", keys: "F8", run: () => ws().nextIssue(1) }),
      build({ id: "build.previousIssue", title: "Previous Issue", keys: "Shift+F8", run: () => ws().nextIssue(-1) }),

      {
        id: "present.start", title: "Start Presentation", category: "Presentation", keys: "F5", enabled: () => hasPdf() && !isPresenting(),
        run: () => startPresentation(p().pdf!, p().name).catch((e) => alert(t("The presentation could not start"), String(e))),
      },
      { id: "present.stop", title: "End Presentation", category: "Presentation", enabled: isPresenting, run: stopPresentation },

      { id: "tabs.next", title: "Next Tab", category: "Tabs", keys: "Ctrl+Tab", hidden: true, enabled: hasProject, run: () => p().cycle(1) },
      { id: "tabs.previous", title: "Previous Tab", category: "Tabs", keys: "Ctrl+Shift+Tab", hidden: true, enabled: hasProject, run: () => p().cycle(-1) },
      { id: "tabs.nextPage", title: "Next Tab", category: "Tabs", keys: "Ctrl+PageDown", hidden: true, enabled: hasProject, run: () => p().cycle(1) },
      { id: "tabs.previousPage", title: "Previous Tab", category: "Tabs", keys: "Ctrl+PageUp", hidden: true, enabled: hasProject, run: () => p().cycle(-1) },
      ...Array.from({ length: 9 }, (_, i): Command => ({
        id: `tabs.${i + 1}`, title: `Tab ${i + 1}`, category: "Tabs", keys: `Ctrl+${i + 1}`, hidden: true, enabled: hasProject, run: () => p().select(i),
      })),
    ]);
  }
}
