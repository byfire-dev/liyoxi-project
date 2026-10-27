import { extensionOf, maxUploadBytes } from "@liyoxi/shared/uploads";
import { SignedUrlSchema } from "@liyoxi/contract";
import { Alert, Button } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppServices } from "../../../app/services";
import { UploadField } from "../../../components/UploadField";
import type { UploadFn } from "../../../lib/upload";
import {
  createAdminMultipartUploadPorts,
  createMultipartUploadAdapter,
} from "../../../lib/upload-multipart";

export function OfflineRefundUpload({
  services,
  entityId,
  disabled,
  onChange,
}: {
  services: AppServices;
  entityId: string | null;
  disabled: boolean;
  onChange(id: string | null): void;
}) {
  const adapter = useRef<ReturnType<typeof createMultipartUploadAdapter> | undefined>(undefined),
    active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      adapter.current?.close();
      adapter.current = undefined;
    };
  }, [services, entityId]);
  const upload = useCallback<UploadFn>(
    (file, hooks) => {
      const ext = extensionOf(file.name);
      if (
        !ext ||
        !["jpg", "jpeg", "png", "pdf"].includes(ext) ||
        file.size > Number(maxUploadBytes("pay_receipt", ext, "admin"))
      )
        return Promise.reject(new Error("回单须为图片（最多5MB）或PDF（最多10MB）"));
      adapter.current ??= createMultipartUploadAdapter({
        ports: createAdminMultipartUploadPorts(services.api.client, {
          category: "pay_receipt",
          ...(entityId ? { entityId } : {}),
        }),
      });
      return adapter.current.upload(file, hooks);
    },
    [services, entityId],
  );
  const rule = useMemo(() => ({ accept: [".jpg", ".jpeg", ".png", ".pdf"], maxSizeMb: 10 }), []);
  return (
    <UploadField
      rule={rule}
      upload={upload}
      disabled={disabled}
      onChange={(id) => {
        if (active.current) onChange(id);
      }}
      text="上传本次线下退款回单"
    />
  );
}

export function OfflineRefundReceipt({
  services,
  fileId,
}: {
  services: AppServices;
  fileId: string;
}) {
  const controller = useRef<AbortController | undefined>(undefined),
    [notice, setNotice] = useState(false);
  useEffect(() => {
    const own = new AbortController();
    controller.current = own;
    return () => {
      own.abort();
    };
  }, [services, fileId]);
  const open = async () => {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const response = await services.api.client.POST(
        "/api/v1/admin/files/{fileId}/download-urls",
        {
          params: { path: { fileId } },
          body: { disposition: "attachment", purpose: "核对线下退款回单" },
          signal,
        },
      );
      if (!response.data) throw new Error("回单读取失败");
      const signed = SignedUrlSchema.parse(response.data.data);
      if (!signal.aborted && tab) tab.location.href = signed.url;
      else tab?.close();
    } catch {
      tab?.close();
      if (!signal.aborted) setNotice(true);
    }
  };
  return (
    <>
      <Button type="link" onClick={() => void open()}>
        查看退款回单
      </Button>
      {notice ? <Alert type="warning" title="回单暂未能读取，请重试" /> : null}
    </>
  );
}
