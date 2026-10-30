// PDF preview with pdf.js. Pages render lazily as they scroll into view; a reload keeps the reading position and the
// old page stays on screen until the new one is drawn (no flash). Text can be selected, links work, and SyncTeX
// positions are highlighted, narrowed down to the exact word when it can be found in the text layer.
import { getDocument, GlobalWorkerOptions, PDFWorker, TextLayer, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy, type PageViewport } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { openExternal, type SyncBox } from "../ipc";
import { h } from "../util";

GlobalWorkerOptions.workerSrc = workerUrl;

/** One worker for every document: a live compile reloads the PDF often, and starting a worker is not free. */
let sharedWorker: PDFWorker | null = null;
export const pdfWorker = (): PDFWorker => (sharedWorker ??= new PDFWorker());

interface Page {
  el: HTMLDivElement;
  proxy: PDFPageProxy;
  /** The page at scale 1 (PDF points). */
  base: PageViewport;
  /** The scale of the canvas on screen, 0 when there is none. */
  rendered: number;
  rendering: boolean;
}

export interface SyncClick {
  page: number;
  /** PDF points from the top-left corner of the page. */
  x: number;
  y: number;
  word: string | null;
  before: string;
  after: string;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const GAP = 12;
/** Pages kept drawn around the visible ones; farther canvases are dropped to save memory. */
const KEEP = 6;

const normalized = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export class PdfViewer {
  readonly el = h("div", { class: "pdf-scroll", tabindex: "0" });
  private pagesEl = h("div", { class: "pdf-pages" });
  private doc: PDFDocumentProxy | null = null;
  private task: PDFDocumentLoadingTask | null = null;
  private pages: Page[] = [];
  private zoom: number | "fit" = "fit";
  private visible = new Set<number>();
  private observer: IntersectionObserver;
  private generation = 0;
  onSyncClick: ((click: SyncClick) => void) | null = null;
  /** Page, zoom or document changed. */
  onChange: (() => void) | null = null;
  syncTrigger: "dblclick" | "ctrlclick" = "dblclick";

  constructor() {
    this.el.append(this.pagesEl);
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.index);
          if (entry.isIntersecting) this.visible.add(index);
          else this.visible.delete(index);
        }
        this.renderVisible();
      },
      { root: this.el, rootMargin: "50% 0px" },
    );
    new ResizeObserver(() => this.zoom === "fit" && requestAnimationFrame(() => this.relayout())).observe(this.el);
    this.el.addEventListener("scroll", () => this.onChange?.(), { passive: true });
    this.el.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        this.setZoom(this.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      },
      { passive: false },
    );
    this.el.addEventListener("dblclick", (e) => this.syncTrigger === "dblclick" && this.syncAt(e));
    this.el.addEventListener("click", (e) => this.syncTrigger === "ctrlclick" && e.ctrlKey && this.syncAt(e));
  }

  get pageCount(): number {
    return this.pages.length;
  }

  get loaded(): boolean {
    return this.doc !== null;
  }

  get isFit(): boolean {
    return this.zoom === "fit";
  }

  get scale(): number {
    if (this.zoom !== "fit") return this.zoom;
    const widest = Math.max(1, ...this.pages.map((p) => p.base.width));
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (this.el.clientWidth - 2 * GAP) / widest));
  }

  /** The page under the upper third of the viewport (1-based). */
  get currentPage(): number {
    const mark = this.el.scrollTop + this.el.clientHeight / 3;
    const index = this.pages.findIndex((p) => p.el.offsetTop + p.el.offsetHeight > mark);
    return this.pages.length ? (index < 0 ? this.pages.length : index + 1) : 0;
  }

  async load(data: Uint8Array): Promise<void> {
    const generation = ++this.generation;
    const anchor = this.anchor();
    const task = getDocument({ data, useSystemFonts: true, worker: pdfWorker() });
    const doc = await task.promise;
    const proxies = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
    if (generation !== this.generation) {
      void task.destroy();
      return;
    }
    const old = this.task;
    this.doc = doc;
    this.task = task;
    proxies.forEach((proxy, i) => {
      const page = this.pages[i];
      const base = proxy.getViewport({ scale: 1 });
      if (page) {
        Object.assign(page, { proxy, base, rendered: 0 });
        page.el.querySelectorAll(".textLayer, .pdf-links").forEach((layer) => layer.remove());
      } else {
        const el = h("div", { class: "pdf-page", dataset: { index: String(i) } });
        this.pages.push({ el, proxy, base, rendered: 0, rendering: false });
        this.pagesEl.append(el);
        this.observer.observe(el);
      }
    });
    for (const page of this.pages.splice(proxies.length)) {
      this.observer.unobserve(page.el);
      this.visible.delete(Number(page.el.dataset.index));
      page.el.remove();
    }
    this.relayout(anchor);
    void old?.destroy();
  }

  clear(): void {
    this.generation++;
    void this.task?.destroy();
    this.doc = null;
    this.task = null;
    for (const page of this.pages) this.observer.unobserve(page.el);
    this.pages = [];
    this.visible.clear();
    this.pagesEl.replaceChildren();
    this.onChange?.();
  }

  zoomIn(): void {
    this.setZoom(this.scale * 1.2);
  }

  zoomOut(): void {
    this.setZoom(this.scale / 1.2);
  }

  fitWidth(): void {
    const anchor = this.anchor();
    this.zoom = "fit";
    this.relayout(anchor);
  }

  setZoom(scale: number): void {
    const anchor = this.anchor();
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
    this.relayout(anchor);
  }

  goToPage(n: number): void {
    const page = this.pages[Math.min(Math.max(n, 1), this.pages.length) - 1];
    if (page) this.el.scrollTop = page.el.offsetTop - GAP;
  }

  /** Where the reader is: a page and how far down it, independent of the zoom. */
  private anchor(): { index: number; fraction: number } {
    const top = this.el.scrollTop;
    const index = Math.max(0, this.pages.findIndex((p) => p.el.offsetTop + p.el.offsetHeight > top));
    const page = this.pages[index];
    return { index, fraction: page ? (top - page.el.offsetTop) / Math.max(1, page.el.offsetHeight) : 0 };
  }

  private relayout(anchor = this.anchor()): void {
    const scale = this.scale;
    for (const page of this.pages) {
      page.el.style.width = `${Math.floor(page.base.width * scale)}px`;
      page.el.style.height = `${Math.floor(page.base.height * scale)}px`;
      page.el.style.setProperty("--total-scale-factor", String(scale));
    }
    const page = this.pages[Math.min(anchor.index, this.pages.length - 1)];
    if (page) this.el.scrollTop = page.el.offsetTop + anchor.fraction * page.el.offsetHeight;
    this.renderVisible();
    this.onChange?.();
  }

  private renderVisible(): void {
    const scale = this.scale;
    const visible = [...this.visible].sort((a, b) => a - b);
    for (const index of visible) {
      const page = this.pages[index];
      if (page && page.rendered !== scale && !page.rendering) void this.render(page, scale);
    }
    const [first = 0, last = 0] = [visible[0], visible.at(-1)];
    this.pages.forEach((page, i) => {
      if (page.rendered && (i < first - KEEP || i > last + KEEP)) {
        page.el.querySelector("canvas")?.remove();
        page.rendered = 0;
      }
    });
  }

  private async render(page: Page, scale: number): Promise<void> {
    page.rendering = true;
    const generation = this.generation;
    const proxy = page.proxy;
    try {
      const viewport = proxy.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      const canvas = h("canvas", { width: Math.floor(viewport.width * ratio), height: Math.floor(viewport.height * ratio) });
      await proxy.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }).promise;
      if (generation !== this.generation || proxy !== page.proxy || scale !== this.scale) return;
      const old = page.el.querySelector("canvas");
      if (old) old.replaceWith(canvas);
      else page.el.prepend(canvas);
      page.rendered = scale;
      page.el.querySelectorAll(".textLayer, .pdf-links").forEach((layer) => layer.remove());
      await this.renderLayers(page, viewport);
    } catch {
      // the document was replaced or destroyed while rendering
    } finally {
      page.rendering = false;
      if (this.visible.has(this.pages.indexOf(page)) && page.rendered !== this.scale) this.renderVisible();
    }
  }

  private async renderLayers(page: Page, viewport: PageViewport): Promise<void> {
    const text = h("div", { class: "textLayer" });
    page.el.append(text);
    await new TextLayer({ textContentSource: page.proxy.streamTextContent(), container: text, viewport }).render();
    const links = h("div", { class: "pdf-links" });
    for (const annotation of await page.proxy.getAnnotations()) {
      if (annotation.subtype !== "Link" || (!annotation.url && !annotation.dest)) continue;
      const [x1, y1] = viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]) as number[];
      const [x2, y2] = viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]) as number[];
      const link = h("a", {
        class: "pdf-link",
        title: annotation.url ?? "",
        style: `left:${Math.min(x1!, x2!)}px;top:${Math.min(y1!, y2!)}px;width:${Math.abs(x2! - x1!)}px;height:${Math.abs(y2! - y1!)}px`,
      });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        if (annotation.url) void openExternal(annotation.url);
        else void this.goToDestination(annotation.dest);
      });
      links.append(link);
    }
    page.el.append(links);
  }

  private async goToDestination(dest: string | unknown[]): Promise<void> {
    const doc = this.doc;
    const explicit = typeof dest === "string" ? await doc?.getDestination(dest) : dest;
    if (!doc || !explicit) return;
    const ref = explicit[0];
    const index = typeof ref === "number" ? ref : await doc.getPageIndex(ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
    const page = this.pages[index];
    if (!page) return;
    const top = (explicit[1] as { name?: string })?.name === "XYZ" && typeof explicit[3] === "number" ? explicit[3] : page.base.viewBox[3]!;
    const [, y] = page.base.convertToViewportPoint(0, top as number) as number[];
    this.el.scrollTop = page.el.offsetTop + y! * this.scale - GAP;
  }

  private syncAt(e: MouseEvent): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".pdf-page");
    const page = el && this.pages[Number(el.dataset.index)];
    if (!el || !page) return;
    const rect = el.getBoundingClientRect();
    const scale = rect.width / page.base.width;
    this.onSyncClick?.({
      page: Number(el.dataset.index) + 1,
      x: (e.clientX - rect.left) / scale,
      y: (e.clientY - rect.top) / scale,
      ...wordAtPoint(e.clientX, e.clientY),
    });
  }

  /** Highlights SyncTeX boxes (only the word, when it is found inside or near them) and scrolls them into the centre. */
  async highlight(boxes: SyncBox[], word: string | null): Promise<void> {
    const first = boxes[0];
    const page = first && this.pages[first.page - 1];
    if (!first || !page) return;
    if (page.rendered !== this.scale) await this.render(page, this.scale);
    const scale = this.scale;
    let rects = boxes
      .filter((b) => b.page === first.page)
      .map((b) => ({ x: b.x * scale, y: b.y * scale, w: Math.max(b.width * scale, 6), h: Math.max(b.height * scale, 6) }));
    const precise = word ? findWord(page.el, word, rects) : null;
    if (precise) rects = [precise];
    for (const r of rects) {
      const mark = h("div", { class: "sync-mark", style: `left:${r.x - 2}px;top:${r.y - 2}px;width:${r.w + 4}px;height:${r.h + 4}px` });
      page.el.append(mark);
      window.setTimeout(() => mark.remove(), 1700);
    }
    const target = rects[0]!;
    this.el.scrollTo({ top: page.el.offsetTop + target.y - this.el.clientHeight / 2, behavior: "smooth" });
  }
}

