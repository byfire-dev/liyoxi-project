import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Input, Modal, Skeleton } from "antd";
import { useState } from "react";
import type { AppServices } from "../../../app/services";
import { InfoList } from "../../../components/InfoList";
import { ErrorState } from "../../../components/StateBlock";
import { BillingDialog } from "../../billing/plans/dialog";
import { createBillingIntent, moneyText } from "../../billing/plans/model";
import {
  readProofPermission,
  type PaymentDetail,
  type PaymentOrdersApi,
} from "../orders/payment-api";
import { StoredReceipt } from "./upload";
import { proofBody } from "./model";
export function ProofDialog({
  order,
  api,
  services,
  scope,
  canUpload,
  onClose,
  onSaved,
}: {
  order: PaymentDetail;
  api: PaymentOrdersApi;
  services: AppServices;
  scope: string;
  canUpload: boolean;
  onClose(): void;
  onSaved(): void;
}) {
  const [intent] = useState(() => createBillingIntent("transfer-proof-create")),
    [fileId, setFileId] = useState<string | null>(null),
    [note, setNote] = useState("");
  const permission = useQuery({
    queryKey: ["order", scope, "proof-permission", order.paymentOrderId],
    queryFn: ({ signal }) => readProofPermission(api, order, signal),
    enabled: canUpload,
  });
  const info = (
    <InfoList
      items={[
        { label: "付款单", value: order.orderNo },
        { label: "主体", value: order.entity.name },
        { label: "应付金额", value: moneyText(order.amountFen) },
        { label: "收款户名", value: order.bankAccount?.accountName ?? "未提供" },
        { label: "收款银行", value: order.bankAccount?.bankName ?? "未提供" },
        { label: "收款账号（脱敏）", value: order.bankAccount?.accountNoMask ?? "未提供" },
      ]}
    />
  );
  if (!canUpload)
    return (
      <Modal
        open
        title="线下付款单"
        footer={<Button onClick={onClose}>关闭</Button>}
        onCancel={onClose}
      >
        {info}
        <Alert type="info" title="付款单已建立。当前员工无代传凭证权限，尚未收款或履约。" />
      </Modal>
    );
  return (
    <BillingDialog
      title="代传银行转账凭证"
      intent={intent}
      onClose={onClose}
      submitText="提交收款审核"
      disabled={!permission.data || !fileId}
      submit={async () => {
        if (!permission.data) throw new Error("当前不允许提交凭证");
        const body = proofBody(fileId, note),
          result = await intent.submit(body, (key, signal) =>
            api.proof(order.paymentOrderId, body, key, signal),
          );
        if (result !== undefined) {
          onSaved();
          onClose();
        }
      }}
    >
      {info}
      <Alert
        type="info"
        title="本步只提交转账凭证，收款确认与财务复核另由有权限员工处理，不会直接付款成功。"
      />
      {permission.isPending ? (
        <Skeleton active />
      ) : permission.isError ? (
        <ErrorState onRetry={() => void permission.refetch()} />
      ) : !permission.data ? (
        <Alert
          role="alert"
          type="warning"
          title="服务端没有返回本单可代传动作。请关闭后刷新付款单，不会推断允许上传。"
        />
      ) : (
        <>
          <StoredReceipt
            key={order.paymentOrderId}
            services={services}
            entityId={order.entity.entityId}
            storeId={order.store?.storeId}
            disabled={intent.pending}
            onChange={(id) => {
              setFileId(id);
              intent.change();
            }}
          />
          <Input.TextArea
            aria-label="凭证说明"
            placeholder="凭证说明（选填）"
            maxLength={200}
            showCount
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              intent.change();
            }}
          />
        </>
      )}
    </BillingDialog>
  );
}
