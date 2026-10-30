// The floating palette shared by Quick Open (files) and the Command Palette: fuzzy search, ↑↓, Return, Esc.
import { allCommands, isEnabled, runCommand, shortcutOf } from "../commands";
import { t } from "../i18n";
import type { Project } from "../project";
import { settings } from "../settings";
import { basename, dirname, fuzzyScore, h } from "../util";
import { fileIcon } from "./icons";

interface Item {
  label: string;
  detail?: string;
  hint?: string;
  disabled?: boolean;
  icon?: Element;
  run: () => void;
}

let open: { id: string; close: () => void } | null = null;

export const isPaletteOpen = (): boolean => open !== null;

/** Opens a palette, or closes it when the same one is already open. */
function palette(id: string, placeholder: string, source: (query: string) => Item[]): void {
  const same = open?.id === id;
  open?.close();
  if (same) return;
  const previous = document.activeElement as HTMLElement | null;
  const input = h("input", { type: "text", placeholder, spellcheck: "false" });
  const list = h("ul", { class: "palette-list" });
  const backdrop = h("div", { class: "palette-backdrop" }, h("div", { class: "palette" }, input, list));
  let items: Item[] = [];
  let selected = 0;
  const close = () => {
    backdrop.remove();
    open = null;
    previous?.focus();
  };
  const choose = (index: number) => {
    const item = items[index];
    if (!item || item.disabled) return;
    close();
    item.run();
  };
  const render = () => {
    list.replaceChildren(
      ...items.map((item, i) =>
        h("li", {
          class: `${i === selected ? "selected" : ""}${item.disabled ? " disabled" : ""}`,
          onmousedown: (e: MouseEvent) => (e.preventDefault(), choose(i)),
          onmousemove: () => i !== selected && ((selected = i), render()),
        }, item.icon ?? null, h("span", { class: "palette-label" }, item.label), item.detail ? h("span", { class: "palette-detail" }, item.detail) : null,
          item.hint ? h("kbd", null, item.hint) : null),
      ),
    );
    list.children[selected]?.scrollIntoView({ block: "nearest" });
  };
  const update = () => {
    items = source(input.value.trim()).slice(0, 200);
    selected = Math.max(0, items.findIndex((item) => !item.disabled));
    render();
  };
  input.addEventListener("input", update);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") selected = (selected + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length);
    else if (e.key === "Enter") choose(selected);
    else if (e.key === "Escape") close();
    else return;
    e.preventDefault();
    e.stopPropagation();
    render();
  });
  backdrop.addEventListener("mousedown", (e) => e.target === backdrop && close());
  document.body.append(backdrop);
  input.focus();
  update();
  open = { id, close };
}

const ranked = <T>(entries: T[], query: string, text: (entry: T) => string): T[] =>
  entries
    .map((entry) => ({ entry, score: fuzzyScore(query, text(entry)) }))
    .filter((x): x is { entry: T; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.entry);

export function quickOpen(project: Project): void {
  palette("files", t("Go to file…"), (query) => {
    const files = query ? ranked(project.files, query, (p) => project.relative(p)) : [...project.tabs, ...project.files.filter((p) => !project.tabs.includes(p))];
    return files.map((path) => {
      const rel = project.relative(path);
      return { label: basename(rel), detail: rel.includes("/") ? dirname(rel) : undefined, icon: fileIcon(path), run: () => void project.open(path) };
    });
  });
}

export function commandPalette(): void {
  palette("commands", t("Run a command…"), (query) => {
    const recent = settings.get("recentCommands");
    const visible = allCommands().filter((c) => !c.hidden);
    const order = query
      ? ranked(visible, query, (c) => `${t(c.title)} ${t(c.category)}`)
      : [...visible].sort((a, b) => (recent.indexOf(a.id) + 1 || 99) - (recent.indexOf(b.id) + 1 || 99) || t(a.title).localeCompare(t(b.title)));
    return order.map((c) => ({ label: t(c.title), detail: t(c.category), hint: shortcutOf(c), disabled: !isEnabled(c), run: () => runCommand(c.id) }));
  });
}
