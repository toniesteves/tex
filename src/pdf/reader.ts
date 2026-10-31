// The detached PDF: a window of its own (opened with `?view=reader`) that shows only the PDF, to read it maximized.
// It follows recompiles of its project, keeping the reading position.
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { locale, t } from "../i18n";
import { readBytes } from "../ipc";
import { icon } from "../ui/icons";
import { basename, h, hashString } from "../util";
import { PdfViewer } from "./viewer";

const RELOAD = "reader:reload";
const label = (root: string) => `reader-${hashString(root)}`;

/** Zoom and page controls, shared by the PDF pane and the detached window. */
export function pdfControls(v: PdfViewer): HTMLElement[] {
  return [
    h("button", { title: t("Zoom out"), onclick: () => v.zoomOut() }, icon("minus", 14)),
    h("button", { class: "zoom", title: t("Fit width"), onclick: () => v.fitWidth() }, `${Math.round(v.scale * 100).toLocaleString(locale)}%`),
    h("button", { title: t("Zoom in"), onclick: () => v.zoomIn() }, icon("plus", 14)),
    h("button", { title: t("Fit width"), class: v.isFit ? "active" : "", onclick: () => v.fitWidth() }, icon("fit", 14)),
    h("span", { class: "page" }, `${v.currentPage} / ${v.pageCount}`),
  ];
}

/** Opens the project's detached PDF, or brings it to the front when already open. */
export async function openReader(root: string, name: string, pdf: string): Promise<void> {
  const existing = await WebviewWindow.getByLabel(label(root));
  if (existing) return void existing.setFocus();
  new WebviewWindow(label(root), { url: `/?view=reader&pdf=${encodeURIComponent(pdf)}`, title: `${name} — ${basename(pdf)}`, width: 900, height: 1000 });
}

/** After a recompile; nothing happens when the project has no detached PDF. */
export function reloadReader(root: string, pdf: string): void {
  void getCurrentWebviewWindow().emitTo(label(root), RELOAD, pdf);
}

export async function closeReader(root: string): Promise<void> {
  await (await WebviewWindow.getByLabel(label(root)))?.close();
}

export async function bootReader(root: HTMLElement, pdf: string): Promise<void> {
  const viewer = new PdfViewer();
  const controls = h("div", { class: "pdf-controls" });
  viewer.onChange = () => controls.replaceChildren(...pdfControls(viewer));
  root.replaceChildren(h("div", { class: "pdf-pane reader" }, viewer.el, controls));
  const load = async (path: string) => viewer.load(await readBytes(path)).catch((e) => console.error("PDF not shown", e));
  void getCurrentWebviewWindow().listen<string>(RELOAD, (e) => void load(e.payload));
  await load(pdf);
  viewer.el.focus();
}
