import { describe, expect, it } from "vitest";
import { layoutGraph } from "./git-graph";

const commit = (hash: string, ...parents: string[]) => ({ hash, parents });

describe("commit graph", () => {
  it("keeps a straight history in one lane", () => {
    const { rows, width } = layoutGraph([commit("c", "b"), commit("b", "a"), commit("a")]);
    expect(width).toBe(1);
    expect(rows.map((r) => [r.lane, r.fromAbove, r.down])).toEqual([[0, false, true], [0, true, true], [0, true, false]]);
  });

  it("opens a lane for a merged branch and closes it where both meet", () => {
    // m merges y into x; x and y both come from a.
    const { rows, width } = layoutGraph([commit("m", "x", "y"), commit("y", "a"), commit("x", "a"), commit("a")]);
    expect(width).toBe(2);
    expect(rows[0]).toMatchObject({ lane: 0, forks: [1], below: [0, 1] });
    expect(rows[1]).toMatchObject({ lane: 1, fromAbove: true, through: [0], below: [0, 1] });
    expect(rows[2]).toMatchObject({ lane: 0, through: [1], below: [0, 1] });
    expect(rows[3]).toMatchObject({ lane: 0, joins: [1], through: [], below: [] });
  });

  it("starts a commit nobody waits for in a free lane", () => {
    const { rows } = layoutGraph([commit("b", "a"), commit("z"), commit("a")]);
    expect(rows[1]).toMatchObject({ lane: 1, fromAbove: false, down: false, through: [0] });
    expect(rows[2]).toMatchObject({ lane: 0, fromAbove: true });
  });
});
