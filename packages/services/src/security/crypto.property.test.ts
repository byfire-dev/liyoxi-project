import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ringA, ringB, ringBA } from "./__fixtures__/keys.js";
import { blindIndex, normalizePhone, normalizeUscc } from "./bidx.js";
import { decryptField, encryptField } from "./crypto.js";
import { BIDX_PURPOSES, SecurityError } from "./keyring.js";

// 验收第 8 条（甲类的性质测试；D4 第 11.1 节“加密与盲索引”）。
// 轮次与种子的约定同 kernel：PR 上固定种子、每个性质 200 轮；要加大或复现用环境变量，例：
//   LYX_FC_RUNS=5000 LYX_FC_SEED=42 pnpm --filter @liyoxi/services exec vitest run src/security/crypto.property.test.ts
// 失败时把反例固化成 crypto.test.ts 里的固定用例再修。
const runs = {
  numRuns: Number(process.env.LYX_FC_RUNS ?? 200),
  seed: Number(process.env.LYX_FC_SEED ?? 20261005),
};

/** 任意合法的 Unicode 文本：全部码点，含 NUL，不含不成对的代理项 */
const text = fc.string({ unit: "binary", maxLength: 200 });
const column = fc
  .tuple(fc.stringMatching(/^[a-z][a-z_]{0,20}$/), fc.stringMatching(/^[a-z][a-z_]{0,20}$/))
  .map(([table, name]) => `${table}.${name}_enc` as const);
const purpose = fc.constantFrom(...BIDX_PURPOSES);

const failsWith = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof SecurityError ? error.code : `不是 SecurityError：${String(error)}`;
  }
  return undefined;
};

describe("字段加密：性质", () => {
  it("任意输入加密后可还原；密文匹配 ^v1:[^:]+:[A-Za-z0-9_-]+$；旧 kid 的密文轮换后仍可解", () => {
    fc.assert(
      fc.property(text, column, (plain, col) => {
        const sealed = encryptField(ringA, col, plain);
        expect(sealed).toMatch(/^v1:[^:]+:[A-Za-z0-9_-]+$/);
        expect(decryptField(ringA, col, sealed)).toBe(plain);
        expect(decryptField(ringBA, col, sealed)).toBe(plain);
        expect(failsWith(() => decryptField(ringB, col, sealed))).toBe("unknown_kid");
      }),
      runs,
    );
  });

  it("同值两次加密密文不同、盲索引相同；盲索引 32 字节", () => {
    fc.assert(
      fc.property(text, column, purpose, (plain, col, use) => {
        expect(encryptField(ringA, col, plain)).not.toBe(encryptField(ringA, col, plain));
        const index = blindIndex(ringA, use, plain);
        expect(index).toHaveLength(32);
        expect(index.equals(blindIndex(ringA, use, plain))).toBe(true);
        // 盲索引只看盲索引密钥：数据密钥轮换不影响它
        expect(index.equals(blindIndex(ringBA, use, plain))).toBe(true);
      }),
      runs,
    );
  });

  it("改密文任意一字节解密失败", () => {
    fc.assert(
      fc.property(
        text,
        column,
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (plain, col, at, flip) => {
          const [version, kid, body] = encryptField(ringA, col, plain).split(":") as [
            string,
            string,
            string,
          ];
          const bytes = Buffer.from(body, "base64url");
          const index = at % bytes.length;
          bytes[index] = (bytes[index] as number) ^ flip;
          const tampered = `${version}:${kid}:${bytes.toString("base64url")}`;
          expect(failsWith(() => decryptField(ringA, col, tampered))).toBe("decrypt_failed");
        },
      ),
      runs,
    );
  });

  it("换 AAD（密文挪到别的列）解密失败", () => {
    fc.assert(
      fc.property(text, column, column, (plain, col, other) => {
        fc.pre(col !== other);
        const sealed = encryptField(ringA, col, plain);
        expect(failsWith(() => decryptField(ringA, other, sealed))).toBe("decrypt_failed");
      }),
      runs,
    );
  });

  it("任意字符串当密文去解：只会报 SecurityError，不会抛别的", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 120 }), (garbage) => {
        const code = failsWith(() => decryptField(ringA, "t.c_enc", garbage));
        expect(["ciphertext_format", "unknown_kid", "decrypt_failed"]).toContain(code);
      }),
      runs,
    );
  });
});

describe("盲索引：性质", () => {
  const digits = fc.stringMatching(/^1[3-9][0-9]{9}$/);

  it("手机号归一化等价的写法盲索引相同：+86、0086、86、空格与连字符", () => {
    fc.assert(
      fc.property(digits, (phone) => {
        const index = blindIndex(ringA, "phone", phone);
        const spaced = `${phone.slice(0, 3)} ${phone.slice(3, 7)}-${phone.slice(7)}`;
        for (const written of [
          `+86${phone}`,
          `+86 ${spaced}`,
          `0086${phone}`,
          `86${phone}`,
          spaced,
        ]) {
          expect(normalizePhone(written)).toBe(phone);
          expect(blindIndex(ringA, "phone", written).equals(index)).toBe(true);
        }
      }),
      runs,
    );
  });

  it("信用代码归一化等价的写法盲索引相同：大小写、空白", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9A-Z]{18}$/), (uscc) => {
        const index = blindIndex(ringA, "uscc", uscc);
        const written = ` ${uscc.slice(0, 8).toLowerCase()} ${uscc.slice(8)}\t`;
        expect(normalizeUscc(written)).toBe(uscc);
        expect(blindIndex(ringA, "uscc", written).equals(index)).toBe(true);
      }),
      runs,
    );
  });

  it("同一明文在 phone、uscc 两种用途下不同；不同的手机号不同", () => {
    fc.assert(
      fc.property(digits, digits, (one, other) => {
        expect(blindIndex(ringA, "phone", one).equals(blindIndex(ringA, "uscc", one))).toBe(false);
        fc.pre(one !== other);
        expect(blindIndex(ringA, "phone", one).equals(blindIndex(ringA, "phone", other))).toBe(
          false,
        );
      }),
      runs,
    );
  });
});
