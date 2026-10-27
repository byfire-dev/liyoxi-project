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
export function receiptFileAllowed(file: Pick<File, "name" | "size">) {
  const ext = extensionOf(file.name);
  return (
    !!ext &&
    extensions.some((v) => v === ext) &&
    file.size > 0 &&
    BigInt(file.size) <= maxUploadBytes("pay_receipt", ext, "admin")
  );
}
export function StoredReceipt({
  services,
  entityId,
  storeId,
  disabled,
  onChange,
}: {
  services: AppServices;
  entityId: string;
  storeId?: string;
  disabled: boolean;
  onChange(id: string | null): void;
}) {
  const adapter = useRef<ReturnType<typeof createMultipartUploadAdapter> | undefined>(undefined),
    file = useRef<File | undefined>(undefined),
    alive = useRef(false),
    generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current += 1;
      const owned = adapter.current;
      if (file.current) void owned?.cancel(file.current).catch(() => undefined);
      owned?.close();
      adapter.current = undefined;
      file.current = undefined;
    };
  }, [services, entityId, storeId]);
  const upload = useCallback<UploadFn>(
    async (current, hooks) => {
      if (!alive.current || !receiptFileAllowed(current))
        throw new Error("凭证仅支持JPG/PNG（5MB内）或PDF（10MB内）");
      const mine = ++generation.current;
      adapter.current ??= createMultipartUploadAdapter({
        ports: createAdminMultipartUploadPorts(services.api.client, {
          category: "pay_receipt",
          entityId,
          ...(storeId ? { storeId } : {}),
        }),
      });
      const owned = adapter.current;
      if (file.current && file.current !== current) await owned.cancel(file.current);
      file.current = current;
      const result = await owned.upload(current, hooks);
      if (!alive.current || mine !== generation.current) throw new Error("此凭证上传已失效");
      return result;
    },
    [services, entityId, storeId],
  );
  const rule = useMemo(() => ({ accept: extensions.map((v) => `.${v}`), maxSizeMb: 10 }), []);
  return (
    <UploadField
      rule={rule}
      upload={upload}
      disabled={disabled}
      onChange={(id) => {
        if (alive.current) onChange(id);
      }}
      text="上传转账凭证（图片≤5MB，PDF≤10MB）"
    />
  );
}
