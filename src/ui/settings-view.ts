// Settings: General, Editor, TeX, Shortcuts and About. Changes apply at once and reach every window.
import { getVersion } from "@tauri-apps/api/app";
import { allCommands, comboFromEvent, conflictFor, isShortcut, RESERVED, resetShortcuts, setShortcut, shortcutOf, type Command } from "../commands";
import { isPortuguese, setLanguage, t } from "../i18n";
import { detectTex, openExternal } from "../ipc";
import { applyTheme, settings, type Settings } from "../settings";
import { h } from "../util";
import { modal } from "./dialogs";
import { icon } from "./icons";

type Tab = "general" | "editor" | "tex" | "shortcuts" | "about";
const TABS: [Tab, string][] = [["general", "General"], ["editor", "Editor"], ["tex", "TeX"], ["shortcuts", "Shortcuts"], ["about", "About"]];
const WEBSITE = "https://toniesteves.github.io/tex/";

/** True while a shortcut is being recorded (global shortcuts are paused). */
export let recording = false;

/** What to do after the language changes (the app reloads the window when nothing is unsaved). */
let languageChanged: () => void = () => {};
export const onLanguageChange = (fn: () => void): void => void (languageChanged = fn);

const row = (label: string, control: HTMLElement, hint?: string) =>
  h("label", { class: "setting" }, h("span", { class: "setting-label" }, label, hint ? h("small", null, hint) : null), control);

function toggle<K extends keyof Settings>(key: K, label: string, hint?: string): HTMLElement {
  const input = h("input", { type: "checkbox", class: "switch", checked: settings.get(key) as boolean });
  input.addEventListener("change", () => settings.set(key, input.checked as Settings[K]));
  return row(label, input, hint);
}

function choice<K extends keyof Settings>(key: K, label: string, options: [Settings[K], string][], after?: () => void): HTMLElement {
  const select = h("select", null, options.map(([value, text]) => h("option", { value: String(value), selected: settings.get(key) === value }, text)));
  select.addEventListener("change", () => {
    const option = options.find(([value]) => String(value) === select.value);
    if (option) settings.set(key, option[0]);
    after?.();
  });
  return row(label, select);
}

function number<K extends keyof Settings>(key: K, label: string, min: number, max: number, step: number, scale = 1, unit = ""): HTMLElement {
  const input = h("input", { type: "number", min, max, step, value: String((settings.get(key) as number) / scale) });
  input.addEventListener("change", () => {
    const value = Math.min(max, Math.max(min, Number(input.value) || min));
    input.value = String(value);
    settings.set(key, (value * scale) as Settings[K]);
  });
  return row(label, h("span", { class: "number" }, input, unit));
}

function general(): HTMLElement[] {
  return [
    choice("language", t("Language"), [["system", t("System")], ["en", "English"], ["pt-BR", "Português (Brasil)"]], () => {
      setLanguage(settings.get("language"));
      languageChanged();
    }),
    choice("theme", t("Appearance"), [["system", t("System")], ["light", t("Light")], ["dark", t("Dark")], ["monokai", "Monokai"], ["dracula", "Dracula"]], applyTheme),
    choice("engine", t("Default engine"), [["pdflatex", "pdfLaTeX"], ["xelatex", "XeLaTeX"], ["lualatex", "LuaLaTeX"]]),
    toggle("liveCompile", t("Compile while typing"), t("The PDF follows unsaved text; your files are not touched.")),
    number("liveDelay", t("Pause before compiling"), 0.3, 5, 0.1, 1000, t("s")),
    toggle("compileOnSave", t("Compile when saving"), t("Also writes the PDF next to the main file.")),
    choice("pdfSync", t("Jump to source from the PDF"), [["dblclick", t("Double-click")], ["ctrlclick", t("Ctrl+click")]]),
    toggle("followCursor", t("Follow the cursor in the PDF")),
    choice("notes", t("Beamer notes in the presenter view"), [["auto", t("Right half of wide pages")], ["left", t("Left half of wide pages")], ["none", t("No notes")]]),
  ];
}

function editor(): HTMLElement[] {
  const font = h("input", { type: "text", value: settings.get("fontFamily"), placeholder: t("Default monospace font") });
  font.addEventListener("change", () => settings.set("fontFamily", font.value.trim()));
  return [
    number("fontSize", t("Font size"), 9, 32, 1, 1, "px"),
    row(t("Font"), font),
    number("lineHeight", t("Line height"), 1, 2.5, 0.1),
    choice("indentSize", t("Indentation"), [[2, t("2 spaces")], [4, t("4 spaces")]]),
    toggle("lineNumbers", t("Line numbers")),
    toggle("wrap", t("Wrap long lines")),
    toggle("activeLine", t("Highlight the current line")),
    toggle("autoPair", t("Close brackets and $ automatically")),
    toggle("autoComplete", t("Suggest completions while typing"), t("Tab and Ctrl+Space also show them.")),
    toggle("vim", t("Vim mode"), t("Ctrl+B, D, E, F, H, R, U, V, W and Y stay with Vim in the editor.")),
  ];
}

