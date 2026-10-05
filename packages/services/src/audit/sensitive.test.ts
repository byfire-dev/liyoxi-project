import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { diffFields } from "./diff.js";
import { cleanJson } from "./sanitize.js";
import { sensitiveRule } from "./sensitive.js";

// 敏感键清单的固定用例：哪些键剔除、哪些脱敏、哪些长得像但不算；库里的密文列逐个核对。

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
      ["payeeAccount", "6225880212346688", "****6688"],
      ["payee_account", "6225880212346688", "****6688"],
      ["taxNo", "91510107MA6CABCD7K", "91510107MA6C****7K"],
      ["tax_no", "91510107MA6CABCD7K", "91510107MA6C****7K"],
      ["principalName", "王小明", "王**"],
      ["mailTo", "李女士 13912342046 成都市武侯区人民南路四段 1 号", "****"],
      ["externalUserid", "wmEAlECwAAHrbWYDOK5u3Af13xlYDnGg", "****"],
      ["external_user_id", "wmEAlECwAAHrbWYDOK5u3Af13xlYDnGg", "****"],
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

  it("复数写法同单数：剔除的照剔除，脱敏的逐项脱敏", () => {
    expect(
      cleanJson(
        {
          phones: ["13812345678", "13912342046"],
          emails: ["yunjianxiaodian@163.com"],
          bank_accounts: ["6225880212346688"],
          accountNos: ["6225880212346688"],
          passwords: ["p"],
          accessTokens: ["t"],
          smsCodes: ["123456"],
        },
        true,
      ),
    ).toEqual({
      phones: ["138****5678", "139****2046"],
      emails: ["yunjian****@163.com"],
      bank_accounts: ["****6688"],
      accountNos: ["****6688"],
    });
  });

  it("收件信息写成对象时整个打码；求差的结果里账号、税号不出明文", () => {
    expect(
      cleanJson({ mailTo: { name: "李女士", phone: "13912342046", address: "成都市" } }, true),
    ).toEqual({ mailTo: "****" });
    expect(
      diffFields(
        { payeeAccount: "6225880212346688", taxNo: "91510107MA6CABCD7K" },
        { payeeAccount: "6225880299996688", taxNo: "91510107MA6CWXYZ7K" },
        ["payeeAccount", "taxNo"],
      ),
    ).toEqual({
      before: { payeeAccount: "****6688", taxNo: "91510107MA6C****7K" },
      after: { payeeAccount: "****6688", taxNo: "91510107MA6C****7K" },
    });
  });

  // 库里凡是有密文列（<名>_enc）或盲索引列（<名>_bidx）的字段，它的明文名写进审计都得命中规则：
  // 审计表只追加，明文写进去删不掉。这里直接读 schema.prisma，往后新加的密文列自动进来；
  // 红了就往 sensitive.ts 里加词，整包密文（明文是一个 JSON，键名说明不了内容）才列进下面的例外。
  it("schema.prisma 里每个密文列、盲索引列的明文名，驼峰与蛇形写法都命中规则", () => {
    /** 整包密文：明文是一整个 JSON（识别结果、厂商原始返回、商家提交值、审核员修正值），里面各层的键照常按键名处理 */
    const wholeBlobs = ["fields", "raw", "submitted_fields", "reviewed_fields"];
    const schema = readFileSync(
      fileURLToPath(new URL("../../../db/prisma/schema.prisma", import.meta.url)),
      "utf8",
    );
    const names = new Set(
      Array.from(
        schema.matchAll(/@map\("([a-z0-9_]+)_(?:enc|bidx)"\)/g),
        (match) => match[1] ?? "",
      ),
    );
    // 取不到列说明 schema 的写法变了，这条用例等于没在查
    expect(names.size).toBeGreaterThan(wholeBlobs.length);
    const camel = (snake: string): string =>
      snake.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
    const missed = [...names]
      .filter((name) => !wholeBlobs.includes(name))
      .flatMap((name) => [name, camel(name)])
      .filter((key) => sensitiveRule(key) === undefined);
    expect(missed, "这些明文名没有命中敏感键规则，往 sensitive.ts 里加词").toEqual([]);
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
      principalRole: "legal_rep",
      wecomUserid: "zhangsan",
      merchantUserId: "0198c0de-0000-7000-8000-000000000002",
      payeeName: "成都云间小店餐饮有限公司",
      payeeBank: "招商银行成都分行",
      userReceivedAccount: "支付用户零钱",
      taxRate: 600,
      address: "成都市武侯区人民南路四段 1 号",
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
