// Settings, recent projects and per-project state, kept in localStorage. Every window shares them: a change in one
// window reaches the others through the `storage` event.
import type { Engine } from "./ipc";
import type { Language } from "./i18n";

export interface Recent {
  path: string;
  name: string;
  opened: number;
}

export interface ProjectState {
  main?: string;
  engine?: Engine;
  tabs?: string[];
  current?: string;
  split?: number;
  pdfHidden?: boolean;
  sidebarHidden?: boolean;
  sidebarWidth?: number;
}

export interface Settings {
  language: Language;
  theme: "system" | "light" | "dark";
  engine: Engine;
  liveCompile: boolean;
  liveDelay: number;
  compileOnSave: boolean;
  pdfSync: "dblclick" | "ctrlclick";
  followCursor: boolean;
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  lineNumbers: boolean;
  wrap: boolean;
  activeLine: boolean;
  autoPair: boolean;
  autoComplete: boolean;
  indentSize: number;
  vim: boolean;
  notes: "auto" | "left" | "none";
  shortcuts: Record<string, string>;
  recentCommands: string[];
  recents: Recent[];
  projects: Record<string, ProjectState>;
}

const DEFAULTS: Settings = {
  language: "system",
  theme: "system",
  engine: "pdflatex",
  liveCompile: true,
  liveDelay: 1000,
  compileOnSave: true,
  pdfSync: "dblclick",
  followCursor: false,
  fontSize: 14,
  fontFamily: "",
  lineHeight: 1.5,
  lineNumbers: true,
  wrap: true,
  activeLine: true,
  autoPair: true,
  autoComplete: true,
  indentSize: 2,
  vim: false,
  notes: "auto",
  shortcuts: {},
  recentCommands: [],
  recents: [],
  projects: {},
};

const KEY = "tex.settings";
const MAX_RECENTS = 15;

function load(): Settings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

class Store {
  private value = load();
  private listeners = new Set<() => void>();

  constructor() {
    window.addEventListener("storage", (e) => {
      if (e.key !== KEY) return;
      this.value = load();
      this.listeners.forEach((fn) => fn());
    });
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.value[key];
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.value[key] = value;
    this.save();
    this.listeners.forEach((fn) => fn());
  }

  defaults(): Settings {
    return DEFAULTS;
  }

  /** Called on every change, in this window or another one. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  project(root: string): ProjectState {
    return this.value.projects[root] ?? {};
  }

  /** Per-project state is bookkeeping: saving it does not notify listeners. */
  updateProject(root: string, patch: Partial<ProjectState>): void {
    this.value.projects[root] = { ...this.project(root), ...patch };
    this.save();
  }

  addRecent(path: string, name: string): void {
    const recents = [{ path, name, opened: Date.now() }, ...this.value.recents.filter((r) => r.path !== path)];
    this.set("recents", recents.slice(0, MAX_RECENTS));
  }

  removeRecent(path: string): void {
    this.set("recents", this.value.recents.filter((r) => r.path !== path));
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.value));
    } catch (e) {
      console.error("settings not saved", e);
    }
  }
}

export const settings = new Store();

/** Applies the light/dark choice; "system" follows the desktop. */
export function applyTheme(): void {
  const theme = settings.get("theme");
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
