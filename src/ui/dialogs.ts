// In-app dialogs (confirmation with up to three buttons, text prompt), context menus and toasts.
import { t } from "../i18n";
import { h } from "../util";

export interface Button {
  label: string;
  value: string;
  primary?: boolean;
  danger?: boolean;
}

let openModals = 0;
export const isModalOpen = (): boolean => openModals > 0 || !!document.querySelector(".menu");

/** Shows `content` over a backdrop; Esc and a click outside close it with `cancel`. */
export function modal<T>(content: HTMLElement, cancel: T): { result: Promise<T>; close: (value: T) => void } {
  let close!: (value: T) => void;
  const result = new Promise<T>((resolve) => {
    const backdrop = h("div", { class: "backdrop" }, content);
    const previous = document.activeElement as HTMLElement | null;
    const key = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        close(cancel);
      }
    };
    close = (value: T) => {
      openModals--;
      backdrop.remove();
      document.removeEventListener("keydown", key, true);
      previous?.focus();
      resolve(value);
    };
    openModals++;
    backdrop.addEventListener("mousedown", (e) => e.target === backdrop && close(cancel));
    document.addEventListener("keydown", key, true);
    document.body.append(backdrop);
  });
  return { result, close };
}

export function ask(options: { title: string; message?: string; buttons: Button[]; cancel?: string }): Promise<string> {
  const cancel = options.cancel ?? "cancel";
  const row = h("div", { class: "dialog-buttons" });
  const box = h("div", { class: "dialog", role: "alertdialog" }, h("h2", null, options.title), options.message ? h("p", null, options.message) : null, row);
  const { result, close } = modal(box, cancel);
  for (const button of options.buttons) {
    row.append(h("button", { class: button.primary ? "primary" : button.danger ? "danger" : "", onclick: () => close(button.value) }, button.label));
  }
  (row.querySelector<HTMLElement>(".primary") ?? row.querySelector<HTMLElement>("button"))?.focus();
  return result;
}

export async function alert(title: string, message?: string): Promise<void> {
  await ask({ title, message, buttons: [{ label: t("OK"), value: "ok", primary: true }] });
}

/** A one-field form; resolves with the trimmed text, or null when cancelled or empty. */
export function prompt(options: { title: string; label?: string; value?: string; ok?: string; selectStem?: boolean }): Promise<string | null> {
  const input = h("input", { type: "text", value: options.value ?? "", spellcheck: "false" });
  const ok = h("button", { class: "primary" }, options.ok ?? t("OK"));
  const box = h("form", { class: "dialog" }, h("h2", null, options.title), options.label ? h("label", null, options.label) : null, input,
    h("div", { class: "dialog-buttons" }, h("button", { type: "button", class: "cancel" }, t("Cancel")), ok));
  const { result, close } = modal<string | null>(box, null);
  box.addEventListener("submit", (e) => {
    e.preventDefault();
    close(input.value.trim() || null);
  });
  box.querySelector(".cancel")!.addEventListener("click", () => close(null));
  input.focus();
  const dot = options.selectStem ? input.value.lastIndexOf(".") : -1;
  input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  return result;
}

export type MenuItem = { label: string; run: () => void; disabled?: boolean; danger?: boolean; checked?: boolean; shortcut?: string; color?: string } | "-";

/** A context menu at a point (closes on any click, Esc or scroll). */
export function menu(x: number, y: number, items: MenuItem[]): void {
  document.querySelector(".menu")?.remove();
  const el = h("div", { class: "menu", role: "menu" });
  const close = () => {
    el.remove();
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", key, true);
  };
  const outside = (e: MouseEvent) => !el.contains(e.target as Node) && close();
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  for (const item of items) {
    if (item === "-") {
      el.append(h("div", { class: "menu-separator" }));
      continue;
    }
    el.append(
      h("button", {
        class: `menu-item${item.danger ? " danger" : ""}`,
        disabled: item.disabled ?? false,
        onclick: () => {
          close();
          item.run();
        },
      }, h("span", { class: "menu-check" }, item.checked ? "✓" : ""), item.color ? h("span", { class: "tag-dot", style: `background: ${item.color}` }) : null, h("span", { class: "menu-label" }, item.label), item.shortcut ? h("kbd", null, item.shortcut) : null),
    );
  }
  document.body.append(el);
  const { width, height } = el.getBoundingClientRect();
  el.style.left = `${Math.min(x, window.innerWidth - width - 8)}px`;
  el.style.top = `${Math.min(y, window.innerHeight - height - 8)}px`;
  document.addEventListener("mousedown", outside, true);
  document.addEventListener("keydown", key, true);
}

/** Opens a menu below an element. */
export function menuBelow(anchor: HTMLElement, items: MenuItem[]): void {
  const r = anchor.getBoundingClientRect();
  menu(r.left, r.bottom + 4, items);
}

export function toast(message: string): void {
  const el = h("div", { class: "toast" }, message);
  document.body.append(el);
  window.setTimeout(() => el.classList.add("leaving"), 2200);
  window.setTimeout(() => el.remove(), 2600);
}
