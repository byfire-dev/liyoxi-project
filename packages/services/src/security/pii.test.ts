import { describe, expect, it } from "vitest";

import { BIDX, fakeKey, KEY_A, ringA, ringBA } from "./__fixtures__/keys.js";
import { blindIndex } from "./bidx.js";
import { kidOf } from "./crypto.js";
import { createKeyring, SecurityError } from "./keyring.js";
import type { Keyring } from "./keyring.js";
import { openField, phoneBidx, sealBankAccount, sealPhone, sealUscc, usccBidx } from "./pii.js";
import { loadKeyring, selfCheck } from "./selfcheck.js";

// 验收第 9 条：三件套与自检。脱敏串的例子取自规范 第 7 节“脱敏”表。

describe("敏感字段三件套", () => {
  it("手机号：密文、盲索引、脱敏串 138****5678、后四位；入库的是归一化后的号码", () => {
    const sealed = sealPhone(ringA, "merchant_user.phone_enc", "+86 138-1234-5678");
    expect(sealed.mask).toBe("138****5678");
    expect(sealed.last4).toBe("5678");
    expect(sealed.enc).toMatch(/^v1:a:[A-Za-z0-9_-]+$/);
    expect(sealed.bidx).toHaveLength(32);
    expect(openField(ringA, "merchant_user.phone_enc", sealed.enc)).toBe("13812345678");
    // 查找时用同一个函数：写法不同，盲索引相同
    expect(sealed.bidx.equals(phoneBidx(ringA, "13812345678"))).toBe(true);
    expect(sealed.bidx.equals(phoneBidx(ringA, "8613812345678"))).toBe(true);
    expect(sealed.bidx.equals(phoneBidx(ringA, "13812345679"))).toBe(false);
  });

  it("统一社会信用代码：密文、盲索引、脱敏串 91510104MA6B****2R", () => {
    const sealed = sealUscc(ringA, "entity.uscc_enc", " 91510104ma6bxy1z2r ");
    expect(sealed.mask).toBe("91510104MA6B****2R");
    expect(sealed.bidx).toHaveLength(32);
    expect(openField(ringA, "entity.uscc_enc", sealed.enc)).toBe("91510104MA6BXY1Z2R");
    expect(sealed.bidx.equals(usccBidx(ringA, "91510104MA6BXY1Z2R"))).toBe(true);
    // 两种用途各用各的密钥：同一串字符算出来不同
    expect(sealed.bidx.equals(blindIndex(ringA, "phone", "91510104MA6BXY1Z2R"))).toBe(false);
  });

  it("银行账号：密文与脱敏串 ****6688，没有盲索引", () => {
    const sealed = sealBankAccount(
      ringA,
      "invoice_request.bank_account_enc",
      "6225 8802 1234 6688",
    );
    expect(sealed).toEqual({ enc: expect.stringMatching(/^v1:a:/), mask: "****6688" });
    expect(openField(ringA, "invoice_request.bank_account_enc", sealed.enc)).toBe(
      "6225880212346688",
    );
  });

  it("轮换之后新写的三件套用当前密钥，盲索引不变", () => {
    const before = sealPhone(ringA, "staff.phone_enc", "13812345678");
    const after = sealPhone(ringBA, "staff.phone_enc", "13812345678");
    expect(kidOf(after.enc)).toBe("b");
    expect(after.bidx.equals(before.bidx)).toBe(true);
    expect(openField(ringBA, "staff.phone_enc", before.enc)).toBe("13812345678");
  });
});

describe("启动自检", () => {
  const DATA_KEYS = { current: "a", keys: { a: KEY_A.toString("base64") } };
  const BIDX_KEYS = { phone: BIDX.phone.toString("base64"), uscc: BIDX.uscc.toString("base64") };
  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (error) {
      return error instanceof SecurityError ? error.code : String(error);
    }
    return undefined;
  };

  it("密钥齐全：自检通过，返回可用的密钥环", () => {
    expect(() => selfCheck(ringBA)).not.toThrow();
    const ring = loadKeyring({ DATA_KEYS, BIDX_KEYS });
    expect(openField(ring, "t.c_enc", sealPhone(ringA, "t.c_enc", "13812345678").enc)).toBe(
      "13812345678",
    );
  });

  it("密钥缺失：自检失败", () => {
    expect(codeOf(() => loadKeyring({}))).toBe("keyring_missing");
    expect(codeOf(() => loadKeyring({ DATA_KEYS }))).toBe("keyring_missing");
    expect(codeOf(() => loadKeyring({ DATA_KEYS, BIDX_KEYS: { phone: BIDX_KEYS.phone } }))).toBe(
      "keyring_invalid",
    );
  });

  it("密钥长度不对：自检失败", () => {
    const short = fakeKey(7).subarray(0, 16).toString("base64");
    expect(
      codeOf(() => loadKeyring({ DATA_KEYS: { current: "a", keys: { a: short } }, BIDX_KEYS })),
    ).toBe("keyring_invalid");
    expect(codeOf(() => loadKeyring({ DATA_KEYS, BIDX_KEYS: { ...BIDX_KEYS, uscc: short } }))).toBe(
      "keyring_invalid",
    );
  });

  it("密钥环自己不合格（绕过了构造函数）：自检拦得住", () => {
    const good = createKeyring({ data: { current: "a", keys: { a: KEY_A } }, bidx: BIDX });
    const broken: Record<string, Keyring> = {
      当前密钥取不到: { ...good, dataKey: () => undefined },
      数据密钥太短: { ...good, dataKey: () => KEY_A.subarray(0, 16) },
      盲索引密钥每次不同: {
        ...good,
        bidxKey: () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
      },
    };
    for (const [label, ring] of Object.entries(broken)) {
      expect(
        codeOf(() => selfCheck(ring)),
        label,
      ).toBe("selfcheck_failed");
    }
  });
});
