import { maxUploadBytes } from "@liyoxi/shared/uploads";
import { Alert, Button, Modal, Space } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppServices } from "../../../app/services";
import { ConfirmPanel, type ConfirmEchoItem } from "../../../components/ConfirmAction";
import { UploadField } from "../../../components/UploadField";
import { newIdempotencyKey } from "../../../lib/idempotency";
import type { UploadFn, UploadTaskState } from "../../../lib/upload";
import {
  createAdminMultipartUploadPorts,
  createMultipartUploadAdapter,
} from "../../../lib/upload-multipart";
import { PublishFailure, type PatrolApi } from "./api";
import { factChanged } from "./model";

function EvidenceSlot({
  services,
  storeId,
  disabled,
  onChange,
  onBlocked,
}: {
  services: AppServices;
  storeId: string;
  disabled: boolean;
  onChange(id: string | null): void;
  onBlocked(blocked: boolean): void;
}) {
  const adapter = useRef<ReturnType<typeof createMultipartUploadAdapter> | undefined>(undefined),
    file = useRef<File | undefined>(undefined),
    active = useRef(false);
  const blockedCallback = useRef(onBlocked);
  useEffect(() => {
    blockedCallback.current = onBlocked;
  }, [onBlocked]);
  const stateChange = useCallback((state: UploadTaskState) => {
    if (active.current)
      blockedCallback.current(
        state.status === "uploading" || state.status === "failed" || state.status === "rejected",
      );
  }, []);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      adapter.current?.close();
      adapter.current = undefined;
    };
  }, []);
  const upload = useCallback<UploadFn>(
    async (input, hooks) => {
      if (!active.current) throw new Error("当前上传已关闭");
      if (file.current && file.current !== input) await adapter.current?.cancel(file.current);
      file.current = input;
      adapter.current ??= createMultipartUploadAdapter({
        ports: createAdminMultipartUploadPorts(services.api.client, {
          category: "evidence",
          storeId,
        }),
      });
      const result = await adapter.current.upload(input, hooks);
      if (!active.current || file.current !== input) throw new Error("当前证据已切换");
      return result;
    },
    [services, storeId],
  );
  const rule = useMemo(
    () => ({
      accept: [".jpg", ".jpeg", ".png"],
      maxSizeMb: Number(maxUploadBytes("evidence", "jpg", "admin")) / 1024 / 1024,
    }),
    [],
  );
  return (
    <UploadField
      rule={rule}
      upload={upload}
      disabled={disabled}
      text="上传现场核查截图"
      onStateChange={stateChange}
      onChange={(id) => {
        if (active.current) onChange(id);
      }}
    />
  );
}
export function EvidenceEditor({
  services,
  storeId,
  disabled,
  minimum,
  onChange,
}: {
  services: AppServices;
  storeId: string;
  disabled: boolean;
  minimum: number;
  onChange(ids: string[]): void;
}) {
  const [slots, setSlots] = useState<(string | null)[]>(
    Array.from({ length: minimum }, () => null),
  );
  const values = useRef(slots),
    blocked = useRef(new Set<number>());
  const report = () =>
    onChange(
      blocked.current.size ? [] : values.current.filter((value): value is string => !!value),
    );
  return (
    <section>
      <h3 className="lyx-section-title">本次证据（{minimum}–9 张）</h3>
      <p>请上传本次实际核查截图。恢复时须上传新的证据。</p>
      {slots.map((_id, index) => (
        <EvidenceSlot
          key={index}
          services={services}
          storeId={storeId}
          disabled={disabled}
          onBlocked={(busy) => {
            if (busy) blocked.current.add(index);
            else blocked.current.delete(index);
            report();
          }}
          onChange={(id) => {
            values.current = values.current.map((value, i) => (i === index ? id : value));
            setSlots(values.current);
            report();
          }}
        />
      ))}
      <Button
        disabled={disabled || slots.length >= 9}
        onClick={() => {
          values.current = [...values.current, null];
          setSlots(values.current);
        }}
      >
        添加证据截图
      </Button>
    </section>
  );
}
export function EvidenceHistory({
  ids,
  api,
}: {
  ids: readonly string[];
  api: Pick<PatrolApi, "evidence">;
}) {
  const [images, setImages] = useState<Record<string, string>>({}),
    [error, setError] = useState<string>();
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return ids.length ? (
    <section>
      <h3 className="lyx-section-title">历史证据（{ids.length} 张）</h3>
      <Space wrap>
        {ids.map((id, index) =>
          images[id] ? (
            <a key={id} href={images[id]} target="_blank" rel="noopener noreferrer">
              <img
                className="lyx-lifecycle-evidence"
                src={images[id]}
                alt={`历史证据 ${index + 1}`}
              />
            </a>
          ) : (
            <Button
              key={id}
              onClick={() => {
                setError(undefined);
                void api
                  .evidence(id)
                  .then((value) => {
                    if (active.current) setImages((old) => ({ ...old, [id]: value.url }));
                  })
                  .catch((cause: unknown) => {
                    if (active.current)
                      setError(cause instanceof Error ? cause.message : "证据读取失败");
                  });
              }}
            >
              查看证据 {index + 1}
            </Button>
          ),
        )}
      </Space>
      <Button
        type="link"
        onClick={() => {
          setImages({});
          setError(undefined);
        }}
      >
        刷新证据地址
      </Button>
      {error ? <Alert type="error" title={error} /> : null}
    </section>
  ) : null;
}

