// The Welcome screen: new project, open folder or file, clone a repository, and the recent projects (with search when there are many).
import { t } from "../i18n";
import { detectTex } from "../ipc";
import { settings } from "../settings";
import { ago, displayPath, h } from "../util";
import { icon } from "./icons";

export interface WelcomeActions {
  newProject(): void;
  openFolder(): void;
  openFile(): void;
  cloneRepository(): void;
  openRecent(path: string): void;
}

export function welcome(actions: WelcomeActions, home: string | null): { el: HTMLElement; destroy(): void } {
  const list = h("ul", { class: "recents" });
  const search = h("input", { type: "search", class: "recent-search", placeholder: t("Search recent projects") });
  const tex = h("p", { class: "tex-status" });
  const render = () => {
    const query = search.value.trim().toLowerCase();
    const recents = settings.get("recents").filter((r) => !query || `${r.name} ${r.path}`.toLowerCase().includes(query));
    search.hidden = settings.get("recents").length < 7;
    list.replaceChildren(
      ...(recents.length
        ? recents.map((r) =>
            h("li", { class: "recent", onclick: () => actions.openRecent(r.path), title: r.path },
              icon("folder", 20),
              h("div", { class: "recent-text" }, h("strong", null, r.name), h("span", null, displayPath(r.path, home))),
              h("span", { class: "recent-time" }, ago(r.opened)),
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
  void detectTex().then((info) => {
    const missing = ["latexmk", "pdflatex", "synctex"].filter((tool) => !info.tools[tool]);
    tex.replaceChildren(
      icon(missing.length ? "warning" : "check", 14),
      missing.length
        ? h("span", null, t("Missing: {tools}.", { tools: missing.join(", ") }), " ", h("code", null, `sudo apt install ${missing.includes("latexmk") ? "latexmk" : "texlive"}`))
        : h("span", null, info.distribution ?? "TeX"),
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
    h("section", { class: "welcome-recents" }, h("h2", null, t("Recent projects")), search, list),
  );
  render();
  return { el, destroy: stop };
}
