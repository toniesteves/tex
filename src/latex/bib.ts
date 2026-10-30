// BibTeX / BibLaTeX databases: entry keys plus the fields shown next to citation completions.

export interface BibEntry {
  key: string;
  type: string;
  title?: string;
  author?: string;
  year?: string;
}

const IGNORED = new Set(["comment", "string", "preamble"]);

/** The value of `field = {…}`, `"…"` or a bare word, from `body`. */
function field(body: string, name: string): string | undefined {
  const at = new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*`, "i").exec(body);
  if (!at) return undefined;
  let i = at.index + at[0].length;
  let value = "";
  if (body[i] === "{") {
    let depth = 0;
    for (; i < body.length; i++) {
      if (body[i] === "{") depth++;
      else if (body[i] === "}" && --depth === 0) break;
      value += body[i];
    }
    value = value.slice(1);
  } else if (body[i] === '"') {
    const end = body.indexOf('"', i + 1);
    value = body.slice(i + 1, end < 0 ? undefined : end);
  } else {
    value = /^[^,}\s]*/.exec(body.slice(i))![0];
  }
  return value.replace(/[{}]/g, "").replace(/\s+/g, " ").trim() || undefined;
}

export function parseBib(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const re = /@([a-zA-Z]+)\s*[{(]\s*([^,\s{}()]+)\s*,/g;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    const type = m[1]!.toLowerCase();
    if (IGNORED.has(type)) continue;
    const next = text.indexOf("\n@", re.lastIndex);
    const body = text.slice(re.lastIndex, next < 0 ? undefined : next);
    entries.push({ key: m[2]!, type, title: field(body, "title"), author: field(body, "author"), year: field(body, "year") ?? field(body, "date")?.slice(0, 4) });
  }
  return entries;
}
