import { describe, expect, it } from "vitest";

import { cleanJson } from "./sanitize.js";
import { sensitiveRule } from "./sensitive.js";

// 敏感键清单的固定用例：哪些键剔除、哪些脱敏、哪些长得像但不算。

describe("敏感键", () => {
  it("口令、令牌、动态码、恢复码、密文与盲索引：剔除", () => {
    const keys = [
      ...[
        "password",
        "passwordHash",
        "password_hash",
        "newPassword",
        "pwd",
        "secret",
        "totpSecret",
      ],
      ...["mfa_key", "accessToken", "refresh_token", "token", "recoveryCodes", "recovery_codes"],
      ...["smsCode", "verify_code", "activationCode", "resetCode", "apiKey", "privateKey"],
      ...["phoneEnc", "phone_enc", "newPhoneEnc", "phone_bidx", "usccBidx", "cookie", "signature"],
    ];
    for (const key of keys) expect(sensitiveRule(key), key).toBe("drop");
  });

  it("手机号、证照号、信用代码、银行账号、邮箱、法定代表人姓名：脱敏", () => {
    const masked: Array<[string, string, string]> = [
      ["phone", "13812345678", "138****5678"],
      ["contactPhone", "13812345678", "138****5678"],
      ["new_phone", "13812345678", "138****5678"],
      ["mobile", "13812345678", "138****5678"],
      ["landline", "028-85553321", "028-****3321"],
      ["uscc", "91510104MA6BXY1Z2R", "91510104MA6B****2R"],
      ["creditCode", "91510104MA6BXY1Z2R", "91510104MA6B****2R"],
      ["licenseNo", "JY25101040012345", "JY25101040******"],
      ["permit_no", "JY25101040012345", "JY25101040******"],
      ["idCardNo", "510104199001011234", "510104199001******"],
      ["bankAccount", "6225880212346688", "****6688"],
      ["bank_account_no", "6225 8802 1234 6688", "****6688"],
      ["accountNo", "6225880212346688", "****6688"],
      ["cardNumber", "6225880212346688", "****6688"],
      ["email", "yunjianxiaodian@163.com", "yunjian****@163.com"],
      ["legalRepName", "王小明", "王**"],
    ];
    for (const [key, plain, want] of masked) {
      expect(cleanJson({ [key]: plain }, true), key).toEqual({ [key]: want });
    }
  });

  it("敏感键下面的数字、数组、对象、空值", () => {
    expect(cleanJson({ phone: 13812345678, phones: null }, true)).toEqual({
      phone: "138****5678",
      phones: null,
    });
    expect(cleanJson({ phone: ["13812345678", { raw: "13812345678" }, true] }, true)).toEqual({
      phone: ["138****5678", "****", "****"],
    });
  });

  it("已经是脱敏值的列、长得像但不算的键：原样", () => {
    const plain = {
      phoneMask: "138****5678",
      phone_last4: "5678",
      bankName: "招商银行",
      channelAccountId: "0198c0de-0000-7000-8000-000000000001",
      account: "星河洗车官方号",
      dormantBypassUntil: "2026-01-05T04:00:00.000Z",
      fileSha256: "ab".repeat(32),
      targetKey: "finance",
      licenseType: "food",
      licenseValidTo: "2027-01-01",
      status: "active",
      name: "星河洗车",
      encoding: "utf8",
      code: "R01",
    };
    expect(cleanJson(plain, true)).toEqual(plain);
    for (const key of Object.keys(plain)) expect(sensitiveRule(key), key).toBeUndefined();
  });

  it("不开脱敏时（求差时比原值用）敏感键原样留", () => {
    expect(cleanJson({ phone: "13812345678", password: "p" }, false)).toEqual({
      phone: "13812345678",
      password: "p",
    });
  });
});
