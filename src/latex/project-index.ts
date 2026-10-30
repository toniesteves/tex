// The project index: a walk from the root file through \input, \include, \subfile and \import, in document order.
// It gives the outline across files (an included file's headings appear where it is included), every label, reference
// and citation with its position, the bibliography, user-defined commands and environments, and the word count.
import { t } from "../i18n";
import { dirname, joinPath } from "../util";
import { parseBib, type BibEntry } from "./bib";
import type { Diagnostic } from "./log";
import { countWords, scan, type CustomCommand, type FileScan, type HeadingKind, type Include, type KeyUse, type Label } from "./scan";

export interface OutlineNode {
  kind: HeadingKind | "label";
  title: string;
  level: number;
  path: string;
  line: number;
  children: OutlineNode[];
}

export interface ProjectIndex {
  main: string;
  files: string[];
  outline: OutlineNode[];
  labels: (Label & { path: string })[];
  refs: (KeyUse & { path: string })[];
  cites: (KeyUse & { path: string })[];
  bibliography: Map<string, BibEntry>;
  bibFiles: string[];
  hasBibliography: boolean;
  commands: CustomCommand[];
  environments: string[];
  documentClass?: string;
  program?: string;
  externalDocument: boolean;
  words: number;
}

/** Reads a file of the project (unsaved text for open buffers); null when it does not exist. */
export type Reader = (path: string) => Promise<string | null>;

const TEX_INCLUDES = new Set<Include["kind"]>(["input", "include", "subfile", "import", "subimport"]);

/** The files an include may name, in the order TeX tries them. */
export function includeCandidates(inc: Include, mainDir: string, fileDir: string): string[] {
  const withTex = (base: string, arg: string): string[] =>
    arg.endsWith(".tex") ? [joinPath(base, arg)] : [joinPath(base, `${arg}.tex`), joinPath(base, arg)];
  switch (inc.kind) {
    case "input":
      return withTex(mainDir, inc.arg);
    case "include":
      return [joinPath(mainDir, `${inc.arg}.tex`)];
    case "subfile":
      return withTex(fileDir, inc.arg);
    case "import":
      return withTex(joinPath(mainDir, inc.dir ?? ""), inc.arg);
    case "subimport":
      return withTex(joinPath(fileDir, inc.dir ?? ""), inc.arg);
    case "bibliography":
      return [joinPath(mainDir, inc.arg.endsWith(".bib") ? inc.arg : `${inc.arg}.bib`)];
    case "addbibresource":
      return [joinPath(mainDir, inc.arg)];
  }
}

interface FlatItem {
  kind: OutlineNode["kind"];
  title: string;
  level: number;
  path: string;
  line: number;
}

