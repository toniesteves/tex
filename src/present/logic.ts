// Presentation logic without any UI: slide navigation and how a Beamer page splits into slide and notes.

export interface Nav {
  index: number;
  count: number;
  blank: null | "black" | "white";
  /** Digits typed so far; Return jumps to that slide. */
  digits: string;
}

export const startNav = (count: number): Nav => ({ index: 0, count, blank: null, digits: "" });

const go = (nav: Nav, index: number): Nav => ({ ...nav, index: Math.min(Math.max(index, 0), Math.max(nav.count - 1, 0)), blank: null, digits: "" });

/** The state after a key (`KeyboardEvent.key`), "end" for Esc, or null when the key does nothing here. */
export function navigate(nav: Nav, key: string): Nav | "end" | null {
  if (/^\d$/.test(key)) return { ...nav, digits: (nav.digits + key).slice(-4) };
  if (key === "Enter" && nav.digits) return go(nav, Number(nav.digits) - 1);
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
    case " ":
    case "PageDown":
    case "Enter":
      return go(nav, nav.index + 1);
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
    case "Backspace":
      return go(nav, nav.index - 1);
    case "Home":
      return go(nav, 0);
    case "End":
      return go(nav, nav.count - 1);
    case "b":
    case "B":
    case ".":
      return { ...nav, blank: nav.blank === "black" ? null : "black", digits: "" };
    case "w":
    case "W":
    case ",":
      return { ...nav, blank: nav.blank === "white" ? null : "white", digits: "" };
    case "Escape":
      return "end";
    default:
      return null;
  }
}

/** Keeps the slide when a recompile changes the page count. */
export const withCount = (nav: Nav, count: number): Nav => ({ ...nav, count, index: Math.min(nav.index, Math.max(count - 1, 0)) });

/** Horizontal fractions of a page: the slide, and the notes when the page carries them (twice as wide as a slide). */
export function splitPage(width: number, height: number, mode: "auto" | "left" | "none"): { slide: [number, number]; notes: [number, number] | null } {
  const wide = width / height >= 2.2;
  if (!wide || mode === "none") return { slide: [0, 1], notes: null };
  return mode === "left" ? { slide: [0.5, 1], notes: [0, 0.5] } : { slide: [0, 0.5], notes: [0.5, 1] };
}

/** "1:05:09" or "5:09". */
export function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
