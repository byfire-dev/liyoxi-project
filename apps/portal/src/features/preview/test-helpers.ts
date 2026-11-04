import type { AdDetail, AdPlayback } from "./api";

export const AD_ID = "019a4500-0000-7000-8000-000000000010";
export const AD: AdDetail = {
  adId: AD_ID,
  adNo: "AD-UNIT",
  type: "opening",
  durationSec: 3,
  status: "pending_confirm",
  displayStatus: "pending_confirm",
  copy: "门店广告文案",
  currentVersionNo: 1,
  currentVersionPushedAt: "2026-11-04T00:00:00.000Z",
  currentPreviewChannels: ["portal"],
  confirmedVersionNo: null,
  poster: null,
  isPortalPreviewable: true,
  currentVersion: {
    versionNo: 1,
    pushedAt: "2026-11-04T00:00:00.000Z",
    durationMs: 3000,
    width: 1080,
    height: 1920,
    segments: [{ index: 1, fromMs: 0, toMs: 3000, label: "片头" }],
    previewChannels: ["portal"],
    decision: null,
    decidedAt: null,
  },
};
export const PLAYBACK: AdPlayback = {
  playableId: "019a4500-0000-7000-8000-000000000011",
  kind: "ad",
  durationMs: 3000,
  width: 1080,
  height: 1920,
  posterUrl: null,
  sources: [
    {
      quality: "source",
      url: "https://media.example.invalid/ad.mp4?grant=unit",
      width: 1080,
      height: 1920,
      bitrateKbps: null,
    },
  ],
  expiresAt: "2026-11-04T01:00:00.000Z",
  autoplay: false,
  muted: false,
};
