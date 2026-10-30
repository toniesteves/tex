// The audience and presenter windows. Slides always sit on black; the presenter view shows the current and next
// slide, the Beamer notes (when the pages carry them), the slide counter, a timer and the clock.
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from "pdfjs-dist";
import { t } from "../i18n";
import { readBytes } from "../ipc";
import { pdfWorker } from "../pdf/viewer";
import { settings } from "../settings";
import { h } from "../util";
import { clock, navigate, splitPage, startNav, withCount, type Nav } from "./logic";

interface State {
  from: string;
  index: number;
  blank: Nav["blank"];
}

const load = async (pdf: string): Promise<PDFDocumentLoadingTask> => getDocument({ data: await readBytes(pdf), useSystemFonts: true, worker: pdfWorker() });

/** Draws one half (or all) of a page into `box`, as large as fits. False when the page has no such part. */
async function draw(doc: PDFDocumentProxy, index: number, box: HTMLElement, part: "slide" | "notes"): Promise<boolean> {
  if (index < 0 || index >= doc.numPages) {
    box.replaceChildren();
    return false;
  }
  const page = await doc.getPage(index + 1);
  const base = page.getViewport({ scale: 1 });
  const split = splitPage(base.width, base.height, settings.get("notes"));
  const range = part === "slide" ? split.slide : split.notes;
  if (!range) {
    box.replaceChildren();
    return false;
  }
  const width = base.width * (range[1] - range[0]);
  const scale = Math.max(0.1, Math.min(box.clientWidth / width, box.clientHeight / base.height));
  const ratio = window.devicePixelRatio || 1;
  const canvas = h("canvas", { width: Math.floor(width * scale * ratio), height: Math.floor(base.height * scale * ratio) });
  canvas.style.width = `${Math.floor(width * scale)}px`;
  canvas.style.height = `${Math.floor(base.height * scale)}px`;
  const shift = -range[0] * base.width * scale * ratio;
  await page.render({ canvas, viewport: page.getViewport({ scale }), transform: [ratio, 0, 0, ratio, shift, 0] }).promise;
  box.replaceChildren(canvas);
  return true;
}

export async function bootPresentation(root: HTMLElement, role: "audience" | "presenter", pdf: string, screens: number): Promise<void> {
  document.documentElement.classList.add("presentation", role);
  const me = Math.random().toString(36).slice(2);
  let task = await load(pdf);
  let doc = await task.promise;
  let nav = startNav(doc.numPages);
  let generation = 0;

  const stage = h("div", { class: "stage" });
  const blank = h("div", { class: "blank" });
  const current = h("div", { class: "slide-box" });
  const next = h("div", { class: "slide-box" });
  const notes = h("div", { class: "slide-box" });
  const counter = h("span", { class: "counter" });
  const timer = h("span", { class: "timer" });
  const time = h("span", { class: "clock" });
  let started = Date.now();
  let paused: number | null = null;
  const pause = h("button", { onclick: () => {
    if (paused === null) paused = Date.now();
    else {
      started += Date.now() - paused;
      paused = null;
    }
    tick();
  } });
  const presenter = h("div", { class: "presenter" },
    h("header", null, counter, h("div", { class: "timer-group" }, timer, pause,
      h("button", { title: t("Reset timer"), onclick: () => ((started = Date.now()), paused !== null && (paused = started), tick()) }, t("Reset"))),
      time, h("button", { class: "end", onclick: () => void emit("present:end") }, t("End presentation"))),
    h("div", { class: "presenter-body" }, h("div", { class: "now" }, current), h("div", { class: "side" }, h("p", null, t("Next")), next, h("p", { class: "notes-title" }, t("Notes")), notes)),
  );
  presenter.hidden = role === "audience";
  if (role === "audience") root.append(stage, blank);
  root.append(presenter);

  const tick = () => {
    const elapsed = (paused ?? Date.now()) - started;
    timer.textContent = clock(elapsed);
    pause.textContent = paused === null ? t("Pause") : t("Resume");
    time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };
  window.setInterval(tick, 1000);
  tick();

  const render = async () => {
    const mine = ++generation;
    counter.textContent = `${nav.index + 1} / ${nav.count}${nav.digits ? ` → ${nav.digits}` : ""}`;
    blank.className = `blank ${nav.blank ?? ""}`;
    if (role === "audience") await draw(doc, nav.index, stage, "slide");
    if (!presenter.hidden && mine === generation) {
      await draw(doc, nav.index, current, "slide");
      await draw(doc, nav.index + 1, next, "slide");
      const hasNotes = await draw(doc, nav.index, notes, "notes");
      presenter.classList.toggle("with-notes", hasNotes);
    }
  };

  const apply = (state: Nav) => {
    nav = state;
    void render();
    void emit("present:state", { from: me, index: nav.index, blank: nav.blank } satisfies State);
  };
  await listen<State>("present:state", (e) => {
    if (e.payload.from === me) return;
    nav = { ...nav, index: e.payload.index, blank: e.payload.blank, digits: "" };
    void render();
  });
  await listen<{ pdf: string }>("present:reload", async (e) => {
    const old = task;
    task = await load(e.payload.pdf);
    doc = await task.promise;
    nav = withCount(nav, doc.numPages);
    void old.destroy();
    void render();
  });
  await listen("present:end", async () => {
    await emit("present:ended");
    await getCurrentWindow().destroy();
  });

  document.addEventListener("keydown", (e) => {
    if (role === "audience" && screens === 1 && (e.key === "p" || e.key === "P")) {
      presenter.hidden = !presenter.hidden;
      void render();
      return;
    }
    const result = navigate(nav, e.key);
    if (result === null) return;
    e.preventDefault();
    if (result === "end") void emit("present:end");
    else apply(result);
  });
  stage.addEventListener("click", () => apply(navigate(nav, "ArrowRight") as Nav));
  let idle: number | undefined;
  document.addEventListener("mousemove", () => {
    document.documentElement.classList.remove("idle");
    window.clearTimeout(idle);
    idle = window.setTimeout(() => document.documentElement.classList.add("idle"), 2000);
  });
  new ResizeObserver(() => void render()).observe(root);
  void getCurrentWindow().onCloseRequested(() => void emit("present:end"));
  await render();
}
