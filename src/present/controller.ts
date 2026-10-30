// Starts and ends a presentation from the project window. With two displays the audience view goes full screen on
// the other display and the presenter view on this one; with one display the audience view fills it and P shows the
// presenter view on top. The windows keep in step through events.
import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { availableMonitors, currentMonitor, type Monitor } from "@tauri-apps/api/window";

let active = false;
export const isPresenting = (): boolean => active;

void listen("present:ended", () => (active = false));

const sameMonitor = (a: Monitor, b: Monitor | null) => !!b && a.position.x === b.position.x && a.position.y === b.position.y;

async function openWindow(label: string, url: string, title: string, monitor: Monitor | null, focus: boolean): Promise<void> {
  const window = new WebviewWindow(label, {
    url,
    title,
    decorations: false,
    focus,
    width: 960,
    height: 600,
    ...(monitor ? { x: monitor.position.x / monitor.scaleFactor + 40, y: monitor.position.y / monitor.scaleFactor + 40 } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    void window.once("tauri://created", () => resolve());
    void window.once("tauri://error", (e) => reject(new Error(String(e.payload))));
  });
  if (monitor) await window.setFullscreenOnMonitor(monitor.position);
  else await window.setFullscreen(true);
}

export async function startPresentation(pdf: string, title: string): Promise<void> {
  if (active) return;
  const here = await currentMonitor();
  const other = (await availableMonitors()).find((m) => !sameMonitor(m, here)) ?? null;
  const url = (view: string) => `/?view=${view}&screens=${other ? 2 : 1}&pdf=${encodeURIComponent(pdf)}`;
  active = true;
  try {
    await openWindow("present-audience", url("audience"), title, other ?? here, !other);
    if (other) await openWindow("present-presenter", url("presenter"), title, here, true);
  } catch (e) {
    active = false;
    void emit("present:end");
    throw e;
  }
}

/** After a recompile: the windows load the new PDF and keep the current slide. */
export function reloadPresentation(pdf: string): void {
  if (active) void emit("present:reload", { pdf });
}

export function stopPresentation(): void {
  if (active) void emit("present:end");
}
