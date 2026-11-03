import { expect, it } from "vitest";
import {
  assertContentAdminLiveScope,
  parseOutputBatchLiveManifest as parseSharedManifest,
} from "@liyoxi/services/testing";
import {
  parseOutputBatchLiveManifest,
  parseInvoiceLiveEnvelope,
} from "./upload-batch-live-server.js";

const runId = "1234567890abcdef",
  id = "01950000-0000-7000-8000-000000000001";
const owned = {
  runId,
  name: `lyx_test_admin_live_${runId}`,
  prefix: `lyx:test:admin_live_${runId}:`,
};
const scope = { ...owned, startedAt: "2026-10-01T00:00:00.000Z", uploaderId: id, dramaIds: [id] };
// The original runner passes this full fixture envelope, not its nested scope alone.
const content = { scope, dramaId: id, title: "虚构页面", query: "页面", expectedDraftCount: 13 };
const delivery = {
  ...owned,
  startedAt: scope.startedAt,
  entityId: id,
  storeId: id,
  orderId: id,
  itemId: id,
  ticketId: id,
  uploaderId: id,
  managerId: id,
};
// Codec input only: parser tests do not claim these facts came from a real media probe.
const video = {
  path: "/tmp/parser-only.mp4",
  sha256: "0".repeat(64),
  size: 1,
  probe: {
    kind: "video",
    container: "mp4",
    durationMs: 20_000,
    width: 720,
    height: 1280,
    rotation: 0,
    displayWidth: 720,
    displayHeight: 1280,
    fpsNum: 25,
    fpsDen: 1,
    vcodec: "h264",
    vprofile: "High",
    pixFmt: "yuv420p",
    acodec: "aac",
    audioSampleRate: 48000,
    audioChannels: 2,
    audioStreamCount: 1,
    bitrateKbps: null,
    isFaststart: true,
    avDriftMs: null,
    aigcMeta: null,
    probeVersion: 1,
    raw: {},
  },
};
const original = {
  current: { ...delivery, dramaId: id },
  legacy: delivery,
  video,
  resumeVideo: video,
};
it("可选发票scope保留无新scope的W318旧manifest，双方严格字段与未知键校验不丢失", () => {
  const assets = { ...owned, startedAt: scope.startedAt, staffId: id, storeId: id },
    invoice = { ...owned, startedAt: scope.startedAt, staffId: id, entityIds: [id] },
    previous = { ...original, w312: content, w318: assets };
  expect(parseInvoiceLiveEnvelope(previous)).toEqual({
    manifest: parseSharedManifest(previous),
    w318: assets,
    w418Invoice: undefined,
  });
  expect(parseInvoiceLiveEnvelope({ ...previous, w418Invoice: invoice })).toEqual({
    manifest: parseSharedManifest(previous),
    w318: assets,
    w418Invoice: invoice,
  });
  expect(parseInvoiceLiveEnvelope(original)).toEqual({
    manifest: parseSharedManifest(original),
    w318: undefined,
    w418Invoice: undefined,
  });
  for (const value of [
    { ...previous, unexpected: true },
    { ...previous, w318: { ...assets, verified: true } },
    { ...previous, w418Invoice: { ...invoice, verified: true } },
    { ...previous, w418Invoice: undefined },
  ])
    expect(() => parseInvoiceLiveEnvelope(value)).toThrow();
});
it("交付窄桥共用manifest接受已严格验证的发票scope且保留旧输入边界", () => {
  const assets = { ...owned, startedAt: scope.startedAt, staffId: id, storeId: id },
    invoice = { ...owned, startedAt: scope.startedAt, staffId: id, entityIds: [id] },
    previous = { ...original, w312: content, w318: assets },
    full = { ...previous, w418Invoice: invoice };
  expect(parseSharedManifest(full)).toEqual({ inputs: original, w312: scope });
  expect(parseSharedManifest({ ...original, w418Invoice: invoice })).toEqual({
    inputs: original,
    w312: undefined,
  });
  expect(parseSharedManifest(previous)).toEqual({ inputs: original, w312: scope });
  for (const w418Invoice of [
    undefined,
    null,
    { ...invoice, staffId: "invalid" },
    { ...invoice, entityIds: [id, id] },
    { ...invoice, verified: true },
  ])
    expect(() => parseSharedManifest({ ...full, w418Invoice })).toThrow();
  for (const value of [
    { ...full, unexpected: true },
    { ...full, w318: undefined },
    { ...full, w318: { ...assets, verified: true } },
    { ...full, w312: undefined },
    { ...full, w312: { ...content, expectedDraftCount: 12 } },
    { ...full, legacy: { ...delivery, anotherTarget: id } },
    { ...full, video: { ...video, verified: true } },
  ])
    expect(() => parseSharedManifest(value)).toThrow();
});
it("without W312 the original strict four-field manifest remains unchanged", () => {
  // The API and old delivery CLI use this identical public testing adapter.
  expect(parseOutputBatchLiveManifest).toBe(parseSharedManifest);
  expect(parseOutputBatchLiveManifest(original)).toEqual({ inputs: original, w312: undefined });
  expect(() => parseOutputBatchLiveManifest({ ...original, unexpected: true })).toThrow();
});
it("W312 is independently parsed and stripped before the original strict manifest", () => {
  expect(parseOutputBatchLiveManifest({ ...original, w312: content })).toEqual({
    inputs: original,
    w312: scope,
  });
  expect(() =>
    parseOutputBatchLiveManifest({ ...original, w312: content, unexpected: true }),
  ).toThrow();
  expect(() =>
    parseOutputBatchLiveManifest({ ...original, w312: { ...content, verified: true } }),
  ).toThrow();
  expect(() =>
    parseOutputBatchLiveManifest({
      ...original,
      w312: { ...content, scope: { ...scope, verified: true } },
    }),
  ).toThrow();
  expect(() =>
    parseOutputBatchLiveManifest({
      ...original,
      w312: { ...content, scope: { ...scope, dramaIds: [id, id] } },
    }),
  ).toThrow();
  expect(() => parseOutputBatchLiveManifest({ ...original, w312: undefined })).toThrow();
  expect(() => parseSharedManifest({ ...original, w312: null })).toThrow();
  expect(() =>
    parseSharedManifest({ ...original, w312: { ...content, expectedDraftCount: 12 } }),
  ).toThrow();
});
it("W312 cannot broaden the original current or legacy target contract", () => {
  expect(() =>
    parseOutputBatchLiveManifest({
      ...original,
      w312: content,
      current: { ...original.current, anotherTarget: id },
    }),
  ).toThrow();
  expect(() =>
    parseOutputBatchLiveManifest({
      ...original,
      w312: content,
      video: { ...video, verified: true },
    }),
  ).toThrow();
});
it("the full live envelope accepts only the strict W318 extension and preserves delivery input", () => {
  const assets = { ...owned, startedAt: scope.startedAt, staffId: id, storeId: id };
  const full = { ...original, w312: content, w318: assets };
  expect(parseSharedManifest(full)).toEqual({ inputs: original, w312: scope });
  expect(parseSharedManifest({ ...original, w318: assets })).toEqual({
    inputs: original,
    w312: undefined,
  });
  for (const w318 of [
    undefined,
    null,
    { ...assets, staffId: "invalid" },
    { ...assets, verified: true },
  ])
    expect(() => parseSharedManifest({ ...full, w318 })).toThrow();
  expect(() => parseSharedManifest({ ...full, unexpected: true })).toThrow();
  expect(() =>
    parseSharedManifest({ ...full, legacy: { ...delivery, anotherTarget: id } }),
  ).toThrow();
  expect(() => parseSharedManifest({ ...full, video: { ...video, verified: true } })).toThrow();
});
it("W312 scope requires this exact local owned database, app role and Redis prefix", () => {
  const env = {
    APP_ENV: "test" as const,
    DATABASE_URL: `postgresql://liyoxi:lyx-local-dev@localhost:5442/${owned.name}?options=-c%20role%3Dlyx_app`,
    REDIS_URL: "redis://localhost:6389/0",
  };
  expect(assertContentAdminLiveScope({ env }, scope)).toEqual(scope);
  for (const patch of [
    { runId: "abcdef1234567890" },
    { name: "liyoxi" },
    { prefix: "lyx:test:other:" },
  ])
    expect(() => assertContentAdminLiveScope({ env }, { ...scope, ...patch })).toThrow();
  for (const patch of [
    { APP_ENV: "local" as const },
    { DATABASE_URL: env.DATABASE_URL.replace(owned.name, "liyoxi") },
    { DATABASE_URL: env.DATABASE_URL.replace("lyx_app", "liyoxi") },
    { REDIS_URL: "redis://localhost:6389/1" },
  ])
    expect(() => assertContentAdminLiveScope({ env: { ...env, ...patch } }, scope)).toThrow();
});

