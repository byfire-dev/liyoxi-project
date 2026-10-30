import { useEffect, useRef } from "react";
import { ConfirmAction, type ConfirmSpec } from "../../../components/ConfirmAction";
import { MerchantFailure } from "../detail/api";
import { formError } from "../detail/model";
import type { AssetDeleteReads } from "./delete-reads";
import type { AssetPrepared } from "./write-model";
import type { AssetWriteApi } from "./write-api";

export function AssetConfirm({
  prepared,
  spec,
  api,
  refresh,
  deleteReads,
  close,
  notice,
}: {
  prepared: AssetPrepared;
  spec: ConfirmSpec;
  api: AssetWriteApi;
  refresh(): Promise<unknown>;
  deleteReads?: AssetDeleteReads;
  close(): void;
  notice(message: string): void;
}) {
  const active = useRef(false),
    pending = useRef(false),
    completed = useRef(false),
    controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    active.current = true;
    controller.current = new AbortController();
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);
  return (
    <ConfirmAction
      open
      action="merchant-asset-write"
      spec={spec}
      onCancel={() => {
        if (deleteReads?.paused()) {
          void (completed.current ? deleteReads.committed() : deleteReads.dismiss());
        }
        close();
      }}
      onConfirm={async ({ idempotencyKey }) => {
        if (!active.current) return { outcome: "failed", message: "当前操作已失效，请重新打开" };
        if (pending.current) return { outcome: "failed", message: "正在提交，请稍候" };
        pending.current = true;
        try {
          if (!completed.current) {
            await deleteReads?.before();
            if (!active.current)
              return { outcome: "failed", message: "当前操作已失效，请重新打开" };
            await prepared.send(api, idempotencyKey, controller.current?.signal);
            completed.current = true;
          }
          // 已确认的删除即使遇到导航，也要清掉原门店的详情缓存。
          if (deleteReads) await deleteReads.committed();
          else if (active.current) await refresh();
          return { outcome: "done" };
        } catch (error) {
          if (
            active.current &&
            !completed.current &&
            error instanceof MerchantFailure &&
            error.status >= 400 &&
            error.status < 500 &&
            error.code !== "IDEMPOTENCY_IN_PROGRESS"
          ) {
            deleteReads?.restore();
          }
          if (
            active.current &&
            error instanceof MerchantFailure &&
            error.status === 409 &&
            error.code !== "IDEMPOTENCY_IN_PROGRESS"
          ) {
            await refresh().catch(() => undefined);
            if (active.current) {
              close();
              notice(`当前事实已变化（${error.code}），请重新读取并填写`);
            }
          }
          return { outcome: "failed", message: formError(error) };
        } finally {
          pending.current = false;
        }
      }}
      onDone={() => {
        if (active.current) {
          close();
          notice("操作已完成，已重新读取服务端事实");
        }
      }}
    />
  );
}