function tex(): HTMLElement[] {
  const list = h("div", { class: "tex-tools" }, t("Looking for TeX…"));
  void detectTex().then((info) => {
    const tools = Object.entries(info.tools).sort(([a], [b]) => a.localeCompare(b));
    list.replaceChildren(
      h("p", null, h("strong", null, info.distribution ?? t("No TeX distribution found"))),
      h("ul", null, tools.map(([tool, found]) => h("li", { class: found ? "found" : "missing" }, icon(found ? "check" : "error", 14), tool))),
      ...(info.tools.latexmk ? [] : [h("p", null, t("Install latexmk with:"), " ", h("code", null, "sudo apt install latexmk"))]),
      ...(info.tools.biber ? [] : [h("p", { class: "hint" }, t("biblatex with biber needs:"), " ", h("code", null, "sudo apt install biber"))]),
      h("p", { class: "hint" }, t("On Debian and Linux Mint, LaTeX packages come from apt (texlive-*), not from tlmgr.")),
    );
  });
  return [list];
}

function shortcuts(): HTMLElement[] {
  const filter = h("input", { type: "search", placeholder: t("Search commands") });
  const list = h("div", { class: "shortcut-list" });
  const render = () => {
    const query = filter.value.trim().toLowerCase();
    const commands = allCommands().filter((c) => !c.hidden && `${t(c.title)} ${c.title}`.toLowerCase().includes(query));
    const groups = [...new Set(commands.map((c) => c.category))];
    list.replaceChildren(
      ...groups.flatMap((group) => [
        h("h3", null, t(group)),
        ...commands.filter((c) => c.category === group).map((c) => shortcutRow(c, render)),
      ]),
    );
  };
  filter.addEventListener("input", render);
  render();
  return [
    h("div", { class: "shortcut-tools" }, filter, h("button", { onclick: () => (resetShortcuts(), render()) }, t("Restore All Defaults"))),
    list,
  ];
}

function shortcutRow(command: Command, refresh: () => void): HTMLElement {
  const current = shortcutOf(command);
  const button = h("button", { class: "shortcut" }, current || t("None"));
  const note = h("span", { class: "shortcut-note" });
  button.addEventListener("click", () => {
    recording = true;
    button.textContent = t("Press keys…");
    button.classList.add("recording");
    const stop = () => {
      recording = false;
      document.removeEventListener("keydown", key, true);
      button.removeEventListener("blur", cancel);
    };
    const cancel = () => (stop(), refresh());
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return cancel();
      if (e.key === "Backspace" || e.key === "Delete") return stop(), setShortcut(command.id, ""), refresh();
      const combo = comboFromEvent(e);
      if (!combo) return;
      stop();
      if (!isShortcut(combo) || RESERVED.has(combo)) {
        refresh();
        return;
      }
      const other = conflictFor(command.id, combo);
      if (!other) return setShortcut(command.id, combo), refresh();
      button.textContent = combo;
      note.replaceChildren(t("Used by “{title}”.", { title: t(other.title) }), " ",
        h("button", { class: "link", onclick: () => (setShortcut(other.id, ""), setShortcut(command.id, combo), refresh()) }, t("Replace")),
        h("button", { class: "link", onclick: refresh }, t("Cancel")));
    };
    document.addEventListener("keydown", key, true);
    button.addEventListener("blur", cancel, { once: true });
  });
  const reset = command.keys !== current
    ? h("button", { class: "icon-button", title: t("Restore Default"), onclick: () => (setShortcut(command.id, command.keys ?? ""), refresh()) }, icon("close", 12))
    : null;
  return h("div", { class: "shortcut-row" }, h("span", null, t(command.title)), note, button, reset);
}

function about(): HTMLElement[] {
  const version = h("p", { class: "about-version" });
  void getVersion().then((v) => (version.textContent = t("Version {version}", { version: v })));
  // The site picks its language from ?lang=, so it opens in the language of the app.
  const site = `${WEBSITE}?lang=${isPortuguese() ? "pt" : "en"}`;
  return [
    h("div", { class: "about" },
      h("img", { src: "/icon.png", alt: "", width: 80, height: 80 }),
      h("h3", null, "Tex"),
      version,
      h("p", null, t("A light LaTeX editor for developers")),
      h("button", { class: "link", onclick: () => void openExternal(site) }, WEBSITE.replace(/^https:\/\/|\/$/g, ""))),
  ];
}

export function openSettings(initial: Tab = "general"): void {
  if (document.querySelector(".settings")) return;
  const body = h("div", { class: "settings-body" });
  const nav = h("nav", null);
  const show = (tab: Tab) => {
    nav.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    body.replaceChildren(...{ general, editor, tex, shortcuts, about }[tab]());
  };
  for (const [tab, label] of TABS) nav.append(h("button", { dataset: { tab }, onclick: () => show(tab) }, t(label)));
  const box = h("div", { class: "dialog settings" }, h("h2", null, t("Settings")), h("div", { class: "settings-layout" }, nav, body),
    h("div", { class: "dialog-buttons" }, h("button", { class: "primary", onclick: () => close(undefined) }, t("Done"))));
  const { close } = modal<void>(box, undefined);
  show(initial);
}
