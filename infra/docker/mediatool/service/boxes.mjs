// @ts-check
// mp4 / mov 顶层 box 的类型序列（只读各个 box 的头，不读内容）。
// 借自参考工程 packages/services/src/render/finalize.ts 的 topLevelBoxTypes、moovBeforeMdat。
import { open } from "node:fs/promises";

/**
 * @param {string} path
 * @param {number} size 文件大小
 * @returns {Promise<string[]>} 最多 64 个
 */
export async function topLevelBoxTypes(path, size) {
  const handle = await open(path, "r");
  /** @type {string[]} */
  const types = [];
  try {
    const header = Buffer.alloc(16);
    let offset = 0;
    while (offset + 8 <= size && types.length < 64) {
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) break;
      let boxSize = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      if (boxSize === 1) {
        // 64 位的长度写在类型后面
        if (bytesRead < 16) break;
        boxSize = Number(header.readBigUInt64BE(8));
      } else if (boxSize === 0) {
        // 一直到文件末尾
        boxSize = size - offset;
      }
      // 类型只留可打印的字符，免得把任意字节带进应答
      types.push(/^[\x20-\x7e]{4}$/.test(type) ? type : "????");
      if (boxSize < 8) break;
      offset += boxSize;
    }
  } finally {
    await handle.close();
  }
  return types;
}

/**
 * faststart 的判据：moov 在 mdat 之前。
 * @param {readonly string[]} types
 */
export function moovBeforeMdat(types) {
  const moov = types.indexOf("moov");
  const mdat = types.indexOf("mdat");
  return moov >= 0 && mdat >= 0 && moov < mdat;
}
