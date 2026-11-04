import { expect, it, vi } from "vitest";
import { createClock } from "../clock.js";
import { createFakeStorage } from "../providers/storage.js";
import { createPortalPreviewMedia } from "./preview-media.js";

const ref = { bucket: "media" as const, key: "store/owned/ad.mp4" };
function fixture(runId = "abcdef123456") {
  const clock = createClock(),
    storage = createFakeStorage({ clock });
  storage.put(ref, new Uint8Array([1, 2, 3]), "video/mp4");
  const transport = createPortalPreviewMedia({
    runId,
    portalOrigin: "https://portal.localhost:4000",
    clock,
    storage,
  });
  return { clock, storage, transport };
}
async function target(h: ReturnType<typeof fixture>) {
  h.transport.own(ref);
  const result = await h.transport.storage.presignGet({ ...ref, expiresSec: 3600 });
  if (!result.ok) throw new Error("SIGN_FAILED");
  return new URL(result.value.url).pathname;
}

it("serves only a grant actually issued for the exact owned object, rechecking original provider permission", async () => {
  const h = fixture(),
    fetch = vi.spyOn(h.storage, "fetch");
  const path = await target(h);
  expect(h.transport.read(path)).toMatchObject({
    status: 200,
    bytes: new Uint8Array([1, 2, 3]),
    mime: "video/mp4",
    expiresAt: new Date(h.clock.now().getTime() + 3_600_000).toISOString(),
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockReturnValueOnce({ status: 403 });
  expect(h.transport.read(path)).toEqual({ status: 403 });
  expect(h.transport.read(path)).toHaveProperty("status", 200);
});

it("rejects other runs, forged grants, query tampering, raw storage tokens and unowned objects", async () => {
  const h = fixture(),
    other = fixture("123456abcdef"),
    path = await target(h);
  for (const bad of [
    path.replace("abcdef123456", "123456abcdef"),
    `${path}?x=1`,
    `${path}#x`,
    `https://portal.localhost:4000${path}`,
    `${path}/../file`,
    path.slice(0, -1),
    `/__portal-live/abcdef123456/media/${"0".repeat(32)}`,
  ])
    expect(h.transport.read(bad)).toEqual({ status: 403 });
  expect(other.transport.read(path)).toEqual({ status: 403 });
  h.storage.put({ ...ref, key: "another/ad.mp4" }, new Uint8Array([4]), "video/mp4");
  const signed = await h.transport.storage.presignGet({
    ...ref,
    key: "another/ad.mp4",
    expiresSec: 3600,
  });
  if (!signed.ok) throw new Error("SIGN_FAILED");
  expect(h.transport.read(signed.value.url)).toEqual({ status: 403 });
  expect(new URL(signed.value.url).hostname).toBe("fake-storage.invalid");
});

it("rejects expiry at the exact deadline; re-signing is required and close revokes all grants", async () => {
  const h = fixture(),
    path = await target(h);
  h.clock.advance(3_599_999);
  expect(h.transport.read(path).status).toBe(200);
  h.clock.advance(1);
  expect(h.transport.read(path)).toEqual({ status: 410 });
  const fresh = await target(h);
  expect(fresh).not.toBe(path);
  expect(h.transport.read(fresh).status).toBe(200);
  h.transport.close();
  expect(h.transport.read(fresh)).toEqual({ status: 403 });
  expect(() => h.transport.own(ref)).toThrow("PREVIEW_MEDIA_CLOSED");
});

it("never serves replacement bytes under an old grant, and missing bytes stay 404", async () => {
  const h = fixture(),
    path = await target(h);
  const first = h.transport.read(path);
  if (first.status !== 200) throw new Error("READ_FAILED");
  first.bytes[0] = 99;
  expect(h.transport.read(path)).toHaveProperty("bytes", new Uint8Array([1, 2, 3]));
  h.storage.put(ref, new Uint8Array([4, 5, 6]), "video/mp4");
  expect(h.transport.read(path)).toEqual({ status: 403 });
  expect(() => h.transport.own(ref)).toThrow("PREVIEW_MEDIA_OBJECT_CHANGED");
  h.storage.objects.delete(`${ref.bucket}/${ref.key}`);
  expect(h.transport.read(path)).toEqual({ status: 404 });
});

it("does not turn a failed signature or oversized object into a transport capability", async () => {
  const h = fixture();
  h.transport.own(ref);
  h.storage.failNext("presignGet");
  const signed = await h.transport.storage.presignGet({ ...ref, expiresSec: 3600 });
  expect(signed.ok).toBe(false);
  h.storage.put(ref, new Uint8Array(4 * 1024 * 1024 + 1), "video/mp4");
  expect(() => h.transport.own(ref)).toThrow("PREVIEW_MEDIA_OBJECT_INVALID");
});
