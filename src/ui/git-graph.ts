// The lanes of the commit graph, without any UI. Commits come children first (`git log --topo-order`); each lane waits
// for one commit, so a lane runs from a child down to its parent.

export interface GraphRow {
  /** The commit's lane. */
  lane: number;
  /** A child above waits for this commit. */
  fromAbove: boolean;
  /** The commit has a first parent (its lane goes on below). */
  down: boolean;
  /** Other branches passing by. */
  through: number[];
  /** Lanes of other children that meet in this commit. */
  joins: number[];
  /** Lanes of a merge's other parents. */
  forks: number[];
  /** Lanes going on below the row. */
  below: number[];
}

export function layoutGraph(commits: { hash: string; parents: string[] }[]): { rows: GraphRow[]; width: number } {
  const lanes: (string | null)[] = [];
  const free = () => (lanes.indexOf(null) < 0 ? lanes.length : lanes.indexOf(null));
  const active = (keep: (hash: string) => boolean) => lanes.flatMap((h, i) => (h !== null && keep(h) ? [i] : []));
  let width = 0;
  const rows = commits.map(({ hash, parents }) => {
    const waiting = lanes.indexOf(hash);
    const lane = waiting < 0 ? free() : waiting;
    const through = active((h) => h !== hash);
    const joins = active((h) => h === hash).filter((i) => i !== lane);
    for (const i of joins) lanes[i] = null;
    lanes[lane] = parents[0] ?? null;
    const forks = parents.slice(1).map((parent) => {
      const existing = lanes.indexOf(parent);
      if (existing >= 0) return existing;
      const target = free();
      lanes[target] = parent;
      return target;
    });
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    width = Math.max(width, lane + 1, ...[...through, ...joins, ...forks].map((i) => i + 1));
    return { lane, fromAbove: waiting >= 0, down: parents.length > 0, through, joins, forks, below: active(() => true) };
  });
  return { rows, width };
}
