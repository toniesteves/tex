// The Welcome screen: new project, open folder or file, clone a repository, and the recent projects (with search when there
// are many, and coloured tags to filter them).
import { getVersion } from "@tauri-apps/api/app";
import { runCommand } from "../commands";
import { t } from "../i18n";
import { detectTex } from "../ipc";
import { settings, type Recent, type Tag } from "../settings";
import { ago, displayPath, h } from "../util";
import { ask, menu, menuBelow, modal, type MenuItem } from "./dialogs";
import { icon } from "./icons";

const COLORS = ["#c04fd8", "#1a8cff", "#f08c3a", "#2fb35a", "#e5484d", "#d4a017", "#14b8a6", "#8b8d98"];

export interface WelcomeActions {
  newProject(): void;
  openFolder(): void;
  openFile(): void;
  cloneRepository(): void;
  openRecent(path: string): void;
}

export function welcome(actions: WelcomeActions, home: string | null): { el: HTMLElement; destroy(): void } {
  let filter: string | null = null;
  const filters = h("div", { class: "tag-filter" });
  const list = h("ul", { class: "recents" });
  const search = h("input", { type: "search", class: "recent-search", placeholder: t("Search recent projects") });
  const tex = h("p", { class: "tex-status" });
  const render = () => {
    const query = search.value.trim().toLowerCase();
    const tags = settings.get("tags");
    if (filter && !tags.some((tag) => tag.name === filter)) filter = null;
    const colorOf = new Map(tags.map((tag) => [tag.name, tag.color]));
    const chip = (label: string, name: string | null, color?: string) =>
      h("button", {
        class: `tag-chip${filter === name ? " active" : ""}`,
        onclick: () => {
          filter = name;
          render();
        },
        oncontextmenu: name ? (e: MouseEvent) => {
          e.preventDefault();
          menu(e.clientX, e.clientY, [{ label: t("Delete Tag"), danger: true, run: () => void deleteTag(name) }]);
        } : undefined,
      }, color ? h("span", { class: "tag-dot", style: `background: ${color}` }) : null, label,
        name ? h("span", {
          class: "tag-chip-delete",
          title: t("Delete Tag"),
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            void deleteTag(name);
          },
        }, icon("close", 11)) : null);
    filters.hidden = !settings.get("recents").length;
    filters.replaceChildren(chip(t("All"), null), ...tags.map((tag) => chip(tag.name, tag.name, tag.color)),
      h("button", { class: "tag-chip new", onclick: () => void newTag().then((tag) => tag && settings.addTag(tag)) }, icon("plus", 12), t("New Tag")));
    const tagMenu = (r: Recent): MenuItem[] => [
      ...tags.map((tag) => ({ label: tag.name, color: tag.color, checked: r.tags?.includes(tag.name), run: () => settings.toggleTag(r.path, tag.name) })),
      ...(tags.length ? ["-" as const] : []),
      { label: t("New Tag…"), run: () => void newTag().then((tag) => {
        if (!tag) return;
        settings.addTag(tag);
        if (!r.tags?.includes(tag.name)) settings.toggleTag(r.path, tag.name);
      }) },
    ];
    const recents = settings.get("recents").filter((r) => (!filter || r.tags?.includes(filter)) && (!query || `${r.name} ${r.path}`.toLowerCase().includes(query)));
    search.hidden = settings.get("recents").length < 7;
    list.replaceChildren(
      ...(recents.length
        ? recents.map((r) =>
            h("li", {
              class: "recent",
              onclick: () => actions.openRecent(r.path),
              oncontextmenu: (e: MouseEvent) => {
                e.preventDefault();
                menu(e.clientX, e.clientY, tagMenu(r));
              },
              title: r.path,
            },
              icon("folder", 20),
              h("div", { class: "recent-text" }, h("strong", null, r.name), h("span", null, displayPath(r.path, home))),
              h("span", { class: "recent-tags" }, (r.tags ?? []).filter((n) => colorOf.has(n)).map((n) => h("span", { class: "tag-dot", title: n, style: `background: ${colorOf.get(n)}` }))),
              h("span", { class: "recent-time" }, ago(r.opened)),
              h("button", {
                class: "icon-button tag",
                title: t("Tags"),
                onclick: (e: MouseEvent) => {
                  e.stopPropagation();
                  menuBelow(e.currentTarget as HTMLElement, tagMenu(r));
                },
              }, icon("tag", 14)),
              h("button", {
                class: "icon-button remove",
                title: t("Remove from the list"),
                onclick: (e: MouseEvent) => {
                  e.stopPropagation();
                  settings.removeRecent(r.path);
                },
              }, icon("close", 13)),
            ),
          )
        : [h("li", { class: "empty" }, query ? t("No project matches.") : t("Recent projects appear here."))]),
    );
  };
  search.addEventListener("input", render);
  const stop = settings.onChange(render);
  void Promise.all([detectTex(), getVersion()]).then(([info, version]) => {
    const missing = ["latexmk", "pdflatex", "synctex"].filter((tool) => !info.tools[tool]);
    tex.replaceChildren(
      icon(missing.length ? "warning" : "check", 14),
      missing.length
        ? h("span", null, t("Missing: {tools}.", { tools: missing.join(", ") }), " ", h("code", null, `sudo apt install ${missing.includes("latexmk") ? "latexmk" : "texlive"}`))
        : h("span", null, info.distribution ?? "TeX"),
      h("span", null, `· Tex ${version}`),
    );
    tex.classList.toggle("warning", missing.length > 0);
  });
  const el = h("div", { class: "welcome" },
    h("div", { class: "welcome-hero" },
      h("img", { src: "/icon.png", alt: "", width: 96, height: 96 }),
      h("h1", null, "Tex"),
      h("p", null, t("A light LaTeX editor for developers")),
      h("div", { class: "welcome-actions" },
        h("button", { class: "primary", onclick: actions.newProject }, icon("plus"), t("New Project…")),
        h("button", { onclick: actions.openFolder }, icon("open"), t("Open Folder…")),
        h("button", { onclick: actions.openFile }, icon("file"), t("Open File…")),
        h("button", { onclick: actions.cloneRepository }, icon("branch"), t("Clone Repository…")),
      ),
      tex,
    ),
    h("section", { class: "welcome-recents" },
      h("div", { class: "welcome-recents-head" }, h("h2", null, t("Recent projects")),
        h("button", { class: "tool", title: t("Settings"), "aria-label": t("Settings"), onclick: () => runCommand("view.settings") }, icon("gear", 16))),
      filters, search, list),
  );
  render();
  return { el, destroy: stop };
}

