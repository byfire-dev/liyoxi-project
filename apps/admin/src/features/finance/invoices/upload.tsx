import { extensionOf, maxUploadBytes } from "@liyoxi/shared/uploads";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { AppServices } from "../../../app/services";
import { UploadField } from "../../../components/UploadField";
import type { UploadFn } from "../../../lib/upload";
import {
  createAdminMultipartUploadPorts,
  createMultipartUploadAdapter,
} from "../../../lib/upload-multipart";

export function InvoiceUpload({
  services,
  entityId,
  red,
  disabled,
  onChange,
}: {
  services: AppServices;
  entityId: string;
  red: boolean;
  disabled: boolean;
  onChange(id: string | null): void;
}) {
  const adapter = useRef<ReturnType<typeof createMultipartUploadAdapter> | undefined>(undefined);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      adapter.current?.close();
      adapter.current = undefined;
    };
  }, [services, entityId, red]);
  const upload = useCallback<UploadFn>(
    (file, hooks) => {
      const ext = extensionOf(file.name);
      if (
        !ext ||
        !(red ? ["pdf", "ofd", "xml"] : ["pdf", "ofd"]).includes(ext) ||
        file.size > Number(maxUploadBytes("invoice", ext, "admin"))
      )
        return Promise.reject(
          new Error("发票文件类型或大小不合规（PDF最多10MB，OFD/XML最多20MB）"),
        );
      adapter.current ??= createMultipartUploadAdapter({
        ports: createAdminMultipartUploadPorts(services.api.client, {
          category: "invoice",
          entityId,
        }),
      });
      return adapter.current.upload(file, hooks);
    },
    [services, entityId, red],
  );
  const rule = useMemo(
    () => ({ accept: red ? [".pdf", ".ofd", ".xml"] : [".pdf", ".ofd"], maxSizeMb: 20 }),
    [red],
  );
  return (
    <>
      <p>PDF最多10MB；OFD{red ? "/XML" : ""}最多20MB。文件须由当前处理人上传到本主体。</p>
      <UploadField
        rule={rule}
        upload={upload}
        disabled={disabled}
        onChange={(id) => {
          if (active.current) onChange(id);
        }}
        text={red ? "上传红字发票文件" : "上传电子发票文件"}
      />
    </>
  );
}
