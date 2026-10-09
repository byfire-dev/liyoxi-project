import { describe, expect, it } from "vitest";

import { eventPayloadSchema } from "./index.js";
import { payloads } from "./media.js";

const ID = "01900000-0000-7000-8000-000000000001";
const OTHER_ID = "01900000-0000-7000-8000-000000000002";
const cases = [
  {
    name: "media.production.checked",
    valid: { v: 1, fileId: ID, kind: "final", gate: "pass" },
    extraValid: [
      { v: 1, fileId: ID, kind: "sample", gate: "reject", durationMs: 0 },
      { v: 1, fileId: ID, kind: "ad", gate: "pass", orderItemId: OTHER_ID, durationMs: 20000 },
    ],
    invalid: [
      { v: 1, fileId: ID, kind: "master", gate: "pass" },
      { v: 1, fileId: ID, kind: "final", gate: "ready" },
      { v: 1, fileId: ID, kind: "final", gate: "pass", durationMs: 0.5 },
      { v: 1, fileId: ID, kind: "final", gate: "pass", durationMs: -1 },
      { v: 1, fileId: ID, kind: "final", gate: "pass", orderItemId: "bad-id" },
    ],
  },
  {
    name: "media.production.derived",
    valid: { v: 1, fileId: ID, sourceFileId: OTHER_ID, derivation: "restamp" },
    extraValid: [{ v: 1, fileId: ID, sourceFileId: OTHER_ID, derivation: "normalize" }],
    invalid: [
      { v: 1, fileId: ID, sourceFileId: OTHER_ID, derivation: "transcode" },
      { v: 1, fileId: ID, derivation: "restamp" },
      { v: 1, fileId: ID, sourceFileId: "bad-id", derivation: "restamp" },
    ],
  },
  {
    name: "media.playable.ready",
    valid: { v: 1, playableAssetId: ID, ownerType: "drama", ownerId: OTHER_ID, kind: "trailer" },
    extraValid: [
      {
        v: 1,
        playableAssetId: ID,
        ownerType: "production_record",
        ownerId: OTHER_ID,
        kind: "sample",
      },
      { v: 1, playableAssetId: ID, ownerType: "ad", ownerId: OTHER_ID, kind: "ad" },
    ],
    invalid: [
      { v: 1, playableAssetId: ID, ownerType: "", ownerId: OTHER_ID, kind: "trailer" },
      { v: 1, playableAssetId: ID, ownerType: "x".repeat(65), ownerId: OTHER_ID, kind: "trailer" },
      { v: 1, playableAssetId: ID, ownerType: "drama", ownerId: OTHER_ID, kind: "master" },
      { v: 1, playableAssetId: ID, ownerType: "drama", kind: "trailer" },
    ],
  },
  {
    name: "media.playable.failed",
    valid: { v: 1, playableAssetId: ID, ownerType: "drama", ownerId: OTHER_ID, kind: "trailer" },
    extraValid: [
      {
        v: 1,
        playableAssetId: ID,
        ownerType: "production_record",
        ownerId: OTHER_ID,
        kind: "sample",
      },
      { v: 1, playableAssetId: ID, ownerType: "ad", ownerId: OTHER_ID, kind: "ad" },
    ],
    invalid: [
      {
        v: 1,
        playableAssetId: ID,
        ownerType: "drama",
        ownerId: OTHER_ID,
        kind: "trailer",
        reason: "failed",
      },
      { v: 1, playableAssetId: ID, ownerType: "", ownerId: OTHER_ID, kind: "trailer" },
      { v: 1, playableAssetId: ID, ownerType: "x".repeat(65), ownerId: OTHER_ID, kind: "trailer" },
      { v: 1, playableAssetId: ID, ownerType: "drama", ownerId: OTHER_ID, kind: "final" },
    ],
  },
  {
    name: "drama.trailer_ready",
    valid: { v: 1, dramaId: ID, playableAssetId: OTHER_ID },
    extraValid: [],
    invalid: [
      { v: 1, dramaId: ID },
      { v: 1, dramaId: "bad-id", playableAssetId: OTHER_ID },
      { v: 1, dramaId: ID, playableAssetId: "bad-id" },
    ],
  },
] as const;

describe("W3-04 五个既有事件的严格载荷", () => {
  it.each(cases)("$name：公开目录绑定并保留正式有效字段", ({ name, valid, extraValid }) => {
    const schema = payloads[name];
    expect(eventPayloadSchema(name)).toBe(schema);
    expect(schema.parse(valid)).toEqual(valid);
    for (const value of extraValid) expect(schema.parse(value)).toEqual(value);
  });

  it.each(cases)("$name：拒绝坏标识、版本、未知字段及非法业务值", ({ name, valid, invalid }) => {
    const bad = [
      ...invalid,
      { ...valid, v: 2 },
      { ...valid, rawBody: "禁止额外载荷" },
      {
        ...valid,
        ...(Object.hasOwn(valid, "fileId") ? { fileId: "bad-id" } : { playableAssetId: "bad-id" }),
      },
    ];
    for (const value of bad) expect(payloads[name].safeParse(value).success, name).toBe(false);
  });
});
