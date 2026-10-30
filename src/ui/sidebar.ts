// The sidebar: the file tree (folders first, ★ on the main file, a dot on unsaved files) and the outline across the
// included files (sections, frames and labels), with the file context menu.
import { t } from "../i18n";
import type { FileNode } from "../ipc";
import type { OutlineNode } from "../latex/project-index";
import type { Project } from "../project";
import { dirname, h, isUnder } from "../util";
import { menu, type MenuItem } from "./dialogs";
import { fileIcon, icon } from "./icons";

export interface FileActions {
  newFile(dir: string): void;
  newFolder(dir: string): void;
  rename(path: string): void;
  duplicate(path: string): void;
  trash(path: string): void;
  reveal(path: string): void;
  setMain(path: string | undefined): void;
}

export class Sidebar {
  readonly el = h("aside", { class: "sidebar" });
  private body = h("div", { class: "sidebar-body" });
  private mode: "files" | "outline" = "files";
  private expanded = new Set<string>();
  private revealed = new Set<string>();
  private pressed: string | null = null;
  private segments: HTMLButtonElement[];

  constructor(private readonly project: Project, private readonly actions: FileActions) {
    this.segments = (["files", "outline"] as const).map((mode) =>
      h("button", { class: "segment", onclick: () => this.show(mode) }, mode === "files" ? t("Files") : t("Outline")),
    );
    this.el.append(h("div", { class: "segmented" }, this.segments), this.body);
    this.body.addEventListener("contextmenu", (e) => {
      if (this.mode !== "files" || (e.target as HTMLElement).closest(".row")) return;
      e.preventDefault();
      menu(e.clientX, e.clientY, this.folderItems(project.root));
    });
    // The tree is rebuilt on every project event, and a rebuild between press and release swallows the click, so file
    // rows match press and release by path instead.
    const rowAt = (e: PointerEvent) => (e.target as HTMLElement).closest<HTMLElement>(".row[data-path]");
    this.body.addEventListener("pointerdown", (e) => (this.pressed = e.button === 0 ? rowAt(e)?.dataset.path ?? null : null));
    this.body.addEventListener("pointerup", (e) => {
      const row = rowAt(e);
      const pressed = this.pressed;
      this.pressed = null;
      if (e.button !== 0 || !row || row.dataset.path !== pressed) return;
      if (row.dataset.dir === undefined) return void this.project.open(pressed);
      if (!this.expanded.delete(pressed)) this.expanded.add(pressed);
      this.render();
    });
    for (const event of ["tree", "tabs", "dirty", "index"] as const) project.events.on(event, () => this.render());
    this.show("files");
  }

  show(mode: "files" | "outline"): void {
    this.mode = mode;
    this.segments.forEach((s, i) => s.classList.toggle("active", (i === 0) === (mode === "files")));
    this.render();
  }

  private render(): void {
    const scroll = this.body.scrollTop;
    if (this.mode === "files") {
      for (const tab of this.revealed) if (!this.project.tabs.includes(tab)) this.revealed.delete(tab);
      for (const tab of this.project.tabs) {
        if (this.revealed.has(tab)) continue;
        this.revealed.add(tab);
        for (let dir = dirname(tab); isUnder(dir, this.project.root) && dir !== this.project.root; dir = dirname(dir)) this.expanded.add(dir);
      }
      this.body.replaceChildren(this.project.tree.length ? this.tree(this.project.tree, 0) : h("p", { class: "empty" }, t("This folder is empty.")));
    } else {
      const outline = this.project.index?.outline ?? [];
      this.body.replaceChildren(outline.length ? this.outline(outline, 0) : h("p", { class: "empty" }, t("No sections yet.")));
    }
    this.body.scrollTop = scroll;
  }

  private tree(nodes: FileNode[], depth: number): HTMLElement {
    const list = h("ul", { class: "tree" });
    for (const node of nodes) {
      const open = this.expanded.has(node.path);
      const main = node.path === this.project.mainFile;
      const row = h(
        "div",
        {
          class: `row${node.path === this.project.current ? " selected" : ""}`,
          style: `padding-left:${8 + depth * 14}px`,
          title: this.project.relative(node.path),
          dataset: node.isDir ? { path: node.path, dir: "" } : { path: node.path },
          oncontextmenu: (e: MouseEvent) => {
            e.preventDefault();
            menu(e.clientX, e.clientY, node.isDir ? this.folderItems(node.path) : this.fileItems(node.path));
          },
        },
        node.isDir ? h("span", { class: `chevron${open ? " open" : ""}` }, icon("chevron", 12)) : h("span", { class: "chevron" }),
        node.isDir ? icon("folder") : fileIcon(node.name),
        h("span", { class: "name" }, node.name),
        main ? h("span", { class: "main-star", title: t("Main file") }, icon("star", 12)) : null,
        this.project.isDirty(node.path) ? h("span", { class: "dirty-dot", title: t("Unsaved changes") }) : null,
      );
      const item = h("li", null, row);
      if (node.isDir && open) item.append(this.tree(node.children ?? [], depth + 1));
      list.append(item);
    }
    return list;
  }

  private fileItems(path: string): MenuItem[] {
    const isMain = path === this.project.mainFile;
    return [
      { label: t("Open"), run: () => void this.project.open(path) },
      "-",
      { label: t("Rename…"), run: () => this.actions.rename(path) },
      { label: t("Duplicate"), run: () => this.actions.duplicate(path) },
      ...(path.endsWith(".tex")
        ? [{ label: isMain ? t("Detect Main File Automatically") : t("Set as Main File"), run: () => this.actions.setMain(isMain ? undefined : path) }]
        : []),
      { label: t("Show in File Manager"), run: () => this.actions.reveal(path) },
      "-",
      ...this.folderItems(dirname(path)).slice(0, 2),
      "-",
      { label: t("Move to Trash"), danger: true, run: () => this.actions.trash(path) },
    ];
  }

  private folderItems(dir: string): MenuItem[] {
    const items: MenuItem[] = [
      { label: t("New File…"), run: () => this.actions.newFile(dir) },
      { label: t("New Folder…"), run: () => this.actions.newFolder(dir) },
    ];
    if (dir === this.project.root) return [...items, "-", { label: t("Show in File Manager"), run: () => this.actions.reveal(dir) }];
    return [
      ...items,
      "-",
      { label: t("Rename…"), run: () => this.actions.rename(dir) },
      { label: t("Show in File Manager"), run: () => this.actions.reveal(dir) },
      "-",
      { label: t("Move to Trash"), danger: true, run: () => this.actions.trash(dir) },
    ];
  }

  private outline(nodes: OutlineNode[], depth: number): HTMLElement {
    const list = h("ul", { class: "tree outline" });
    for (const node of nodes) {
      const kind = node.kind === "label" ? "tag" : node.kind === "frame" ? "frame" : "section";
      list.append(
        h("li", null,
          h("div", {
            class: `row${node.kind === "label" ? " label" : ""}`,
            style: `padding-left:${8 + depth * 14}px`,
            title: `${this.project.relative(node.path)}:${node.line}`,
            onclick: () => void this.project.open(node.path, { line: node.line }),
          }, icon(kind, 14), h("span", { class: "name" }, node.title || t("Untitled frame"))),
          node.children.length ? this.outline(node.children, depth + 1) : null,
        ),
      );
    }
    return list;
  }
}
