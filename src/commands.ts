// The command registry: everything the user can do, with stable ids and default shortcuts. The toolbar, the command
// palette and the keyboard all run these entries, and the user can rebind any shortcut in Settings.
import { settings } from "./settings";

export interface Command {
  id: string;
  /** English; translated where it is shown. */
  title: string;
  category: "File" | "Edit" | "View" | "Build" | "Presentation" | "Tabs";
  keys?: string;
  run: () => unknown;
  enabled?: () => boolean;
  /** Kept out of the palette and the shortcut list (tab 1…9 and the like). */
  hidden?: boolean;
}

const registry = new Map<string, Command>();

export function defineCommands(commands: Command[]): void {
  for (const command of commands) registry.set(command.id, command);
}

export const allCommands = (): Command[] => [...registry.values()];
export const isEnabled = (command: Command): boolean => command.enabled?.() ?? true;

export function runCommand(id: string): boolean {
  const command = registry.get(id);
  if (!command || !isEnabled(command)) return false;
  if (!command.hidden) settings.set("recentCommands", [id, ...settings.get("recentCommands").filter((c) => c !== id)].slice(0, 12));
  void command.run();
  return true;
}

export function shortcutOf(command: Command): string {
  return settings.get("shortcuts")[command.id] ?? command.keys ?? "";
}

/** Combinations that stay with text editing and the window manager. */
export const RESERVED = new Set(["Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Z", "Ctrl+Shift+Z", "Ctrl+Y", "Ctrl+A", "Alt+F4", "Alt+Tab", "Super"]);

/** "Ctrl+Shift+P" for a key event; letters and digits by physical key (so Shift does not change them), the rest by
 * the character the layout produces (ABNT2 and US-International keyboards included). */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "Dead"].includes(e.key)) return null;
  let key = e.code.startsWith("Key") ? e.code.slice(3) : e.code.startsWith("Digit") ? e.code.slice(5) : e.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  const modifiers = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
  return [...modifiers, key].join("+");
}

/** Shortcuts need a modifier, unless they are function keys. */
export const isShortcut = (combo: string): boolean => combo.includes("+") || /^F\d{1,2}$/.test(combo);

export function commandForCombo(combo: string): Command | undefined {
  return allCommands().find((c) => shortcutOf(c) === combo);
}

export function conflictFor(id: string, combo: string): Command | undefined {
  return combo ? allCommands().find((c) => c.id !== id && shortcutOf(c) === combo) : undefined;
}

/** Stores a shortcut; the default is stored as "no override", an empty string as "no shortcut". */
export function setShortcut(id: string, combo: string): void {
  const overrides = { ...settings.get("shortcuts") };
  if (combo === (registry.get(id)?.keys ?? "")) delete overrides[id];
  else overrides[id] = combo;
  settings.set("shortcuts", overrides);
}

export function resetShortcuts(): void {
  settings.set("shortcuts", {});
}