/** 私有确认边界：输入变化撤销勾选；同步闸阻止连点；同意图重试沿用键。 */
export function MutationConfirm({
  title,
  echo,
  payload,
  valid,
  children,
  send,
  reconcile,
  refresh,
  onClose,
  onDone,
  danger = false,
}: {
  title: string;
  echo: readonly ConfirmEchoItem[];
  payload: unknown;
  valid: boolean;
  children?: ReactNode;
  send(key: string, signal: AbortSignal): Promise<unknown>;
  reconcile(): Promise<unknown>;
  refresh(): void;
  onClose(): void;
  onDone?(): void;
  danger?: boolean;
}) {
  const signature = JSON.stringify(payload);
  const [confirmation, setConfirmation] = useState<{ signature: string; key: string }>();
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string>(),
    [accepted, setAccepted] = useState<string>();
  const [inputSignature, setInputSignature] = useState(signature);
  if (inputSignature !== signature) {
    setInputSignature(signature);
    setConfirmation(undefined);
    setAccepted(undefined);
  }
  const busy = useRef(false),
    active = useRef(false),
    controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);
  const submit = async () => {
    if (busy.current || !valid || confirmation?.signature !== signature) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    controller.current = new AbortController();
    try {
      if (accepted !== signature) {
        await send(confirmation.key, controller.current.signal);
        if (!active.current) return;
        setAccepted(signature);
      }
      await reconcile();
      if (active.current) {
        refresh();
        onDone?.();
        onClose();
      }
    } catch (cause) {
      if (!active.current) return;
      // 未知结果先读取事实；不以丢失响应推定失败或自动另发一笔写入。
      await reconcile()
        .then(() => {
          if (active.current) refresh();
        })
        .catch(() => undefined);
      if (!active.current) return;
      if (cause instanceof PublishFailure && factChanged(cause.code)) {
        setConfirmation(undefined);
        refresh();
      }
      const details = cause instanceof PublishFailure ? cause.details : undefined;
      const nextDate =
        details && typeof details === "object" && "nextAvailableDate" in details
          ? `（下次可操作：${String(details.nextAvailableDate)}）`
          : "";
      setError(
        `${cause instanceof Error ? cause.message : "操作结果未确认，请核对后重试"}${nextDate}`,
      );
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
  };
  return (
    <Modal
      open
      title={title}
      footer={null}
      closable={!pending}
      keyboard={!pending}
      mask={{ closable: !pending }}
      onCancel={() => {
        if (!busy.current) onClose();
      }}
    >
      <fieldset
        inert={pending || accepted === signature}
        disabled={pending || accepted === signature}
        className="lyx-lifecycle-fields"
      >
        {children}
      </fieldset>
      {accepted === signature ? <Alert type="info" title="操作已受理，结果以最新记录为准" /> : null}
      {!valid ? <Alert type="info" title="当前操作尚未满足提交条件，请核对资料与最新状态" /> : null}
      <ConfirmPanel
        spec={{
          title,
          echo,
          danger,
          checkLabel: "我已核对当前对象与本次操作",
          confirmText: accepted === signature ? "重读处理结果" : "确认",
        }}
        input={{ checked: valid && confirmation?.signature === signature, typed: "" }}
        onInputChange={(input) =>
          setConfirmation(
            input.checked && valid
              ? {
                  signature,
                  key:
                    confirmation?.signature === signature
                      ? confirmation.key
                      : newIdempotencyKey("publish-lifecycle"),
                }
              : undefined,
          )
        }
        submitting={pending}
        notice={error ? { tone: "error", message: error } : undefined}
        onCancel={() => {
          if (!busy.current) onClose();
        }}
        onConfirm={() => void submit()}
      />
    </Modal>
  );
}