export async function buildIndex(main: string, read: Reader): Promise<ProjectIndex> {
  const mainDir = dirname(main);
  const index: ProjectIndex = {
    main, files: [], outline: [], labels: [], refs: [], cites: [], bibliography: new Map(), bibFiles: [],
    hasBibliography: false, commands: [], environments: [], externalDocument: false, words: 0,
  };
  const visited = new Set<string>();
  const bibItems: string[] = [];

  const visit = async (path: string, text: string): Promise<FlatItem[]> => {
    visited.add(path);
    index.files.push(path);
    const s: FileScan = scan(text);
    if (path === main) {
      index.documentClass = s.documentClass;
      index.program = s.magicProgram;
      const begin = s.beginDocument >= 0 ? s.beginDocument : 0;
      const end = text.indexOf("\\end{document}", begin);
      index.words += countWords(text.slice(begin, end < 0 ? undefined : end));
    } else {
      index.words += countWords(text);
    }
    index.labels.push(...s.labels.map((l) => ({ ...l, path })));
    index.refs.push(...s.refs.map((r) => ({ ...r, path })));
    index.cites.push(...s.cites.map((c) => ({ ...c, path })));
    index.commands.push(...s.commands);
    index.environments.push(...s.environments);
    index.externalDocument ||= s.externalDocument;
    bibItems.push(...s.bibitems);

    type Event = { offset: number; item?: FlatItem; include?: Include };
    const events: Event[] = [
      ...s.headings.map((h) => ({ offset: h.offset, item: { kind: h.kind, title: h.title, level: h.level, path, line: h.line } })),
      ...s.labels.map((l) => ({ offset: l.offset, item: { kind: "label" as const, title: l.key, level: 99, path, line: l.line } })),
      ...s.includes.map((inc) => ({ offset: inc.offset, include: inc })),
    ].sort((a, b) => a.offset - b.offset);

    const flat: FlatItem[] = [];
    for (const event of events) {
      if (event.item) {
        flat.push(event.item);
        continue;
      }
      const inc = event.include!;
      for (const candidate of includeCandidates(inc, mainDir, dirname(path))) {
        if (TEX_INCLUDES.has(inc.kind) && visited.has(candidate)) break;
        const included = await read(candidate);
        if (included === null) continue;
        if (TEX_INCLUDES.has(inc.kind)) {
          flat.push(...(await visit(candidate, included)));
        } else {
          index.bibFiles.push(candidate);
          for (const entry of parseBib(included)) index.bibliography.set(entry.key, entry);
        }
        break;
      }
      if (!TEX_INCLUDES.has(inc.kind)) index.hasBibliography = true;
    }
    return flat;
  };

  const text = await read(main);
  if (text === null) return index;
  index.outline = nest(await visit(main, text));
  for (const key of bibItems) if (!index.bibliography.has(key)) index.bibliography.set(key, { key, type: "bibitem" });
  index.hasBibliography ||= bibItems.length > 0;
  return index;
}

/** Headings nest by level (a deeper heading becomes a child of the nearest shallower one); labels are leaves. */
function nest(flat: FlatItem[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const item of flat) {
    const node: OutlineNode = { ...item, children: [] };
    if (item.kind !== "label") while (stack.length && stack.at(-1)!.level >= item.level) stack.pop();
    (stack.at(-1)?.children ?? roots).push(node);
    if (item.kind !== "label") stack.push(node);
  }
  return roots;
}

/**
 * Live warnings computed from the index: references to labels that do not exist (unless the project uses `xr`), labels
 * defined more than once, and citations missing from the bibliography (only once the project has a bibliography).
 */
export function referenceDiagnostics(index: ProjectIndex): Diagnostic[] {
  const found: Diagnostic[] = [];
  const definitions = new Map<string, ProjectIndex["labels"]>();
  for (const label of index.labels) definitions.set(label.key, [...(definitions.get(label.key) ?? []), label]);
  const at = (use: KeyUse & { path: string }) => ({ path: use.path, line: use.line, column: use.column, length: use.length, source: "reference" as const });

  if (!index.externalDocument) {
    for (const ref of index.refs) {
      if (!definitions.has(ref.key)) found.push({ severity: "warning", message: t("Reference ‘{key}’ is not defined", { key: ref.key }), ...at(ref) });
    }
  }
  for (const [key, labels] of definitions) {
    if (labels.length < 2) continue;
    for (const label of labels) {
      const others = labels.filter((l) => l !== label).map((l) => `${l.path.slice(l.path.lastIndexOf("/") + 1)}:${l.line}`);
      found.push({
        severity: "warning", message: t("Label ‘{key}’ is defined more than once", { key }), detail: others.join(", "),
        path: label.path, line: label.line, column: label.column, length: key.length, source: "reference",
      });
    }
  }
  if (index.hasBibliography) {
    for (const cite of index.cites) {
      if (!index.bibliography.has(cite.key)) found.push({ severity: "warning", message: t("Citation ‘{key}’ is not in the bibliography", { key: cite.key }), ...at(cite) });
    }
  }
  return found;
}
