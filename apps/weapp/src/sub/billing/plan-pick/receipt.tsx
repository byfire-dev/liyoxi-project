import { useEffect, useRef, useState } from "react";
import { View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { Button } from "@/components/Button";
import { Note } from "@/components/Note";
import { UploadGrid } from "@/components/UploadGrid";
import { newIdempotencyKey, withPrivacy, withSubscribe } from "@/lib/runtime";
import {
  createReceiptUpload,
  type ReceiptFile,
  type ReceiptUpload,
} from "@/lib/upload/billing-receipt";
import { createTaroUpload, prepareTaroFile } from "@/lib/upload/taro";
import { createUpload } from "@/lib/upload/queue";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { billingRequest } from "../wallet/runtime";
import type { PurchaseApi } from "./api";
import type { Payment } from "./model";

export function ReceiptPicker({
  payment,
  api,
  onSubmitted,
}: {
  payment: Payment;
  api: PurchaseApi;
  onSubmitted: (value: Payment) => void;
}) {
  const [file, setFile] = useState<ReceiptFile | null>(null),
    [state, setState] = useState<ReturnType<ReceiptUpload["snapshot"]> | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const job = useRef<ReceiptUpload | null>(null),
    generation = useRef(0),
    running = useRef(false),
    selecting = useRef(false),
    proofKey = useRef<string | null>(null);
  const stateFile = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    const marker = generation;
    mounted.current = true;
    return () => {
      mounted.current = false;
      marker.current++;
      job.current?.dispose();
    };
  }, []);
  async function choose() {
    if (running.current || selecting.current) return;
    selecting.current = true;
    const own = ++generation.current,
      rev = useContextStore.getState().contextRev,
      token = useSessionStore.getState().accessToken;
    const current = () =>
      mounted.current &&
      own === generation.current &&
      rev === useContextStore.getState().contextRev &&
      token === useSessionStore.getState().accessToken;
    try {
      const result = await withPrivacy(async (): Promise<ReceiptFile> => {
        if (
          process.env.TARO_ENV === "h5" &&
          (globalThis as { __LYX_BILLING_SHOT__?: string }).__LYX_BILLING_SHOT__
        )
          return (await import("../../../../shots/billing-fixtures")).billingReceipt;
        const kind = await Taro.showActionSheet({ itemList: ["选择图片", "选择 PDF 回单"] });
        if (kind.tapIndex === 1) {
          const choice = await Taro.chooseMessageFile({
            count: 1,
            type: "file",
            extension: ["pdf"],
          });
          const selected = choice.tempFiles[0];
          if (!selected) throw new Error("请先选择 PDF 回单");
          return { path: selected.path, name: selected.name, size: selected.size };
        }
        const choice = await Taro.chooseMedia({
          count: 1,
          mediaType: ["image"],
          sourceType: ["album", "camera"],
        });
        const selected = choice.tempFiles[0];
        if (!selected) throw new Error("请先选择凭证图片");
        const info = await Taro.getImageInfo({ src: selected.tempFilePath });
        const ext = ({ jpeg: "jpg", jpg: "jpg", png: "png" } as Record<string, string>)[info.type];
        if (!ext) throw new Error("请选择 JPG 或 PNG 图片");
        return { path: selected.tempFilePath, name: `receipt.${ext}`, size: selected.size };
      });
      if (!current()) return;
      if (!result.ok) {
        setError("未同意隐私指引，暂未选择图片");
        return;
      }
      let prepared: ReceiptFile | null = result.value;
      let next: ReceiptUpload;
      if (
        process.env.TARO_ENV === "h5" &&
        (globalThis as { __LYX_BILLING_SHOT__?: string }).__LYX_BILLING_SHOT__
      ) {
        const fixture = await import("../../../../shots/billing-fixtures");
        if (!current()) return;
        next = createReceiptUpload(
          createUpload(
            fixture.billingReceiptDeps(billingRequest, newIdempotencyKey, () => ({
              token: useSessionStore.getState().accessToken,
              storeId: useContextStore.getState().currentStoreId,
              revision: useContextStore.getState().contextRev,
            })),
            prepared,
            "pay_receipt",
          ),
        );
      } else {
        prepared = await prepareTaroFile(prepared, "pay_receipt");
        if (!current() || !prepared) return;
        next = createReceiptUpload(createTaroUpload(prepared, "pay_receipt"));
      }
      job.current?.dispose();
      setFile(prepared);
      setError(null);
      proofKey.current = null;
      stateFile.current = null;
      job.current = next;
      next.subscribe(() => {
        if (current()) setState(next.snapshot());
      });
      setState(next.snapshot());
      await next.start();
    } catch (failure) {
      if (current()) setError(failure instanceof Error ? failure.message : "暂未选择图片，请重试");
    } finally {
      selecting.current = false;
    }
  }
  function submit() {
    const fileId = job.current?.snapshot().fileId;
    if (running.current || job.current?.snapshot().status !== "done" || !fileId) return;
    if (stateFile.current !== fileId) {
      proofKey.current = newIdempotencyKey("transfer-proof");
      stateFile.current = fileId;
    }
    const own = generation.current,
      rev = useContextStore.getState().contextRev,
      token = useSessionStore.getState().accessToken;
    const current = () =>
      mounted.current &&
      own === generation.current &&
      rev === useContextStore.getState().contextRev &&
      token === useSessionStore.getState().accessToken;
    if (!current()) return;
    const key = proofKey.current!;
    running.current = true;
    setBusy(true);
    setError(null);
    // 点击时固定意图；授权可能迟到，回调开始前和请求返回后都验同一上下文。
    withSubscribe("transfer_submit", async () => {
      try {
        if (!current()) return;
        const value = await api.proof(payment.paymentOrderId, fileId, key);
        if (current()) onSubmitted(value);
      } catch (failure) {
        if (current()) setError(failure instanceof Error ? failure.message : "提交失败，请重试");
      } finally {
        running.current = false;
        if (current()) setBusy(false);
      }
    })();
  }
  return (
    <View className="billing-receipt">
      <UploadGrid
        max={1}
        addText="选择转账凭证"
        disabled={busy}
        items={
          file
            ? [
                {
                  key: "receipt",
                  src: file.name.toLowerCase().endsWith(".pdf") ? undefined : file.path,
                  status:
                    state?.status === "failed"
                      ? "failed"
                      : state?.status === "done"
                        ? "done"
                        : "uploading",
                  progress: state?.progress ?? 0,
                },
              ]
            : []
        }
        onAdd={() => void choose()}
        onPreview={() => {
          if (!file) return;
          if (file.name.toLowerCase().endsWith(".pdf"))
            void Taro.openDocument({ filePath: file.path, fileType: "pdf" });
          else void Taro.previewImage({ urls: [file.path], current: file.path });
        }}
        onRetry={() => void job.current?.retry()}
        onRemove={() => {
          generation.current++;
          void job.current?.cancel().catch(() => undefined);
          job.current?.dispose();
          job.current = null;
          setFile(null);
          setState(null);
          proofKey.current = null;
        }}
      />
      {state?.error || error ? <Note>{state?.error ?? error}</Note> : null}
      <Button block disabled={state?.status !== "done"} loading={busy} onClick={submit}>
        提交转账凭证
      </Button>
    </View>
  );
}
