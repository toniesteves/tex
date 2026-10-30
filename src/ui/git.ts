// The Git panel of the sidebar: the branch, the history with its graph, a commit of every change (after saving the open
// files), push and pull through the system's git. Pulling needs a clean tree, so other people's commits never mix
// with uncommitted work.
import { locale, t, tn } from "../i18n";
import * as ipc from "../ipc";
import type { Project } from "../project";
import { settings } from "../settings";
import { ago, basename, dirname, h } from "../util";
import { alert, ask, prompt, toast } from "./dialogs";
import { layoutGraph, type GraphRow } from "./git-graph";
import { fileIcon, icon } from "./icons";

const LANE = 12;
const ROW = 36;
const COLORS = ["var(--accent)", "var(--ok)", "var(--warning)", "var(--hl-command)", "var(--hl-environment)", "var(--error)"];
const laneX = (lane: number) => LANE / 2 + lane * LANE + 2;
const laneColor = (lane: number) => COLORS[lane % COLORS.length]!;

function svg(width: number, height: number, body: string, stretch = false): SVGSVGElement {
  const holder = document.createElement("span");
  holder.innerHTML = `<svg class="git-graph" width="${width}" height="${stretch ? "100%" : height}" viewBox="0 0 ${width} ${height}"${stretch ? ' preserveAspectRatio="none"' : ""} fill="none" stroke-width="2" aria-hidden="true">${body}</svg>`;
  return holder.firstElementChild as SVGSVGElement;
}

const line = (d: string, lane: number) => `<path d="${d}" stroke="${laneColor(lane)}" vector-effect="non-scaling-stroke"/>`;

/** The graph next to a commit: its dot, its lane, branches passing by, meeting in it or forking from a merge. */
function graphCell(row: GraphRow, width: number, merge: boolean): SVGSVGElement {
  const [x, mid] = [laneX(row.lane), ROW / 2];
  const color = laneColor(row.lane);
  return svg(width, ROW, [
    ...row.through.map((i) => line(`M${laneX(i)} 0V${ROW}`, i)),
    ...row.joins.map((i) => line(`M${laneX(i)} 0Q${laneX(i)} ${mid} ${x} ${mid}`, i)),
    ...row.forks.map((i) => line(`M${x} ${mid}Q${laneX(i)} ${mid} ${laneX(i)} ${ROW}`, i)),
    row.fromAbove ? line(`M${x} 0V${mid}`, row.lane) : "",
    row.down ? line(`M${x} ${mid}V${ROW}`, row.lane) : "",
    merge
      ? `<circle cx="${x}" cy="${mid}" r="3.5" fill="var(--bg-sidebar)" stroke="${color}"/>`
      : `<circle cx="${x}" cy="${mid}" r="4" fill="${color}" stroke="none"/>`,
  ].join(""));
}

/** The lanes going on beside an open commit's details. */
const continuation = (lanes: number[], width: number) => svg(width, 10, lanes.map((i) => line(`M${laneX(i)} 0V10`, i)).join(""), true);

/** A letter, a title and a class for a porcelain status code. */
function kind(code: string): [string, string, string] {
  if (code.includes("U") || code === "AA" || code === "DD") return ["!", t("Conflict"), "conflict"];
  if (code === "??" || code.includes("A")) return ["A", t("New"), "added"];
  if (code.includes("D")) return ["D", t("Deleted"), "deleted"];
  if (code.includes("R")) return ["R", t("Renamed"), "renamed"];
  return ["M", t("Modified"), "modified"];
}

export class GitPanel {
  readonly el = h("div", { class: "git" });
  /** undefined until the first status arrives, null outside a repository. */
  private status: ipc.GitStatus | null | undefined;
  private error: string | null = null;
  private busy = false;
  private generation = 0;
  private message = h("textarea", { class: "commit-message", rows: 3, placeholder: t("Message (Ctrl+Enter to commit)") });
  /** Kept between renders (it keeps its scroll position) and rebuilt only when the history or the selection changes. */
  private history = h("div", { class: "git-history" });
  private log: ipc.GitCommit[] = [];
  private logKey = "";
  private selected: string | null = null;
  /** Commits never change, so their details are fetched once (a string is an error). */
  private details = new Map<string, ipc.GitCommitDetails | string>();

