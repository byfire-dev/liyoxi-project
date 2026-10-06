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
import { useBootstrapStore } from "@/stores/bootstrap";
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
  useEffect(
    () => () => {
      generation.current++;
      job.current?.dispose();
    },
    [],
  );
  async function choose() {
    if (running.current || selecting.current) return;
    selecting.current = true;
    const own = ++generation.current,
      rev = useContextStore.getState().contextRev,
      token = useSessionStore.getState().accessToken;
    const current = () =>
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
        const choice = await Taro.chooseMedia({
          count: 1,
          mediaType: ["image"],
          sourceType: ["album", "camera"],
        });
        const selected = choice.tempFiles[0];
        if (!selected) throw new Error("请先选择凭证图片");
        const info = await Taro.getImageInfo({ src: selected.tempFilePath });
        const ext = (
          { jpeg: "jpg", jpg: "jpg", png: "png", webp: "webp" } as Record<string, string>
        )[info.type];
        if (!ext) throw new Error("请选择 JPG、PNG 或 WebP 图片");
        if (selected.size > useBootstrapStore.getState().data.uploadLimits.imageMaxMb * 1024 * 1024)
          throw new Error("图片超过当前上传限制，请选择更小的图片");
        return { path: selected.tempFilePath, name: `receipt.${ext}`, size: selected.size };
      });
      if (!current()) return;
      if (!result.ok) {
        setError("未同意隐私指引，暂未选择图片");
        return;
      }
      job.current?.dispose();
      setFile(result.value);
      setError(null);
      proofKey.current = null;
      stateFile.current = null;
      const next = createReceiptUpload(result.value, {
        call: billingRequest,
        key: newIdempotencyKey,
        upload(post, picked, progress) {
          const task = Taro.uploadFile({
            url: post.url,
            filePath: picked.path,
            name: "file",
            formData: post.fields,
          });
          task.onProgressUpdate((v) => progress(v.progress));
          return {
            promise: task.then((v) => {
              if (v.statusCode < 200 || v.statusCode >= 300)
                throw new Error("图片未传成功，请重试");
            }),
            abort: () => task.abort(),
          };
        },
      });
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
  async function submit() {
    const fileId = job.current?.snapshot().fileId;
    if (running.current || job.current?.snapshot().status !== "done" || !fileId) return;
    if (stateFile.current !== fileId) {
      proofKey.current = newIdempotencyKey("transfer-proof");
      stateFile.current = fileId;
    }
    const own = generation.current,
      rev = useContextStore.getState().contextRev,
      token = useSessionStore.getState().accessToken;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const value = await api.proof(payment.paymentOrderId, fileId, proofKey.current!);
      if (
        own === generation.current &&
        rev === useContextStore.getState().contextRev &&
        token === useSessionStore.getState().accessToken
      )
        onSubmitted(value);
    } catch (failure) {
      if (
        own === generation.current &&
        rev === useContextStore.getState().contextRev &&
        token === useSessionStore.getState().accessToken
      )
        setError(failure instanceof Error ? failure.message : "提交失败，请重试");
    } finally {
      running.current = false;
      if (own === generation.current) setBusy(false);
    }
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
                  src: file.path,
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
          if (file) void Taro.previewImage({ urls: [file.path], current: file.path });
        }}
        onRetry={() => void job.current?.retry()}
        onRemove={() => {
          generation.current++;
          job.current?.dispose();
          job.current = null;
          setFile(null);
          setState(null);
          proofKey.current = null;
        }}
      />
      {state?.error || error ? <Note>{state?.error ?? error}</Note> : null}
      <Button
        block
        disabled={state?.status !== "done"}
        loading={busy}
        onClick={() => void withSubscribe("transfer_submit", submit)()}
      >
        提交转账凭证
      </Button>
    </View>
  );
}
