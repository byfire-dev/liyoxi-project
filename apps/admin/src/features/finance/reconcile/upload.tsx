import { extensionOf, maxUploadBytes } from "@liyoxi/shared/uploads";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { AppServices } from "../../../app/services";
import { UploadField } from "../../../components/UploadField";
import {
  createAdminMultipartUploadPorts,
  createMultipartUploadAdapter,
} from "../../../lib/upload-multipart";
import type { UploadFn } from "../../../lib/upload";
const extensions = ["jpg", "jpeg", "png", "pdf"] as const;
export function OrphanReturnReceipt({
  services,
  disabled,
  onChange,
}: {
  services: AppServices;
  disabled: boolean;
  onChange: (id: string | null) => void;
}) {
  const adapter = useRef<ReturnType<typeof createMultipartUploadAdapter> | undefined>(undefined),
    file = useRef<File | undefined>(undefined),
    alive = useRef(false),
    generation = useRef(0);
  useEffect(() => {
    const lifecycle = generation;
    alive.current = true;
    return () => {
      alive.current = false;
      lifecycle.current++;
      if (file.current) void adapter.current?.cancel(file.current).catch(() => undefined);
      adapter.current?.close();
      adapter.current = undefined;
      file.current = undefined;
    };
  }, [services]);
  const upload = useCallback<UploadFn>(
    async (current, hooks) => {
      const ext = extensionOf(current.name);
      if (
        !alive.current ||
        !ext ||
        !extensions.some((value) => value === ext) ||
        current.size <= 0 ||
        BigInt(current.size) > maxUploadBytes("pay_receipt", ext, "admin")
      )
        throw new Error("凭证仅支持JPG/PNG（5MB内）或PDF（10MB内）");
      const own = ++generation.current;
      // 无主体孤儿收款的凭证走正式平台归属守卫；不借其它主体或伪造stored事实。
      adapter.current ??= createMultipartUploadAdapter({
        ports: createAdminMultipartUploadPorts(services.api.client, { category: "pay_receipt" }),
      });
      if (file.current && file.current !== current) await adapter.current.cancel(file.current);
      file.current = current;
      const result = await adapter.current.upload(current, hooks);
      if (!alive.current || generation.current !== own) throw new Error("本次凭证上传已失效");
      return result;
    },
    [services],
  );
  const rule = useMemo(
    () => ({ accept: extensions.map((value) => `.${value}`), maxSizeMb: 10 }),
    [],
  );
  return (
    <UploadField
      rule={rule}
      upload={upload}
      disabled={disabled}
      onChange={(id) => {
        if (alive.current) onChange(id);
      }}
      text="上传本次线下退回凭证（图片≤5MB，PDF≤10MB）"
    />
  );
}