/** The word of the text layer under a point, with some text on each side for matching it in the source. */
function wordAtPoint(x: number, y: number): { word: string | null; before: string; after: string } {
  const doc = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null };
  const position = doc.caretPositionFromPoint?.(x, y);
  const range = position ? null : document.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? range?.startContainer;
  const offset = position?.offset ?? range?.startOffset ?? 0;
  if (!node || node.nodeType !== Node.TEXT_NODE || !node.parentElement?.closest(".textLayer")) return { word: null, before: "", after: "" };
  const text = node.textContent ?? "";
  const left = /[\p{L}\p{N}]*$/u.exec(text.slice(0, offset))![0];
  const right = /^[\p{L}\p{N}]*/u.exec(text.slice(offset))![0];
  const start = offset - left.length;
  const end = offset + right.length;
  return { word: left + right || null, before: text.slice(Math.max(0, start - 40), start), after: text.slice(end, end + 40) };
}

/** The occurrence of `word` in the text layer closest to the SyncTeX boxes (page coordinates), if any is near them. */
function findWord(pageEl: HTMLElement, word: string, boxes: { x: number; y: number; w: number; h: number }[]) {
  const origin = pageEl.getBoundingClientRect();
  const wanted = normalized(word);
  let best: { x: number; y: number; w: number; h: number; d: number } | null = null;
  for (const span of pageEl.querySelectorAll<HTMLElement>(".textLayer span")) {
    const node = span.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) continue;
    const text = normalized(node.textContent ?? "");
    for (let i = text.indexOf(wanted); i >= 0; i = text.indexOf(wanted, i + 1)) {
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, Math.min(i + word.length, node.textContent!.length));
      const r = range.getBoundingClientRect();
      const rect = { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
      const d = Math.min(
        ...boxes.map((b) => Math.abs(rect.y + rect.h / 2 - (b.y + b.h / 2)) * 3 + Math.max(0, b.x - rect.x, rect.x - (b.x + b.w))),
      );
      if (d < Math.max(40, boxes[0]!.h * 4) && (!best || d < best.d)) best = { ...rect, d };
    }
  }
  return best;
}