/** Asks for the name and colour of a new tag; null when cancelled. */
function newTag(): Promise<Tag | null> {
  const next = COLORS[settings.get("tags").length % COLORS.length];
  const input = h("input", { type: "text", spellcheck: "false" });
  const box = h("form", { class: "dialog" },
    h("h2", null, t("New Tag")),
    h("label", null, t("Name"), input),
    h("div", { class: "swatches" }, COLORS.map((color) =>
      h("label", { class: "swatch", style: `background: ${color}` }, h("input", { type: "radio", name: "color", value: color, checked: color === next })))),
    h("div", { class: "dialog-buttons" }, h("button", { type: "button", class: "cancel" }, t("Cancel")), h("button", { class: "primary" }, t("Create"))));
  const { result, close } = modal<Tag | null>(box, null);
  box.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = input.value.trim();
    close(name ? { name, color: String(new FormData(box).get("color")) } : null);
  });
  box.querySelector(".cancel")!.addEventListener("click", () => close(null));
  input.focus();
  return result;
}

async function deleteTag(name: string): Promise<void> {
  const answer = await ask({
    title: t("Delete the tag “{name}”?", { name }),
    message: t("It is removed from every project."),
    buttons: [{ label: t("Cancel"), value: "cancel" }, { label: t("Delete"), value: "delete", danger: true }],
  });
  if (answer === "delete") settings.deleteTag(name);
}
