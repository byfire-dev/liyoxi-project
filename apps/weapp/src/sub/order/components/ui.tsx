import { View } from "@tarojs/components";
import { Card } from "@/components/Card";
import { LoadError } from "@/components/LoadError";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag, merchantStatusByEnum } from "@/components/StatusTag";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { deliveryScopeKey } from "@/stores/delivery";
import "./delivery.scss";
export function useDeliveryIdentity() {
  useContextStore((s) => s.contextRev);
  useContextStore((s) => s.currentStoreId);
  useSessionStore((s) => s.accessToken);
  useSessionStore((s) => s.me);
  return deliveryScopeKey();
}
export function DeliveryState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: string | null;
  retry: () => void;
}) {
  return (
    <>
      {error ? (
        <LoadError message={error} onRetry={retry} />
      ) : loading ? (
        <Skeleton cards={3} />
      ) : null}
    </>
  );
}
export function DeliveryStatus({ column, value }: { column: string; value: string }) {
  const status = merchantStatusByEnum(column, value);
  const labels: Record<string, string> = {
    drafting: "方案制作中",
    pushed: "待确认",
    confirmed: "已确认",
    change_requested: "修改中",
    superseded: "历史版本",
    void: "已作废",
  };
  return status ? (
    <StatusTag tone={status.tone}>{status.label}</StatusTag>
  ) : (
    <View>{labels[value] ?? "处理中"}</View>
  );
}
export function DeliveryEmpty({ text }: { text: string }) {
  return <Card>{text}</Card>;
}
