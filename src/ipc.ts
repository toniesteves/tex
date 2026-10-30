// Typed wrappers for the Rust commands (src-tauri/src). Paths are absolute; lines and columns are 1-based.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Encoding = "utf-8" | "utf-8-bom" | "latin-1";
export type Engine = "pdflatex" | "xelatex" | "lualatex";

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileNode[];
}

export interface TextFile {
  text: string;
  encoding: Encoding;
}

export interface Overlay {
  path: string;
  text: string;
  encoding: Encoding;
}

export interface CompileResult {
  status: "ok" | "failed" | "cancelled" | "error";
  pdf?: string;
  pdfUpdated: boolean;
  log: string;
  bibtexLog?: string;
  cwd: string;
  overlays: Record<string, string>;
  durationMs: number;
  message?: string;
}

/** PDF points from the top-left corner of the page. */
export interface SyncBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SourceLocation {
  path: string;
  line: number;
  column?: number;
}

export interface TexInfo {
  distribution?: string;
  tools: Record<string, boolean>;
}

export const listTree = (root: string) => invoke<FileNode[]>("list_tree", { root });
export const readText = (path: string) => invoke<TextFile>("read_text", { path });
export const writeText = (path: string, text: string, encoding: Encoding) => invoke<void>("write_text", { path, text, encoding });
export const readBytes = async (path: string) => new Uint8Array(await invoke<ArrayBuffer>("read_bytes", { path }));
export const createFile = (path: string) => invoke<void>("create_file", { path });
export const createDir = (path: string) => invoke<void>("create_dir", { path });
export const renamePath = (from: string, to: string) => invoke<void>("rename_path", { from, to });
export const duplicatePath = (path: string, suffix: string) => invoke<string>("duplicate_path", { path, suffix });
export const trashPath = (path: string) => invoke<void>("trash_path", { path });
export const revealPath = (path: string) => invoke<void>("reveal_path", { path });
export const openExternal = (target: string) => invoke<void>("open_external", { target });

export const compile = (request: { root: string; main: string; engine: Engine; overlays: Overlay[]; export: boolean }) =>
  invoke<CompileResult>("compile", { request });
export const cancelCompile = (root: string) => invoke<void>("cancel_compile", { root });
export const cleanCache = (root: string) => invoke<void>("clean_cache", { root });
export const detectTex = () => invoke<TexInfo>("detect_tex");

export const synctexForward = (root: string, pdf: string, path: string, line: number, column: number) =>
  invoke<SyncBox[]>("synctex_forward", { root, pdf, path, line, column });
export const synctexInverse = (root: string, pdf: string, page: number, x: number, y: number) =>
  invoke<SourceLocation | null>("synctex_inverse", { root, pdf, page, x, y });

export const watchProject = (root: string) => invoke<void>("watch_project", { root });
export const unwatchProject = (root: string) => invoke<void>("unwatch_project", { root });
export const onFsChanged = (fn: (root: string, paths: string[]) => void): Promise<UnlistenFn> =>
  listen<{ root: string; paths: string[] }>("fs-changed", (e) => fn(e.payload.root, e.payload.paths));

export interface GitChange {
  path: string;
  /** The two-letter code of `git status --porcelain`. */
  code: string;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  merging: boolean;
  changes: GitChange[];
}

export const gitStatus = (root: string) => invoke<GitStatus | null>("git_status", { root });
export const gitInit = (root: string) => invoke<void>("git_init", { root });
export const gitAddRemote = (root: string, url: string) => invoke<void>("git_add_remote", { root, url });
export const gitCommit = (root: string, message: string) => invoke<void>("git_commit", { root, message });
export const gitDiscard = (root: string) => invoke<void>("git_discard", { root });
export const gitPush = (root: string) => invoke<void>("git_push", { root });
export const gitPull = (root: string) => invoke<void>("git_pull", { root });
export const gitClone = (url: string, parent: string) => invoke<string>("git_clone", { url, parent });

export interface GitCommit {
  hash: string;
  parents: string[];
  author: string;
  /** Unix seconds. */
  time: number;
  refs: string[];
  subject: string;
}

export interface GitCommitDetails {
  message: string;
  files: GitChange[];
}

export const gitLog = (root: string) => invoke<GitCommit[]>("git_log", { root });
export const gitShow = (root: string, hash: string) => invoke<GitCommitDetails>("git_show", { root, hash });
