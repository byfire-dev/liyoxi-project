import type { Technical } from "../production-report.js";

export function ordinaryChecks(info: Technical, profile: string, adKind: "head" | "tail" | null) {
  const vertical =
    info.displayWidth !== null &&
    info.displayHeight !== null &&
    info.displayWidth >= 720 &&
    info.displayHeight >= 1280 &&
    Math.abs(info.displayWidth / info.displayHeight / (9 / 16) - 1) <= 0.01;
  const audio = info.audioStreamCount >= 1,
    duration = info.durationMs;
  const pass =
    profile === "asset" ||
    (vertical &&
      audio &&
      duration !== null &&
      (profile === "master"
        ? duration >= 20_000 && duration < 1_200_000 && info.sizeBytes <= 500 * 1024 ** 2
        : profile === "trailer_src"
          ? duration > 0 && duration <= 180_000
          : info.displayWidth === 1080 &&
            info.displayHeight === 1920 &&
            info.vcodec === "h264" &&
            info.acodec === "aac" &&
            (adKind === "head"
              ? duration >= 2500 && duration <= 5500
              : adKind === "tail"
                ? duration >= 4500 && duration <= 10500
                : false)));
  return {
    gate: pass ? ("pass" as const) : ("reject" as const),
    hard: [{ code: "profile", pass, actual: profile, expected: "D5.6.1" }],
    soft: [],
  };
}