it("W514具名scope只扩私有运输信封，旧媒体标准/未知键/本轮范围全部保留", () => {
  const ids = [id, "01950000-0000-7000-8000-000000000002", "01950000-0000-7000-8000-000000000003"];
  const ad = {
    ...owned,
    startedAt: scope.startedAt,
    entityId: id,
    storeId: id,
    editorId: id,
    adIds: ids,
  };
  const full = { ...original, w514: ad };
  expect(parseSharedManifest(full)).toEqual(parseSharedManifest(original));
  expect(parseInvoiceLiveEnvelope(full).w514).toEqual(ad);
  for (const w514 of [
    undefined,
    null,
    { ...ad, adIds: [id, id, id] },
    { ...ad, editorId: "wrong" },
    { ...ad, ready: true },
    { ...ad, runId: "fedcba9876543210" },
    {
      ...ad,
      runId: "fedcba9876543210",
      name: "lyx_test_admin_live_fedcba9876543210",
      prefix: "lyx:test:admin_live_fedcba9876543210:",
    },
  ]) {
    expect(() => parseSharedManifest({ ...full, w514 })).toThrow();
    expect(() => parseInvoiceLiveEnvelope({ ...full, w514 })).toThrow();
  }
  expect(() => parseSharedManifest({ ...full, unrelated: true })).toThrow();
  expect(() =>
    parseSharedManifest({
      ...full,
      video: { ...video, probe: { ...video.probe, durationMs: 3000 } },
    }),
  ).toThrow();
});

