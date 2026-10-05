import { describe, expect, it } from "vitest";

import { BIDX, KEY_A, KEY_B, ringA, ringB, ringBA } from "./__fixtures__/keys.js";
import { decryptField, encryptField, kidOf } from "./crypto.js";
import { createKeyring, keyringFromEnv, SecurityError } from "./keyring.js";

// 验收第 6 条：换钥后能读旧密文。另有任务书 第 12 节点名的五类用例：往返、随机 IV、换钥解不开、
// 改一字节认证失败、密钥长度。

const COLUMN = "merchant_user.phone_enc";
const PHONE = "13812345678";

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof SecurityError) return error.code;
    throw error;
  }
  throw new Error("没有抛错");
};

describe("字段加密：密钥轮换", () => {
  it("用 A 加密；密钥环换成“当前 B、保留 A”后解密成功，新密文的 kid 是 B", () => {
    const old = encryptField(ringA, COLUMN, PHONE);
    expect(kidOf(old)).toBe("a");
    expect(decryptField(ringBA, COLUMN, old)).toBe(PHONE);

    const fresh = encryptField(ringBA, COLUMN, PHONE);
    expect(kidOf(fresh)).toBe("b");
    expect(fresh.startsWith("v1:b:")).toBe(true);
    expect(decryptField(ringBA, COLUMN, fresh)).toBe(PHONE);
  });

  it("去掉 A 后解旧密文失败，报的是“密钥不在密钥环里”；新密文照样能解", () => {
    const old = encryptField(ringA, COLUMN, PHONE);
    expect(codeOf(() => decryptField(ringB, COLUMN, old))).toBe("unknown_kid");
    expect(() => decryptField(ringB, COLUMN, old)).toThrow(
      "merchant_user.phone_enc 的密文用的密钥 a 不在密钥环里：旧密钥要留到重加密完成之后才能拿掉",
    );
    expect(decryptField(ringB, COLUMN, encryptField(ringBA, COLUMN, PHONE))).toBe(PHONE);
  });

  it("kid 相同、密钥不同：解不开，报认证失败", () => {
    const swapped = createKeyring({ data: { current: "a", keys: { a: KEY_B } }, bidx: BIDX });
    const sealed = encryptField(ringA, COLUMN, PHONE);
    expect(codeOf(() => decryptField(swapped, COLUMN, sealed))).toBe("decrypt_failed");
  });
});

describe("字段加密：格式与认证", () => {
  it("往返；密文是 v1:<kid>:<base64url>；同一明文两次密文不同（随机 IV）", () => {
    const first = encryptField(ringA, COLUMN, PHONE);
    const second = encryptField(ringA, COLUMN, PHONE);
    expect(first).toMatch(/^v1:[^:]+:[A-Za-z0-9_-]+$/);
    expect(first).not.toBe(second);
    expect(decryptField(ringA, COLUMN, first)).toBe(PHONE);
    // iv 12 + 明文 11 + tag 16 = 39 字节
    expect(Buffer.from(first.split(":")[2] as string, "base64url")).toHaveLength(39);
  });

  it("空串、中文、表情、NUL 都能往返", () => {
    for (const text of ["", "成都市高新区天府大道 1 号", "🦝有戏", "a\u0000b"]) {
      expect(decryptField(ringA, COLUMN, encryptField(ringA, COLUMN, text))).toBe(text);
    }
  });

  it("改密文一字节：认证失败", () => {
    const sealed = encryptField(ringA, COLUMN, PHONE);
    const bytes = Buffer.from(sealed.split(":")[2] as string, "base64url");
    for (const index of [0, 12, bytes.length - 1]) {
      const copy = Buffer.from(bytes);
      copy[index] = (copy[index] as number) ^ 0x01;
      const tampered = `v1:a:${copy.toString("base64url")}`;
      expect(codeOf(() => decryptField(ringA, COLUMN, tampered))).toBe("decrypt_failed");
    }
  });

  it("密文挪到别的列（AAD 不符）：解不开", () => {
    const sealed = encryptField(ringA, COLUMN, PHONE);
    expect(codeOf(() => decryptField(ringA, "staff.phone_enc", sealed))).toBe("decrypt_failed");
  });

  it("不是 v1 的写法、太短：报格式错", () => {
    for (const text of ["", PHONE, "v2:a:AAAA", "v1::AAAA", "v1:a:", "v1:a:AAAA", "v1:a:b:c"]) {
      expect(codeOf(() => decryptField(ringA, COLUMN, text))).toBe("ciphertext_format");
    }
    expect(kidOf("v1:a:b:c")).toBeUndefined();
    expect(kidOf(PHONE)).toBeUndefined();
  });

  it("明文里有不成对的代理项：拒绝加密（它过不了 UTF-8，解出来会与原文不同）", () => {
    expect(codeOf(() => encryptField(ringA, COLUMN, "a\ud800b"))).toBe("plaintext_invalid");
    expect(codeOf(() => encryptField(ringA, COLUMN, "\udc00"))).toBe("plaintext_invalid");
  });

  it("报错里没有明文、密文、密钥", () => {
    const sealed = encryptField(ringA, COLUMN, PHONE);
    const body = sealed.split(":")[2] as string;
    const errors = [
      () => decryptField(ringB, COLUMN, sealed),
      () => decryptField(ringA, "staff.phone_enc", sealed),
      () => decryptField(ringA, COLUMN, `v9:${body}`),
      () => encryptField(ringA, COLUMN, `${PHONE}\ud800`),
    ].map((fn) => {
      try {
        fn();
      } catch (error) {
        return String((error as Error).message);
      }
      return "";
    });
    for (const message of errors) {
      expect(message).not.toBe("");
      for (const secret of [PHONE, body, KEY_A.toString("base64"), KEY_A.toString("hex")]) {
        expect(message).not.toContain(secret);
      }
    }
  });
});

