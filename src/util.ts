// Small shared helpers: building DOM, POSIX paths, timers and events.

type Child = Node | string | number | false | null | undefined;
type Props = Record<string, unknown>;

/** `h("button", { class: "x", onclick }, "label")`: properties starting with `on` become listeners. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = String(value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value as EventListener);
    else if (typeof value === "boolean" || (key in el && typeof value !== "string")) (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
export const dirname = (p: string): string => (p.lastIndexOf("/") <= 0 ? "/" : p.slice(0, p.lastIndexOf("/")));
export function extname(p: string): string {
  const name = basename(p);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}
export function stem(p: string): string {
  const name = basename(p);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

/** Resolves `.` and `..` lexically; the result is absolute. */
export function normalizePath(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

export const joinPath = (base: string, rel: string): string => normalizePath(rel.startsWith("/") ? rel : `${base}/${rel}`);

export function relativePath(fromDir: string, to: string): string {
  const a = fromDir.split("/").filter(Boolean);
  const b = to.split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...Array<string>(a.length - i).fill(".."), ...b.slice(i)].join("/");
}

export const isUnder = (p: string, dir: string): boolean => p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/** `~/…` for paths in the home folder. */
export function displayPath(p: string, home: string | null): string {
  return home && isUnder(p, home) ? `~${p.slice(home.length)}` : p;
}

/** A timer that restarts on every `schedule`. */
export class Debouncer {
  private timer: number | undefined;
  constructor(private readonly fn: () => void) {}
  schedule(ms: number): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(this.fn, ms);
  }
  cancel(): void {
    window.clearTimeout(this.timer);
  }
}

export class Emitter<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<(value: never) => void>>();
  on<K extends keyof Events>(event: K, fn: (value: Events[K]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn as (value: never) => void);
    return () => set.delete(fn as (value: never) => void);
  }
  emit<K extends keyof Events>(event: K, value: Events[K]): void {
    for (const fn of this.handlers.get(event) ?? []) (fn as (value: Events[K]) => void)(value);
  }
}

/** A stable short id for a string (window labels, cache keys). */
export function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Subsequence match with a score that favours word starts and consecutive characters; null when it does not match. */
export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let last = -2;
  let ti = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    const boundary = found === 0 || /[\s/._\-\\]/.test(t[found - 1] ?? "");
    score += (found === last + 1 ? 5 : 1) + (boundary ? 4 : 0);
    last = found;
    ti = found + 1;
  }
  return score - t.length * 0.01;
}
