import { InvoiceRequestAdminDetailSchema } from "@liyoxi/contract";
import type { AccessSnapshot } from "../../../lib/permissions";
import type { InvoiceDetail } from "./types";
export const invoiceId = "0199aabb-ccdd-7eef-8a01-112233445566";
export const fileId = "0199aabb-ccdd-7eef-8a01-112233445567";
export const access: AccessSnapshot = {
  staff: { id: fileId, name: "虚构财务", roleKey: "finance", roleName: "财务" },
  isLead: false,
  moduleLevels: { finance: "e" },
  actions: ["finance.invoice.issue", "finance.invoice.red"],
  dataScope: "all",
  releases: {},
};
export function invoiceFixture(): InvoiceDetail {
  return InvoiceRequestAdminDetailSchema.parse({
    invoiceRequestId: invoiceId,
    requestNo: "KP-FIXTURE",
    entity: {
      entityId: fileId,
      name: "虚构主体",
      primaryStoreId: null,
      primaryStoreName: null,
      storeCount: 1,
      verificationStatus: "verified",
      managerStaff: null,
    },
    paymentOrder: {
      paymentOrderId: fileId,
      orderNo: "FK-FIXTURE",
      type: "plan_new",
      title: "虚构套餐",
    },
    amountFen: 100,
    invoiceType: "normal",
    medium: "electronic",
    needsMail: false,
    status: "pending",
    appliedAt: "2030-10-01T01:00:00.000Z",
    dueAt: null,
    isHeldByRefund: false,
    resultNote: null,
    title: "虚构主体",
    taxNoMask: "91****00",
    addrTelMask: null,
    bankAccountMask: null,
    recvEmailMask: "f***@example.invalid",
    mailToMask: null,
    itemName: "虚构服务",
    orderPaidAt: "2030-10-01T00:00:00.000Z",
    orderChannel: "bank_transfer",
    prechecks: [{ key: "order_paid_not_refunded", passed: true }],
    heldByRefund: null,
    docs: [],
    reject: null,
    lockVersion: 7,
    actions: ["issue", "reject"],
  });
}
