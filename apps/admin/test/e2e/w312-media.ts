import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { z } from "@liyoxi/contract";
import { liveContext } from "./live-context";

const scopeSchema = z.strictObject({
  runId: z.string().regex(/^[a-f0-9]{16}$/),
  name: z.string(),
  prefix: z.string(),
  startedAt: z.iso.datetime(),
  uploaderId: z.uuid(),
  dramaIds: z.array(z.uuid()).length(13),
});
const fixtureSchema = z.strictObject({
  scope: scopeSchema,
  dramaId: z.uuid(),
  title: z.string(),
  query: z.string(),
  expectedDraftCount: z.literal(13),
});
export function contentFixture() {
  const f = z.object({ fixtures: z.object({ w312: fixtureSchema }) }).parse(liveContext().fixtures)
    .fixtures.w312;
  if (
    f.scope.name !== `lyx_test_admin_live_${f.scope.runId}` ||
    f.scope.prefix !== `lyx:test:admin_live_${f.scope.runId}:` ||
    !f.scope.dramaIds.includes(f.dramaId) ||
    new Set(f.scope.dramaIds).size !== 13
  )
    throw new Error("Missing exact owned W312 content fixture");
  return f;
}
const inputSchema = z.strictObject({
  path: z.string(),
  size: z.int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
/** The runner copies the actual fixed 20s input to this run's owned directory. */
export function contentVideo(name: string) {
  const f = contentFixture();
  const input = z
    .object({ fixtures: z.object({ w302: z.object({ video: inputSchema }) }) })
    .parse(liveContext().fixtures).fixtures.w302.video;
  if (!input.path.includes(`/admin-live-${f.scope.runId}/`))
    throw new Error("Unowned content input");
  const buffer = readFileSync(input.path);
  if (
    buffer.length !== input.size ||
    createHash("sha256").update(buffer).digest("hex") !== input.sha256
  )
    throw new Error("Content input differs from the actual recorded bytes");
  return { name, mimeType: "video/mp4", buffer };
}
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name: string, bytes: Buffer) {
  const type = Buffer.from(name),
    result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length, 0);
  type.copy(result, 4);
  bytes.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([type, bytes])), bytes.length + 8);
  return result;
}
/** Small synthetic PNG, not a real poster or cloud moderation acceptance claim. */
export function syntheticImage(name: string) {
  const width = 1200,
    height = 400,
    header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      rows[at] = 196;
      rows[at + 1] = 80;
      rows[at + 2] = 27;
    }
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(rows)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  };
}
export async function viewportShots(page: Page, info: TestInfo, stem: string) {
  mkdirSync("dist/e2e-shots", { recursive: true });
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    const widths = await page.evaluate(() => {
      const root = document.documentElement,
        content = document.querySelector('[data-testid="shell-content"]');
      return {
        root: [root.scrollWidth, root.clientWidth],
        content: content ? [content.scrollWidth, content.clientWidth] : null,
      };
    });
    expect(widths.root[0], `${stem} ${viewport.width} root`).toBeLessThanOrEqual(widths.root[1]!);
    if (widths.content)
      expect(widths.content[0], `${stem} ${viewport.width} content`).toBeLessThanOrEqual(
        widths.content[1]!,
      );
    const path = `dist/e2e-shots/${stem}-${viewport.width}.png`;
    await page.screenshot({ path, animations: "disabled" });
    await info.attach(`${stem}-${viewport.width}`, { path, contentType: "image/png" });
  }
  await page.setViewportSize({ width: 1366, height: 768 });
}
