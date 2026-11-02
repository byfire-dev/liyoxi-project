// SHA-bound local media evidence. Codec IO remains a declared double; no runtime-native probe claim.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ProbeReport } from "../providers/types.js";
import type { M1Support } from "./m1-types.js";

const SHA = "6e7853826147e8d543bdd8ba1160b75c45bd54c73bbf9f08d3d20230e221372e";
const PROOF_SHA = "50f263e0f0eab87fcccefb05d80e740b993dbb005e227f9ed2508bf944e566b2";
const RECIPE_SHA = "239c50f9e4642f34a557a3dcb585b37d07f87f6bef6e2817b2649a5766db3b1e";
const IMAGE = "sha256:344107b8230f189650b0133b31b7cb2c5e4830840121dafc3b341709b5623a3b";
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Pure validation: independently generated native evidence is bound to the complete actual input. */
export function parseM5AdMedia(bytes: Uint8Array, proofBytes: Uint8Array) {
  assert.equal(digest(bytes), SHA, "M5广告实际输入字节已改变");
  assert.equal(digest(proofBytes), PROOF_SHA, "M5广告原生体检证明已改变");
  const proof = JSON.parse(new TextDecoder().decode(proofBytes)) as {
    image: string;
    recipeSha256: string;
    version: string;
    sha256: string;
    sizeBytes: number;
    report: { report: ProbeReport };
    raw: {
      format: { duration: string; size: string };
      streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
    };
  };
  const report = proof.report.report;
  assert.equal(proof.image, IMAGE);
  assert.equal(proof.recipeSha256, RECIPE_SHA);
  assert.match(proof.version, /^ffmpeg version 5\.1\.9/);
  assert.equal(proof.sha256, SHA);
  assert.equal(proof.sizeBytes, bytes.length);
  assert.ok(bytes.length < 3 * 1024 * 1024);
  assert.equal(report.format.sizeBytes, bytes.length);
  assert.equal(report.format.durationMs, 3000);
  assert.equal(report.moovBeforeMdat, true);
  assert.equal(Number(proof.raw.format.duration), 3);
  assert.equal(Number(proof.raw.format.size), bytes.length);
  const video = report.streams.filter((row) => row.codecType === "video");
  assert.equal(video.length, 1);
  assert.equal(video[0]?.codecName, "h264");
  assert.equal(video[0]?.displayWidth, 1080);
  assert.equal(video[0]?.displayHeight, 1920);
  assert.ok(report.streams.some((row) => row.codecType === "audio" && row.codecName === "aac"));
  const nativeVideo = proof.raw.streams.filter((row) => row.codec_type === "video");
  assert.deepEqual(
    nativeVideo.map((row) => [row.codec_name, row.width, row.height]),
    [["h264", 1080, 1920]],
  );
  const media: M1Support["productionVideo"] = {
    bytes: new Uint8Array(bytes),
    sha256: SHA,
    sizeBytes: bytes.length,
    durationMs: 3000,
    width: 1080,
    height: 1920,
    videoCodec: "h264",
    hasAudio: true,
  };
  return { video: media, report: structuredClone(report) };
}

export async function loadM5AdMedia() {
  const [bytes, proof] = await Promise.all([
    readFile(new URL("./m5-ad.mp4", import.meta.url)),
    readFile(new URL("./m5-ad.probe.json", import.meta.url)),
  ]);
  return parseM5AdMedia(bytes, proof);
}
