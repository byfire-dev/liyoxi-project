// @ts-check
// 造测试片用的 mp4 / mov 字节级改写：ffmpeg 的命令行造不出来的三种片子靠它。只处理 32 位长度的 box。
//   rotate90        给视频轨写一个旋转 90 度的显示矩阵（竖拍手机视频的样子）
//   singleSync      把同步帧表改成只剩第一帧：往后定位都得从头解码（造“跑不完的输入”）
//   aliasReference  把视频轨的数据引用改成指向另一个文件的别名，并清空本文件的媒体数据（造“带外部引用的 mov”）

/**
 * @typedef {{ type: string, start: number, end: number, body: number }} Box
 */

/**
 * 列出 [start, end) 这一层的 box。
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 * @returns {Box[]}
 */
export function boxesIn(buf, start, end) {
  /** @type {Box[]} */
  const list = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size = buf.readUInt32BE(offset);
    if (size < 8 || offset + size > end) break;
    const type = buf.toString("latin1", offset + 4, offset + 8);
    list.push({ type, start: offset, end: offset + size, body: offset + 8 });
    offset += size;
  }
  return list;
}

/**
 * @param {Buffer} buf
 * @param {Box} parent
 * @param {string} type
 * @returns {Box}
 */
function child(buf, parent, type) {
  const found = boxesIn(buf, parent.body, parent.end).find((box) => box.type === type);
  if (!found) throw new Error(`${parent.type} 里没有 ${type}`);
  return found;
}

/**
 * 视频轨上的一串 box：moov、trak、mdia、minf。
 * @param {Buffer} buf
 */
function videoTrack(buf) {
  const top = boxesIn(buf, 0, buf.length);
  const moov = top.find((box) => box.type === "moov");
  const mdat = top.find((box) => box.type === "mdat");
  if (!moov || !mdat) throw new Error("没有 moov 或 mdat");
  for (const trak of boxesIn(buf, moov.body, moov.end).filter((box) => box.type === "trak")) {
    const mdia = child(buf, trak, "mdia");
    const hdlr = child(buf, mdia, "hdlr");
    // hdlr：版本与标志 4 字节、预留 4 字节、处理器类型 4 字节
    if (buf.toString("latin1", hdlr.body + 8, hdlr.body + 12) === "vide") {
      return { moov, mdat, trak, mdia, minf: child(buf, mdia, "minf") };
    }
  }
  throw new Error("没有视频轨");
}

/**
 * 原地改：视频轨的显示矩阵写成旋转 90 度。编码尺寸不变，播放器按旋转后的方向显示。
 * @param {Buffer} buf
 * @param {number} codedHeight 编码高度（矩阵里的平移量）
 */
export function rotate90(buf, codedHeight) {
  const { trak } = videoTrack(buf);
  const tkhd = child(buf, trak, "tkhd");
  // 版本 0 的时间字段是 32 位，版本 1 是 64 位；矩阵在它们与 16 字节的杂项之后
  const matrix = tkhd.body + (buf[tkhd.body] === 1 ? 52 : 40);
  const values = [0, 0x10000, 0, -0x10000, 0, 0, codedHeight * 0x10000, 0, 0x40000000];
  values.forEach((value, at) => buf.writeInt32BE(value, matrix + at * 4));
}

/**
 * 原地改：同步帧表只留第 1 帧，多出来的地方改成 free。文件大小与各偏移都不变。
 * @param {Buffer} buf
 */
export function singleSync(buf) {
  const { minf } = videoTrack(buf);
  const stss = child(buf, child(buf, minf, "stbl"), "stss");
  const count = buf.readUInt32BE(stss.body + 4);
  if (count < 3) throw new Error("同步帧不到 3 个，腾不出一个 free");
  buf.writeUInt32BE(20, stss.start); // 新的 stss：头 8、版本与标志 4、条数 4、一条 4
  buf.writeUInt32BE(1, stss.body + 4);
  buf.writeUInt32BE(1, stss.body + 8);
  buf.writeUInt32BE(stss.end - stss.start - 20, stss.start + 20);
  buf.write("free", stss.start + 24, "latin1");
  return count;
}

/**
 * 返回新文件：视频轨的数据引用改成一条 Mac 别名记录，指向同目录下的 targetName；本文件的 mdat 清零。
 * 要求 moov 在 mdat 之后（不带 faststart 的 mov），这样样本偏移不用改，对着 targetName 原文件正好读得到帧。
 * 别名记录的布局照 ffmpeg libavformat/mov.c 的 mov_read_dref 读它的顺序排。
 * @param {Buffer} source
 * @param {string} targetName
 * @returns {Buffer}
 */
export function aliasReference(source, targetName) {
  const buf = Buffer.from(source);
  const { moov, mdat, trak, mdia, minf } = videoTrack(buf);
  if (moov.start < mdat.start) throw new Error("moov 要在 mdat 之后");
  const dinf = child(buf, minf, "dinf");
  const dref = child(buf, dinf, "dref");

  const name = Buffer.from(targetName, "latin1");
  const path = Buffer.alloc(name.length + (name.length % 2));
  name.copy(path);
  const fixed = Buffer.alloc(150);
  // 10 字节略过；卷名长度 1 + 卷名 27（留空）；12 字节略过；文件名长度 1 + 文件名 63
  fixed[50] = name.length;
  name.copy(fixed, 51, 0, Math.min(name.length, 63));
  // 16 字节略过；从别名往上几层、从公共上级往下几层（各 1：同一个目录）
  fixed.writeUInt16BE(1, 130);
  fixed.writeUInt16BE(1, 132);
  // 16 字节略过；后面是带类型的记录：类型 2 是路径，类型 -1 结束
  const records = Buffer.alloc(4 + path.length + 4);
  records.writeInt16BE(2, 0);
  records.writeUInt16BE(name.length, 2);
  path.copy(records, 4);
  records.writeInt16BE(-1, 4 + path.length);

  const entry = Buffer.alloc(12);
  entry.writeUInt32BE(12 + fixed.length + records.length, 0);
  entry.write("alis", 4, "latin1");
  const head = Buffer.alloc(16);
  head.writeUInt32BE(16 + 12 + fixed.length + records.length, 0);
  head.write("dref", 4, "latin1");
  head.writeUInt32BE(1, 12); // 一条引用
  const replacement = Buffer.concat([head, entry, fixed, records]);

  const delta = replacement.length - (dref.end - dref.start);
  for (const box of [moov, trak, mdia, minf, dinf]) {
    buf.writeUInt32BE(box.end - box.start + delta, box.start);
  }
  buf.fill(0, mdat.body, mdat.end);
  return Buffer.concat([buf.subarray(0, dref.start), replacement, buf.subarray(dref.end)]);
}

/**
 * JPEG 的起止标记与尺寸（从第一个 SOF 段里读）。不是 JPEG 返回 null。
 * @param {Buffer} buf
 * @returns {{ width: number, height: number } | null}
 */
export function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  if (buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) return null;
  let offset = 2;
  while (offset + 9 < buf.length && buf[offset] === 0xff) {
    const marker = buf[offset + 1] ?? 0;
    const length = buf.readUInt16BE(offset + 2);
    // SOF0–SOF15，除去 DHT（C4）、JPG（C8）、DAC（CC）
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}
