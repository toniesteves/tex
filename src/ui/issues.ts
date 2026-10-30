// The Issues panel: errors, warnings and notes (bad boxes, reruns) with a filter, and the raw TeX log.
import { t } from "../i18n";
import type { Diagnostic, Severity } from "../latex/log";
import type { Project } from "../project";
import { basename, h } from "../util";
import { icon } from "./icons";

const ICONS: Record<Severity, string> = { error: "error", warning: "warning", info: "info" };

export class IssuesPanel {
  readonly el = h("section", { class: "issues", hidden: true });
  private tab: "issues" | "log" = "issues";
  private hidden = new Set<Severity>();

  constructor(private readonly project: Project, private readonly jump: (d: Diagnostic) => void, private readonly close: () => void) {
    project.events.on("diagnostics", () => this.render());
    project.events.on("compile", () => this.tab === "log" && this.render());
    this.render();
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  showLog(): void {
    this.tab = "log";
    this.render();
  }

  private render(): void {
    if (this.el.hidden) return;
    const all = this.project.diagnostics;
    const count = (s: Severity) => all.filter((d) => d.severity === s).length;
    const tabs = (["issues", "log"] as const).map((tab) =>
      h("button", { class: `segment${this.tab === tab ? " active" : ""}`, onclick: () => ((this.tab = tab), this.render()) },
        tab === "issues" ? t("Issues") : t("Log")),
    );
    const filters = (["error", "warning", "info"] as const).map((s) =>
      h("button", {
        class: `chip ${s}${this.hidden.has(s) ? "" : " on"}`,
        onclick: () => {
          if (!this.hidden.delete(s)) this.hidden.add(s);
          this.render();
        },
      }, icon(ICONS[s], 13), String(count(s))),
    );
    const header = h("header", null, h("div", { class: "segmented small" }, tabs), this.tab === "issues" ? h("div", { class: "chips" }, filters) : null,
      h("button", { class: "icon-button", title: t("Close"), onclick: this.close }, icon("close", 14)));
    let body: HTMLElement;
    if (this.tab === "log") {
      body = h("pre", { class: "log-view" }, this.project.log || t("No log yet."));
    } else {
      const shown = all.filter((d) => !this.hidden.has(d.severity));
      body = shown.length
        ? h("ul", { class: "issue-list" }, shown.map((d) => h("li", { class: `issue ${d.severity}`, onclick: () => this.jump(d), title: d.detail ?? "" },
            icon(ICONS[d.severity], 14), h("span", { class: "issue-message" }, d.message),
            h("span", { class: "issue-place" }, d.line ? `${basename(d.path)}:${d.line}` : basename(d.path)))))
        : h("p", { class: "empty" }, all.length ? t("No issues match the filter.") : t("No issues."));
    }
    this.el.replaceChildren(header, body);
  }

  toggle(show = this.el.hidden): void {
    this.el.hidden = !show;
    this.render();
  }
}