describe("密钥环", () => {
  const good = { current: "a", keys: { a: KEY_A } };

  it("密钥收在闭包里：序列化、展开密钥环都带不出密钥", () => {
    const text = `${JSON.stringify(ringBA)} ${Object.values(ringBA).join(" ")}`;
    for (const key of [KEY_A, KEY_B, BIDX.phone]) {
      expect(text).not.toContain(key.toString("base64"));
      expect(text).not.toContain(key.toString("hex"));
    }
    expect(ringBA.kids).toEqual(["a", "b"]);
    expect(ringBA.currentKid).toBe("b");
  });

  it("收 base64、base64url 文本与字节三种写法", () => {
    const ring = createKeyring({
      data: { current: "a", keys: { a: KEY_A.toString("base64"), b: new Uint8Array(KEY_B) } },
      bidx: { phone: BIDX.phone.toString("base64url"), uscc: BIDX.uscc },
    });
    expect(decryptField(ring, COLUMN, encryptField(ringA, COLUMN, PHONE))).toBe(PHONE);
  });

  it.each([
    ["密钥 31 字节", { data: { current: "a", keys: { a: KEY_A.subarray(1) } }, bidx: BIDX }],
    ["密钥 33 字节", { data: good, bidx: { ...BIDX, uscc: Buffer.alloc(33, 1) } }],
    ["当前 kid 不在密钥环里", { data: { current: "z", keys: { a: KEY_A } }, bidx: BIDX }],
    ["没有数据密钥", { data: { current: "a", keys: {} }, bidx: BIDX }],
    ["kid 带冒号", { data: { current: "a:1", keys: { "a:1": KEY_A } }, bidx: BIDX }],
    ["缺一个用途的盲索引密钥", { data: good, bidx: { phone: BIDX.phone } }],
    ["两种用途共用一把密钥", { data: good, bidx: { phone: BIDX.phone, uscc: BIDX.phone } }],
    ["盲索引密钥与数据密钥相同", { data: good, bidx: { phone: KEY_A, uscc: BIDX.uscc } }],
  ])("%s：造不出来", (_label, input) => {
    expect(codeOf(() => createKeyring(input))).toBe("keyring_invalid");
  });

  it("keyringFromEnv：两份都给才造得出来；没配报 keyring_missing", () => {
    const DATA_KEYS = { current: "a", keys: { a: KEY_A.toString("base64") } };
    const BIDX_KEYS = { phone: BIDX.phone.toString("base64"), uscc: BIDX.uscc.toString("base64") };
    expect(keyringFromEnv({ DATA_KEYS, BIDX_KEYS }).currentKid).toBe("a");
    expect(codeOf(() => keyringFromEnv({}))).toBe("keyring_missing");
    expect(codeOf(() => keyringFromEnv({ DATA_KEYS }))).toBe("keyring_missing");
  });
});
