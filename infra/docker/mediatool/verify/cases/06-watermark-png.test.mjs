// @ts-check
// 实际固定字体渲染与像素测量；最长店名不裁切，正式文案未省略。
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { test } from "node:test";
import { call, fx } from "../lib/client.mjs";
import { FX } from "../lib/spec.mjs";

/** @param {Buffer} png */
function bounds(png) {
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 720);
  assert.equal(png.readUInt32BE(20), 96);
  assert.equal(png[24], 8);
  assert.equal(png[25], 6);
  /** @type {Buffer[]} */ const data = [];
  for (let offset = 8; offset < png.length;) {
    const n = png.readUInt32BE(offset),
      type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") data.push(png.subarray(offset + 8, offset + 8 + n));
    offset += n + 12;
  }
  const stride = 720 * 4,
    raw = inflateSync(Buffer.concat(data), { maxOutputLength: (stride + 1) * 96 });
  assert.equal(raw.length, (stride + 1) * 96);
  const previous = Buffer.alloc(stride),
    row = Buffer.alloc(stride);
  const result = [
    { minX: 720, maxX: -1, minY: 96, maxY: -1, count: 0 },
    { minX: 720, maxX: -1, minY: 96, maxY: -1, count: 0 },
  ];
  for (let y = 0; y < 96; y++) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter !== undefined && filter <= 4);
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? (row[i - 4] ?? 0) : 0,
        b = previous[i] ?? 0,
        c = i >= 4 ? (previous[i - 4] ?? 0) : 0;
      const p = a + b - c,
        pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c);
      const prediction =
        filter === 0
          ? 0
          : filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? Math.floor((a + b) / 2)
                : pa <= pb && pa <= pc
                  ? a
                  : pb <= pc
                    ? b
                    : c;
      row[i] = ((raw[y * (stride + 1) + 1 + i] ?? 0) + prediction) & 255;
    }
    for (let x = 0; x < 720; x++)
      if (row[x * 4 + 3]) {
        const line = result[y < 48 ? 0 : 1];
        assert.ok(line);
        line.minX = Math.min(line.minX, x);
        line.maxX = Math.max(line.maxX, x);
        line.minY = Math.min(line.minY, y);
        line.maxY = Math.max(line.maxY, y);
        line.count++;
      }
    row.copy(previous);
  }
  return result;
}

test("固定许可CJK字体：十字最长店名、完整文案与日期两行实际RGBA不裁边", async (t) => {
  const text = "样片 · 仅供「十字商家名称完整店铺」确认 · 10-09";
  const outPath = `${FX}/watermark.png`,
    answer = await call("POST", "/watermarkPng", { text, outPath });
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  const png = readFileSync(fx("watermark.png"));
  assert.equal(answer.json.sizeBytes, png.length);
  assert.ok(png.length <= 1024 ** 2);
  assert.deepEqual([answer.json.width, answer.json.height], [720, 96]);
  const [first, second] = bounds(png);
  assert.ok(first && second);
  for (const line of [first, second]) {
    assert.ok(line.count > 100, "真实透明画布上每行必须有文字像素");
    assert.ok(
      line.minX > 0 && line.maxX < 719 && line.minY > 0 && line.maxY < 95,
      JSON.stringify(line),
    );
  }
  assert.ok(first.maxX - first.minX > 450, "最长中文行实际渲染足够宽，未省略店名");
  assert.ok(second.maxX - second.minX > 50, "日期独立渲染");
  assert.ok(
    !existsSync(fx("watermark.png.first.txt")) &&
      !existsSync(fx("watermark.png.second.txt")) &&
      !existsSync(fx("watermark.png.part")),
  );
  t.diagnostic(
    `水印完整文字=${text};实际像素=${JSON.stringify([first, second])};bytes=${png.length}`,
  );
});

test("固定PNG水印入参不能引入过滤器/控制字符/任意文件路径", async () => {
  for (const body of [
    { text: "样片 · 仅供「门店」确认 · 10-09\n", outPath: `${FX}/watermark.png` },
    { text: "movie=https://external.invalid", outPath: `${FX}/watermark.png` },
    { text: "样片 · 仅供「门店」确认 · 10-09", outPath: "../watermark.png" },
    { text: "样片 · 仅供「门店」确认 · 10-09", outPath: `${FX}/other.png` },
    {
      text: "样片 · 仅供「门店」确认 · 10-09",
      outPath: `${FX}/watermark.png`,
      font: "/tmp/other.ttf",
    },
  ]) {
    const answer = await call("POST", "/watermarkPng", body);
    assert.ok(answer.status >= 400 && answer.status < 500, JSON.stringify(answer));
  }
});

test("不存在的字体字符受控拒绝，不把tofu当完整店名", async () => {
  const answer = await call("POST", "/watermarkPng", {
    text: "样片 · 仅供「\u{10ffff}」确认 · 10-09",
    outPath: `${FX}/watermark.png`,
  });
  assert.equal(answer.status, 422);
  assert.equal(answer.json.error.code, "unsupported_glyph");
});