it("W513只追加具名独立两集scope，保原current/legacy严格边界与原视频规格", () => {
  const other = (n: number) => `01950000-0000-7000-8000-${String(n).padStart(12, "0")}`;
  const w513 = {
    ...delivery,
    entityId: other(2),
    storeId: other(3),
    orderId: other(4),
    itemId: other(5),
    ticketId: other(6),
  };
  expect(parseSharedManifest({ ...original, w513 })).toEqual({
    inputs: { ...original, w513 },
    w312: undefined,
  });
  expect(parseSharedManifest(original)).toEqual({ inputs: original, w312: undefined });
  for (const invalid of [
    null,
    [w513],
    { ...w513, trusted: true },
    { ...w513, runId: "fedcba0987654321" },
    { ...w513, prefix: "lyx:test:other:" },
    { ...w513, name: "another_database" },
    { ...w513, uploaderId: other(7) },
    { ...w513, managerId: other(7) },
    { ...w513, itemId: delivery.itemId },
  ])
    expect(() => parseSharedManifest({ ...original, w513: invalid })).toThrow();
  expect(() =>
    parseSharedManifest({
      ...original,
      w513,
      video: { ...video, probe: { ...video.probe, durationMs: 19_999 } },
    }),
  ).toThrow();
  expect(() =>
    parseSharedManifest({ ...original, w513, legacy: { ...delivery, injectedScope: true } }),
  ).toThrow();
});

