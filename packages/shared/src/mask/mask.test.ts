import { describe, expect, it } from "vitest";

import {
  maskBankAccount,
  maskEmail,
  maskIp,
  maskLandline,
  maskLicenseNo,
  maskName,
  maskPhone,
  maskUscc,
} from "./index.js";

describe("规范 第 7 节的脱敏七例", () => {
  it("手机号：留前 3 后 4", () => {
    expect(maskPhone("13812345678")).toBe("138****5678");
  });

  it("姓名：留姓", () => {
    expect(maskName("王小明")).toBe("王**");
  });

  it("统一社会信用代码：留前 12 位与末 2 位", () => {
    expect(maskUscc("91510104MA6BXY1Z2R")).toBe("91510104MA6B****2R");
  });

  it("邮箱：留前缀的前几位与域名", () => {
    expect(maskEmail("yunjianhuoguo@163.com")).toBe("yunjian****@163.com");
  });

  it("座机：留区号与末 4 位", () => {
    expect(maskLandline("028-87653321")).toBe("028-****3321");
  });

  it("银行账号：只留末 4 位，银行名由调用方拼接", () => {
    expect(maskBankAccount("6225 8802 1234 6688")).toBe("****6688");
    expect(`招商银行 ${maskBankAccount("6225880212346688")}`).toBe("招商银行 ****6688");
  });

  it("许可证编号：末 6 位打码", () => {
    expect(maskLicenseNo("JY25101040012345")).toBe("JY25101040******");
  });
});

describe("D4 第 9.3 节另一种", () => {
  it("IP：隐去第三段", () => {
    expect(maskIp("182.139.7.52")).toBe("182.139.**.52");
    expect(maskIp("2408:8207::1")).toBe("**");
  });
});

describe("边界：不多露一位", () => {
  it("太短、留不出头尾时整串打码", () => {
    expect(maskPhone("1381234")).toBe("****");
    expect(maskUscc("91510104MA6B2R")).toBe("****");
    expect(maskBankAccount("6688")).toBe("****");
    expect(maskLicenseNo("12345")).toBe("*****");
    expect(maskName("")).toBe("");
    expect(maskEmail("no-at-sign")).toBe("****");
  });

  it("姓名不随长度变化；中间的星号不暴露原长", () => {
    expect(maskName("欧阳娜娜")).toBe("欧**");
    expect(maskName(" 李 ")).toBe("李**");
    expect(maskPhone("+8613812345678")).toBe("+86****5678");
  });

  it("邮箱前缀至多留 7 位；前缀不整个露出，只有 1 位时一位不留", () => {
    expect(maskEmail("averyverylongmailbox@example.com")).toBe("averyve****@example.com");
    expect(maskEmail("abc@x.com")).toBe("ab****@x.com");
    expect(maskEmail("ab@x.com")).toBe("a****@x.com");
    expect(maskEmail("a@x.com")).toBe("****@x.com");
  });

  it("座机没写连字符时按号段取区号", () => {
    expect(maskLandline("02887653321")).toBe("028-****3321");
    expect(maskLandline("(0816) 2233445")).toBe("0816-****3445");
    expect(maskLandline("87653321")).toBe("****3321");
  });
});