  constructor(private readonly project: Project) {
    this.message.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.ctrlKey) {
        e.preventDefault();
        void this.commit();
      }
    });
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    try {
      const root = this.project.root;
      const [status, log] = await Promise.all([ipc.gitStatus(root), this.historyOpen ? ipc.gitLog(root) : null]);
      if (generation !== this.generation) return;
      [this.status, this.error] = [status, null];
      const key = log?.map((c) => c.hash + c.refs.join()).join() ?? this.logKey;
      if (log && key !== this.logKey) {
        [this.log, this.logKey] = [log, key];
        this.renderHistory();
      }
    } catch (e) {
      if (generation !== this.generation) return;
      this.error = String(e);
    }
    this.render();
  }

  render(): void {
    const s = this.status;
    const focused = document.activeElement === this.message;
    const scroll = this.history.scrollTop;
    if (this.error) this.el.replaceChildren(h("p", { class: "empty" }, this.error));
    else if (s === undefined) this.el.replaceChildren();
    else if (s === null) {
      this.el.replaceChildren(
        h("p", { class: "empty" }, t("This folder is not a Git repository.")),
        h("button", { class: "git-button wide", disabled: this.busy, onclick: () => void this.init() }, icon("branch", 14), t("Initialize Repository")),
      );
    } else {
      const canCommit = s.changes.length > 0 || s.merging || this.project.dirtyFiles.length > 0;
      this.el.replaceChildren(
        h("div", { class: "git-branch", title: s.upstream ?? "" }, icon("branch", 14),
          h("span", { class: "name" }, s.branch ?? t("Detached HEAD")),
          s.upstream ? h("span", { class: "git-sync", title: t("Commits to push and to pull (as of the last pull)") }, `↑${s.ahead} ↓${s.behind}`) : null),
        h("button", { class: "git-heading git-toggle", onclick: () => this.toggleHistory() },
          h("span", { class: `chevron${this.historyOpen ? " open" : ""}` }, icon("chevron", 12)), t("History")),
        this.history,
        s.hasRemote
          ? h("div", { class: "git-actions" },
            h("button", { class: "git-button", disabled: this.busy, onclick: () => void this.pull() }, icon("arrowDown", 14), t("Pull")),
            h("button", { class: "git-button", disabled: this.busy, onclick: () => void this.push() }, icon("arrowUp", 14), t("Push")))
          : h("button", { class: "git-button wide", disabled: this.busy, onclick: () => void this.addRemote() }, icon("plus", 14), t("Add Remote…")),
        h("p", { class: "git-note", hidden: !s.merging }, icon("warning", 14), t("Resolve the conflicts marked in the files, then commit to finish the merge.")),
        this.message,
        h("div", { class: "git-actions" },
          h("button", { class: "git-button primary", disabled: this.busy || !canCommit, onclick: () => void this.commit() }, icon("check", 14), t("Commit")),
          h("button", { class: "git-button discard", disabled: this.busy || !canCommit, onclick: () => void this.discard(s.merging) }, icon("discard", 14), t("Discard"))),
        h("h3", { class: "git-heading" }, tn(s.changes.length, "{n} change", "{n} changes")),
        s.changes.length ? this.changes(s.changes) : h("p", { class: "empty" }, t("No changes.")),
      );
    }
    this.el.classList.toggle("busy", this.busy);
    this.history.hidden = !this.historyOpen;
    if (focused) this.message.focus();
    this.history.scrollTop = scroll;
  }

  private get historyOpen(): boolean {
    return !settings.project(this.project.root).historyClosed;
  }

  private toggleHistory(): void {
    settings.updateProject(this.project.root, { historyClosed: this.historyOpen });
    if (this.historyOpen) void this.refresh();
    else this.render();
  }

  private renderHistory(): void {
    const scroll = this.history.scrollTop;
    const { rows, width } = layoutGraph(this.log);
    const graphWidth = laneX(Math.max(width, 1) - 1) + LANE / 2 + 2;
    this.history.style.setProperty("--graph", `${graphWidth}px`);
    this.history.replaceChildren(...(this.log.length
      ? this.log.map((commit, i) => this.commitRow(commit, rows[i]!, graphWidth))
      : [h("p", { class: "empty" }, t("No commits yet."))]));
    this.history.scrollTop = scroll;
  }

  private commitRow(commit: ipc.GitCommit, row: GraphRow, graphWidth: number): HTMLElement {
    const open = this.selected === commit.hash;
    return h("div", { class: `git-commit${open ? " open" : ""}` },
      h("div", { class: "git-commit-summary", title: commit.subject, onclick: () => void this.select(commit.hash) },
        graphCell(row, graphWidth, commit.parents.length > 1),
        h("div", { class: "git-commit-text" },
          h("span", { class: "git-commit-subject" }, commit.subject),
          h("span", { class: "git-commit-meta", title: new Date(commit.time * 1000).toLocaleString(locale) },
            commit.refs.map((ref) => h("span", { class: "git-ref" }, ref)),
            h("span", { class: "git-commit-by" }, `${commit.author} · ${ago(commit.time * 1000)}`)))),
      open ? h("div", { class: "git-commit-details" }, continuation(row.below, graphWidth), this.commitDetails(commit)) : null);
  }

  private commitDetails(commit: ipc.GitCommit): HTMLElement {
    const details = this.details.get(commit.hash);
    if (details === undefined) return h("div", { class: "git-commit-body" });
    if (typeof details === "string") return h("div", { class: "git-commit-body" }, h("p", { class: "empty" }, details));
    return h("div", { class: "git-commit-body" },
      h("p", { class: "git-commit-message" }, details.message),
      h("button", {
        class: "git-hash",
        title: t("Copy the hash"),
        onclick: () => void navigator.clipboard.writeText(commit.hash).then(() => toast(t("Copied"))),
      }, commit.hash.slice(0, 10)),
      this.changes(details.files));
  }

  private async select(hash: string): Promise<void> {
    this.selected = this.selected === hash ? null : hash;
    this.renderHistory();
    if (this.selected !== hash || this.details.has(hash)) return;
    this.details.set(hash, await ipc.gitShow(this.project.root, hash).catch((e) => String(e)));
    if (this.selected === hash) this.renderHistory();
  }

  private changes(changes: ipc.GitChange[]): HTMLElement {
    return h("ul", { class: "tree" }, changes.map((change) => {
      const [letter, title, cls] = kind(change.code);
      const path = this.project.relative(change.path);
      return h("li", null,
        h("div", { class: `row git-change ${cls}`, title: `${path} · ${title}`, onclick: () => cls !== "deleted" && void this.project.open(change.path) },
          fileIcon(change.path),
          h("span", { class: "name" }, basename(change.path)),
          h("span", { class: "git-dir" }, path.includes("/") ? dirname(path) : ""),
          h("span", { class: "git-code" }, letter)));
    }));
  }

  /** Runs one git operation at a time, then shows the new status. */
  private async run(task: () => Promise<unknown>, failure: string, success: string): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    this.render();
    let ok = true;
    try {
      await task();
      toast(success);
    } catch (e) {
      ok = false;
      await alert(failure, String(e));
    }
    this.busy = false;
    await this.refresh();
    return ok;
  }

  private async commit(): Promise<void> {
    const message = this.message.value.trim();
    if (!message) return this.message.focus();
    if (this.busy || !(await this.project.saveAll())) return;
    if (await this.run(() => ipc.gitCommit(this.project.root, message), t("The commit failed"), t("Committed"))) this.message.value = "";
  }

  /** Saves the open files first, so unsaved text goes into the stash too. */
  private async discard(merging: boolean): Promise<void> {
    const answer = await ask({
      title: merging ? t("Abort the merge?") : t("Discard all changes?"),
      message: merging
        ? t("The files go back to how they were before the pull, and your conflict resolutions are lost.")
        : t("The files go back to the last commit, and new files are removed. The changes are kept in a Git stash: “git stash pop” in a terminal brings them back."),
      buttons: [{ label: t("Cancel"), value: "cancel" }, { label: merging ? t("Abort Merge") : t("Discard"), value: "discard", danger: true }],
    });
    if (answer !== "discard" || this.busy || !(await this.project.saveAll())) return;
    await this.run(() => ipc.gitDiscard(this.project.root), t("The changes could not be discarded"), merging ? t("Merge aborted") : t("Changes discarded"));
  }

  private async push(): Promise<void> {
    await this.run(() => ipc.gitPush(this.project.root), t("The push failed"), t("Pushed"));
  }

  private async pull(): Promise<void> {
    await this.refresh();
    if (this.project.dirtyFiles.length || this.status?.changes.length) {
      return alert(t("Commit your changes before pulling"), t("Pulling brings in other people's commits. Commit your own first, so the two never get mixed."));
    }
    await this.run(() => ipc.gitPull(this.project.root), t("The pull stopped"), t("Pulled"));
  }

  private async init(): Promise<void> {
    await this.run(() => ipc.gitInit(this.project.root), t("The repository could not be created"), t("Repository created"));
  }

  private async addRemote(): Promise<void> {
    const url = await prompt({ title: t("Add Remote"), label: t("Repository address (GitHub, GitLab or a folder)"), ok: t("Add") });
    if (url) await this.run(() => ipc.gitAddRemote(this.project.root, url), t("The remote could not be added"), t("Remote added"));
  }
}
