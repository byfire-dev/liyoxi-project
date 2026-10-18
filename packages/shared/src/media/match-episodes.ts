export interface EpisodeMatch {
  readonly originalName: string;
  readonly episodeNo: number | null;
  readonly matchMethod: "pattern" | "sequence" | null;
}

const suffix =
  /[\s._-]*(\d{3,4}p|[248]k|\d{3,4}x\d{3,4}|h\.?26[45]|hevc|uhd|hd|final|v\d{1,2}|20\d{6})$/i;
const patterns = [
  /第\s*0*(\d{1,3})\s*集/,
  /(?<![a-z])(?:ep|e)[\s._-]*0*(\d{1,3})(?!\d)/i,
  /(?<!\d)0*(\d{1,3})$/,
  /^0*(\d{1,3})(?!\d)/,
] as const;
const natural = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "variant" });

function normalizedName(name: string): string {
  const digits = name.replace(/[\uFF10-\uFF19]/g, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xff10 + 0x30),
  );
  const extension = digits.lastIndexOf(".");
  let result = (extension > 0 ? digits.slice(0, extension) : digits).trim();
  for (;;) {
    const stripped = result.replace(suffix, "").trim();
    if (stripped === result) return result;
    result = stripped;
  }
}

/** D5 5.6: a suggestion is persisted as sequence and must be explicitly accepted before upload. */
export function matchEpisodes(
  names: readonly string[],
  episodeCount: number,
): readonly EpisodeMatch[] {
  if (!Number.isSafeInteger(episodeCount) || episodeCount < 1)
    throw new TypeError("A positive integer episode count is required");
  const normalized = names.map(normalizedName);
  const matches = names.map((originalName, index): EpisodeMatch => {
    for (const [priority, pattern] of patterns.entries()) {
      const hit = pattern.exec(normalized[index]!);
      if (!hit) continue;
      const episodeNo = Number(hit[1]);
      if (episodeNo < 1 || episodeNo > episodeCount)
        return { originalName, episodeNo: null, matchMethod: null };
      return {
        originalName,
        episodeNo,
        matchMethod: names.length === 1 && priority >= 2 ? "sequence" : "pattern",
      };
    }
    return { originalName, episodeNo: null, matchMethod: null };
  });

  if (names.length === episodeCount && matches.every((item) => item.episodeNo === null)) {
    const ordered = names.map((name, index) => ({ name, index }));
    ordered.sort(
      (a, b) =>
        natural.compare(normalized[a.index]!, normalized[b.index]!) ||
        natural.compare(a.name, b.name) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    const suggested = new Map(ordered.map((item, index) => [item.index, index + 1]));
    return names.map((originalName, index) => ({
      originalName,
      episodeNo: suggested.get(index)!,
      matchMethod: "sequence",
    }));
  }

  const counts = new Map<number, number>();
  for (const item of matches)
    if (item.episodeNo !== null) counts.set(item.episodeNo, (counts.get(item.episodeNo) ?? 0) + 1);
  return matches.map((item) =>
    item.episodeNo !== null && counts.get(item.episodeNo)! > 1
      ? { originalName: item.originalName, episodeNo: null, matchMethod: null }
      : item,
  );
}
