import { useEffect, useRef } from "react";
import { ConfirmAction, type ConfirmSpec } from "../../../components/ConfirmAction";
import { MerchantFailure } from "../detail/api";
import { formError } from "../detail/model";
import type { AssetPrepared } from "./write-model";
import type { AssetWriteApi } from "./write-api";

export function AssetConfirm({
  prepared,
  spec,
  api,
  refresh,
  close,
  notice,
}: {
  prepared: AssetPrepared;
  spec: ConfirmSpec;
  api: AssetWriteApi;
  refresh(): Promise<unknown>;
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
      onCancel={close}
      onConfirm={async ({ idempotencyKey }) => {
        if (!active.current) return { outcome: "failed", message: "当前操作已失效，请重新打开" };
        if (completed.current) return { outcome: "done" };
        if (pending.current) return { outcome: "failed", message: "正在提交，请稍候" };
        pending.current = true;
        try {
          await prepared.send(api, idempotencyKey, controller.current?.signal);
          completed.current = true;
          if (active.current) await refresh();
          return { outcome: "done" };
        } catch (error) {
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
