import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { matchEpisodes } from "./match-episodes.js";

describe("batch episode matching", () => {
  it("uses P1 before P2 and repeatedly removes technical suffixes", () => {
    const result = matchEpisodes(
      ["第１２集_E03_1080p_h.264_final_v2.mp4", "EP_02_720p.mov", "movie_03.mp4"],
      20,
    );
    expect(result.map((item) => [item.episodeNo, item.matchMethod])).toEqual([
      [12, "pattern"],
      [2, "pattern"],
      [3, "pattern"],
    ]);
  });

  it("does not read part of a year/resolution or use a lower priority after an invalid match", () => {
    const result = matchEpisodes(
      ["movie_01_1080.mp4", "第99集_E01.mp4", "movie_20261009.mp4", "scene1000.mp4"],
      20,
    );
    expect(result.every((item) => item.episodeNo === null && item.matchMethod === null)).toBe(true);
  });

  it("leaves every conflicting file unmatched and never hides conflicts with sequence", () => {
    expect(matchEpisodes(["第1集.mp4", "E01.mp4"], 2)).toEqual([
      { originalName: "第1集.mp4", episodeNo: null, matchMethod: null },
      { originalName: "E01.mp4", episodeNo: null, matchMethod: null },
    ]);
    const result = matchEpisodes(["E01.mp4", "E01_copy.mp4", "E02.mp4"], 20);
    expect(result.map((item) => item.episodeNo)).toEqual([null, null, 2]);
  });

  it("marks single-file P3/P4 matches as suggestions requiring confirmation", () => {
    for (const name of ["movie_03.mp4", "03_movie.mov"]) {
      expect(matchEpisodes([name], 20)[0]).toEqual({
        originalName: name,
        episodeNo: 3,
        matchMethod: "sequence",
      });
    }
    expect(matchEpisodes(["E03.mp4"], 20)[0]?.matchMethod).toBe("pattern");
  });

  it("only proposes natural-order sequence when every pattern misses and count exactly matches", () => {
    expect(matchEpisodes(["beta.mp4", "alpha.mov"], 2)).toEqual([
      { originalName: "beta.mp4", episodeNo: 2, matchMethod: "sequence" },
      { originalName: "alpha.mov", episodeNo: 1, matchMethod: "sequence" },
    ]);
    expect(
      matchEpisodes(["beta.mp4", "alpha.mov"], 20).every((item) => item.episodeNo === null),
    ).toBe(true);
    expect(matchEpisodes(["E01.mp4", "alpha.mov"], 2)[1]?.episodeNo).toBeNull();
    expect(matchEpisodes(["E100.mp4"], 1)[0]).toMatchObject({
      episodeNo: 1,
      matchMethod: "sequence",
    });
  });

  it("keeps valid unique mappings under arbitrary input reordering and technical suffixes", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 100 }), { minLength: 2, maxLength: 20 }),
        fc.constantFrom("_1080p", "_h.264_final", "_v2_720x1280", "_20261009"),
        (numbers, suffix) => {
          const names = numbers.map((n) => "E" + n + suffix + ".mp4");
          const forward = matchEpisodes(names, 100);
          const reverse = [...matchEpisodes([...names].reverse(), 100)].reverse();
          expect(reverse).toEqual(forward);
          expect(forward.map((item) => item.episodeNo)).toEqual(numbers);
          expect(new Set(forward.map((item) => item.episodeNo)).size).toBe(numbers.length);
        },
      ),
      { seed: 302, numRuns: 100 },
    );
  });

  it("does not mutate names and rejects a missing or invalid episode-count fact", () => {
    const names = Object.freeze(["E01.mp4", "E02.mp4"]);
    expect(matchEpisodes(names, 20)).toHaveLength(2);
    expect(names).toEqual(["E01.mp4", "E02.mp4"]);
    for (const count of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => matchEpisodes(names, count)).toThrow("episode count");
    }
  });
});
