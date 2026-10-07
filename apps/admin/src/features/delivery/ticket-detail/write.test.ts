import { expect, it } from "vitest";
import { DeliveryFailure } from "./api";
import { deliveryFailureMessage } from "./write";

it("并发与 QC 按错误符号提示，方案问题逐条保留", () => {
  expect(deliveryFailureMessage(new DeliveryFailure("opaque", "VERSION_CONFLICT"))).toBe(
    "内容已被他人修改，请刷新；当前输入已保留",
  );
  expect(deliveryFailureMessage(new DeliveryFailure("opaque", "QC_SELF_INSPECTION"))).toContain(
    "上传人不能检查自己的文件",
  );
  expect(
    deliveryFailureMessage(new DeliveryFailure("opaque", "CHECKLIST_VERSION_STALE")),
  ).toContain("重新加载模板");
  expect(
    deliveryFailureMessage(
      new DeliveryFailure("方案内容不符合要求", "PLAN_CONTENT_INVALID", {
        issues: ["上线日过早", "发布账号缺失"],
      }),
    ),
  ).toBe("方案内容不符合要求：上线日过早；发布账号缺失");
  expect(deliveryFailureMessage(new Error("VERSION_CONFLICT"))).toBe("VERSION_CONFLICT");
});
