import { describe, expect, it, vi } from "vitest";
import type { PortalLiveFixture } from "@liyoxi/services/testing";
import { portalLiveMediaResponse } from "./portal-shell-live-server.js";

const input = { runId: "012345abcdef", portalOrigin: "https://portal.localhost:4443" };
const path = `/__portal-live/${input.runId}/media/${"a".repeat(32)}`;
const etag = `"${"b".repeat(64)}"`;
const bytes = new Uint8Array([0, 1, 2, 3, 4, 255]);
function setup() {
  const media = {
    status: 200 as const,
    bytes,
    mime: "video/mp4",
    etag,
    expiresAt: "2026-01-01T01:00:00.000Z",
  };
  const fixture = {
    readPreviewMedia: vi.fn<PortalLiveFixture["readPreviewMedia"]>().mockReturnValue(media),
  };
  function request(target = path, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    if (!headers.has("host")) headers.set("host", new URL(input.portalOrigin).host);
    return portalLiveMediaResponse(
      new Request(`${input.portalOrigin}${target}`, { ...options, headers }),
      input,
      fixture,
    );
  }
  return { fixture, request, media };
}

describe("private portal media transport", () => {
  it("delegates production paths and rejects foreign, encoded, queried or invalid grants before storage", () => {
    const h = setup();
    expect(h.request("/api/v1/portal/session")).toBeUndefined();
    for (const target of [
      path.replace(input.runId, "ffffffffffff"),
      path.replace("/media/", "/files/"),
      `${path}?public=probe`,
      `${path}#fragment`,
      `${path}/extra`,
      path.replace(/a$/, "A"),
      path.replace(/a$/, "%61"),
      "/__portal-live/session",
    ])
      expect(h.request(target)?.status).toBe(404);
    expect(h.request(path, { headers: { host: "api.localhost:4443" } })?.status).toBe(421);
    expect(h.request(path, { headers: { origin: "https://elsewhere.invalid" } })?.status).toBe(403);
    expect(h.request(path, { method: "POST" })?.status).toBe(405);
    expect(h.fixture.readPreviewMedia).not.toHaveBeenCalled();
  });
  it("fetches and validates the grant for GET and HEAD, preserving safe representation headers", async () => {
    const h = setup();
    const response = h.request(path, { headers: { origin: input.portalOrigin } })!;
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("etag")).toBe(etag);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    const head = h.request(path, { method: "HEAD", headers: { range: "bytes=0-0" } })!;
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(bytes.length));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect(h.fixture.readPreviewMedia).toHaveBeenCalledTimes(2);
    expect(h.fixture.readPreviewMedia.mock.calls).toEqual([[path], [path]]);
    h.fixture.readPreviewMedia.mockReturnValue({ ...h.media, mime: "image/jpeg" });
    const cover = h.request()!;
    expect(cover.status).toBe(200);
    expect(cover.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await cover.arrayBuffer())).toEqual(bytes);
    expect(h.fixture.readPreviewMedia).toHaveBeenCalledTimes(3);
  });
  it("serves single bounded, open and suffix ranges from verified bytes; mismatched If-Range returns the full object", async () => {
    const h = setup();
    for (const [range, start, end] of [
      ["bytes=1-3", 1, 3],
      ["bytes=4-", 4, 5],
      ["bytes=-2", 4, 5],
      ["bytes=2-999", 2, 5],
      ["bytes=-99", 0, 5],
    ] as const) {
      const response = h.request(path, { headers: { range, "if-range": etag } })!;
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${bytes.length}`);
      expect(response.headers.get("content-length")).toBe(String(end - start + 1));
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.subarray(start, end + 1));
    }
    const whole = h.request(path, { headers: { range: "bytes=1-2", "if-range": '"different"' } })!;
    expect(whole.status).toBe(200);
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(bytes);
    expect(h.fixture.readPreviewMedia).toHaveBeenCalledTimes(6);
  });
  it("rejects malformed, multipart and unsatisfiable ranges only after grant validation", async () => {
    const h = setup();
    for (const range of [
      "bytes=",
      "bytes=-",
      "bytes=-0",
      "bytes=6-",
      "bytes=4-2",
      "bytes=0-1,3-4",
      "items=0-1",
      "bytes=9007199254740992-",
      "bytes=0-9007199254740992",
    ]) {
      const response = h.request(path, { headers: { range } })!;
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(`bytes */${bytes.length}`);
      expect((await response.arrayBuffer()).byteLength).toBe(0);
    }
    expect(h.fixture.readPreviewMedia).toHaveBeenCalledTimes(9);
    for (const status of [403, 404, 410] as const) {
      h.fixture.readPreviewMedia.mockReturnValue({ status });
      const denied = h.request(path, { headers: { range: "bytes=0-1,3-4" } })!;
      expect(denied.status).toBe(status);
      expect(denied.headers.get("content-range")).toBeNull();
      expect(denied.headers.get("etag")).toBeNull();
      expect((await denied.arrayBuffer()).byteLength).toBe(0);
      expect(h.request(path, { method: "HEAD" })?.status).toBe(status);
    }
  });
  it("suppresses provider exceptions and rejects unsafe metadata or oversized byte responses", async () => {
    const h = setup();
    h.fixture.readPreviewMedia.mockImplementation(() => {
      throw new Error("private-provider-sentinel");
    });
    const failure = h.request()!;
    expect(failure.status).toBe(500);
    expect(await failure.text()).toBe("");
    for (const patch of [
      { mime: "text/html" },
      { etag: "private-provider-sentinel" },
      { expiresAt: "invalid" },
      { bytes: new Uint8Array(0) },
      { bytes: new Uint8Array(4 * 1024 * 1024 + 1) },
    ]) {
      h.fixture.readPreviewMedia.mockReturnValue({ ...h.media, ...patch });
      const response = h.request()!;
      expect(response.status).toBe(500);
      expect((await response.arrayBuffer()).byteLength).toBe(0);
    }
  });
});