it("W513与W514并存保各具名scope及原invoice/assets/content严格运输边界", () => {
  const other = (n: number) => `01950000-0000-7000-8000-${String(n).padStart(12, "0")}`;
  const w513 = {
    ...delivery,
    entityId: other(2),
    storeId: other(3),
    orderId: other(4),
    itemId: other(5),
    ticketId: other(6),
  };
  const w514 = {
    ...owned,
    startedAt: scope.startedAt,
    entityId: other(7),
    storeId: other(8),
    editorId: other(9),
    adIds: [other(10), other(11), other(12)],
  };
  const assets = { ...owned, startedAt: scope.startedAt, staffId: id, storeId: id };
  const invoice = { ...owned, startedAt: scope.startedAt, staffId: id, entityIds: [id] };
  const full = { ...original, w513, w514, w312: content, w318: assets, w418Invoice: invoice };
  const shared = { inputs: { ...original, w513 }, w312: scope };
  expect(parseSharedManifest(full)).toEqual(shared);
  expect(parseInvoiceLiveEnvelope(full)).toEqual({
    manifest: shared,
    w318: assets,
    w418Invoice: invoice,
    w514,
  });
  for (const invalid of [
    { ...full, w513: { ...w513, trusted: true } },
    { ...full, w513: { ...w513, itemId: delivery.itemId } },
    { ...full, w514: { ...w514, ready: true } },
    { ...full, unexpected: true },
    { ...full, video: { ...video, probe: { ...video.probe, durationMs: 19_999 } } },
  ]) {
    expect(() => parseSharedManifest(invalid)).toThrow();
    expect(() => parseInvoiceLiveEnvelope(invalid)).toThrow();
  }
});

const publishId = (n: number) => `01950000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const publishScope = {
  ...delivery,
  entityId: publishId(2),
  storeId: publishId(3),
  orderId: publishId(4),
  itemId: publishId(5),
  ticketId: publishId(6),
  dramaId: publishId(7),
  planId: publishId(8),
  merchantUserId: publishId(9),
  memberId: publishId(10),
  posterFileId: publishId(11),
  managerId: publishId(12),
  accountIds: [publishId(13), publishId(14)],
  foreign: { entityId: publishId(15), storeId: publishId(16), accountId: publishId(17) },
};
const withPublish = {
  ...original,
  current: { ...original.current, managerId: publishScope.managerId },
  w608: publishScope,
};
it("W608只把本轮独立两集目标交给旧真实媒体准备，跨库/跨轮/重叠或未知权限拒绝", () => {
  expect(parseSharedManifest(withPublish).inputs).toEqual(withPublish);
  expect(parseInvoiceLiveEnvelope(withPublish).manifest.inputs).toEqual(withPublish);
  for (const w608 of [
    undefined,
    null,
    { ...publishScope, verified: true },
    { ...publishScope, runId: "abcdef1234567890" },
    { ...publishScope, name: "lyx_test_admin_live_abcdef1234567890" },
    { ...publishScope, prefix: "lyx:test:other:" },
    { ...publishScope, uploaderId: publishId(99) },
    { ...publishScope, managerId: publishId(99) },
    { ...publishScope, itemId: original.current.itemId },
    { ...publishScope, foreign: { ...publishScope.foreign, storeId: original.legacy.storeId } },
    { ...publishScope, accountIds: [publishId(13), publishId(13)] },
  ])
    expect(() => parseSharedManifest({ ...withPublish, w608 })).toThrow();
  expect(() =>
    parseSharedManifest({ ...withPublish, video: { ...video, verified: true } }),
  ).toThrow();
  expect(parseSharedManifest(original).inputs).toEqual(original);
});
