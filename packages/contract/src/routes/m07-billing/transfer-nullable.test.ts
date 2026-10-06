import { describe, expect, expectTypeOf, it } from "vitest";
import type { components as Merchant } from "@liyoxi/contract/types/merchant";
import type { components as Admin, operations } from "@liyoxi/contract/types/admin";
import type { DictRef } from "../../common/index.js";
import type { StaffBrief } from "../a01-system/structures.js";
import { A07_ERROR_DETAILS } from "../a07-billing-finance/error-details.js";
import {
  PaymentOrderAdminDetailSchema,
  TransferProofDetailSchema,
  TransferProofQueueItemSchema,
} from "../a07-billing-finance/purchase.schemas.js";
import { TransferProofViewSchema } from "./purchase.schemas.js";

type MerchantProof = NonNullable<Merchant["schemas"]["PaymentOrderDetail"]["latestTransferProof"]>;
type Detail = Admin["schemas"]["TransferProofDetail"];
type GeneratedStaff = Admin["schemas"]["StaffBrief"];
type Order = Admin["schemas"]["PaymentOrderAdminDetail"];
type QueueItem =
  operations["admin.transferProof.list"]["responses"][200]["content"]["application/json"]["data"]["items"][number];

describe("对公凭证可空引用的生成类型", () => {
  it("商家和财务消费真实空值与有值字段，具名组件自身仍完整", () => {
    expectTypeOf<MerchantProof["rejectReason"]>().toEqualTypeOf<DictRef | null>();
    expectTypeOf<Detail["rejectReason"]>().toEqualTypeOf<DictRef | null>();
    expectTypeOf<QueueItem["reviewedBy"]>().toEqualTypeOf<GeneratedStaff | null>();
    expectTypeOf<Detail["reviewedBy"]>().toEqualTypeOf<GeneratedStaff | null>();
    expectTypeOf<Detail["entity"]["managerStaff"]>().toEqualTypeOf<GeneratedStaff | null>();
    expectTypeOf<Detail["order"]["createdBy"]>().toEqualTypeOf<GeneratedStaff | null>();
    expectTypeOf<Order["createdBy"]>().toEqualTypeOf<GeneratedStaff | null>();
    expectTypeOf<
      Order["paymentTxns"][number]["confirmedBy"]
    >().toEqualTypeOf<GeneratedStaff | null>();
    expectTypeOf<
      Order["paymentTxns"][number]["reviewedBy"]
    >().toEqualTypeOf<GeneratedStaff | null>();
    expectTypeOf<Pick<GeneratedStaff, "staffId" | "staffNo" | "name">>().toEqualTypeOf<{
      staffId: string;
      staffNo: number;
      name: string;
    }>();
    expectTypeOf<Merchant["schemas"]["DictRef"]>().toEqualTypeOf<DictRef>();
    const pending: MerchantProof["rejectReason"] = null;
    const rejected: MerchantProof["rejectReason"] = { code: "bad_image", name: "图片不清" };
    expect(TransferProofViewSchema.shape.rejectReason.parse(pending)).toBeNull();
    expect(TransferProofDetailSchema.shape.rejectReason.parse(rejected)).toEqual(rejected);
  });

  it("所有财务员工引用及冲突银行均接受真实值，拒绝不完整对象", () => {
    const staff: StaffBrief = {
      staffId: "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b",
      staffNo: 1001,
      name: "测试财务",
      roleKey: "finance",
      isLead: false,
      status: "active",
    };
    for (const schema of [
      TransferProofQueueItemSchema.shape.entity.shape.managerStaff,
      TransferProofQueueItemSchema.shape.reviewedBy,
      TransferProofDetailSchema.shape.order.shape.createdBy,
      PaymentOrderAdminDetailSchema.shape.createdBy,
      PaymentOrderAdminDetailSchema.shape.paymentTxns.element.shape.confirmedBy,
      PaymentOrderAdminDetailSchema.shape.paymentTxns.element.shape.reviewedBy,
    ]) {
      expect(schema.parse(null)).toBeNull();
      expect(schema.parse(staff)).toEqual(staff);
      expect(schema.safeParse({}).success).toBe(false);
    }
    const conflicts = [
      { ref: "FK2026100600001", payerBank: null },
      { ref: "FK2026100600002", payerBank: { code: "bank_a", name: "测试银行" } },
    ];
    expect(A07_ERROR_DETAILS.BANK_SERIAL_DUPLICATE.parse({ conflicts })).toEqual({ conflicts });
    expect(
      A07_ERROR_DETAILS.BANK_SERIAL_DUPLICATE.safeParse({
        conflicts: [{ ref: "FK2026100600001", payerBank: {} }],
      }).success,
    ).toBe(false);
  });
});
