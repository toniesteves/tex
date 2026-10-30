import { describe, expect, it } from "vitest";
import { clock, navigate, splitPage, startNav, withCount, type Nav } from "./logic";

const keys = (nav: Nav, ...pressed: string[]) => pressed.reduce<Nav>((n, key) => navigate(n, key) as Nav, nav);

describe("presentation navigation", () => {
  it("moves, clamps at both ends and jumps to typed slide numbers", () => {
    const nav = startNav(5);
    expect(keys(nav, "ArrowRight", " ", "PageDown").index).toBe(3);
    expect(keys(nav, "ArrowLeft").index).toBe(0);
    expect(keys(nav, "End", "ArrowRight").index).toBe(4);
    expect(keys(nav, "4", "Enter")).toMatchObject({ index: 3, digits: "" });
    expect(keys(nav, "9", "9", "Enter").index).toBe(4);
    expect(navigate(nav, "Escape")).toBe("end");
    expect(navigate(nav, "x")).toBeNull();
  });

  it("toggles black and white screens, and any move clears them", () => {
    const nav = startNav(3);
    expect(keys(nav, "b").blank).toBe("black");
    expect(keys(nav, "b", "b").blank).toBeNull();
    expect(keys(nav, "w", ".").blank).toBe("black");
    expect(keys(nav, "b", "ArrowRight")).toMatchObject({ blank: null, index: 1 });
  });

  it("keeps the slide on reload, clamped to the new page count", () => {
    expect(withCount({ ...startNav(10), index: 8 }, 5).index).toBe(4);
    expect(withCount({ ...startNav(10), index: 2 }, 12).index).toBe(2);
  });

  it("splits Beamer pages that carry notes", () => {
    expect(splitPage(1024, 384, "auto")).toEqual({ slide: [0, 0.5], notes: [0.5, 1] });
    expect(splitPage(1024, 384, "left")).toEqual({ slide: [0.5, 1], notes: [0, 0.5] });
    expect(splitPage(512, 384, "auto")).toEqual({ slide: [0, 1], notes: null });
    expect(splitPage(1024, 384, "none").notes).toBeNull();
  });

  it("formats the timer", () => {
    expect(clock(9_000)).toBe("0:09");
    expect(clock(3_909_000)).toBe("1:05:09");
  });
});
