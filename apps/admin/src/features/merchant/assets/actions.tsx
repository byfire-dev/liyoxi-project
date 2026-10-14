import { Alert, Button, Space } from "antd";
import { useEffect, useRef, useState } from "react";
import type { AccessSnapshot } from "../../../lib/permissions";
import type { AssetDetail } from "./api";
import { signedAssetUrl } from "./model";
import type { AssetWriteApi } from "./write-api";
import {
  assetActionLabels,
  assetPermission,
  canAssetAction,
  type AssetAction,
  type AssetIntent,
} from "./write-model";

const actions: AssetAction[] = [
  "review",
  "reprocess",
  "portrait-auth",
  "confirm-portrait-auth",
  "delete",
];
export function AssetActions({
  row,
  access,
  api,
  open,
}: {
  row: AssetDetail;
  access: AccessSnapshot | null;
  api: AssetWriteApi;
  open(intent: AssetIntent): void;
}) {
  const [error, setError] = useState<string>(),
    [busy, setBusy] = useState<string>();
  const active = useRef(false),
    generation = useRef(0),
    controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);
  return (
    <div aria-label="素材操作">
      <Space wrap>
        {actions
          .filter((action) => canAssetAction(access, row, action))
          .map((action) => (
            <Button
              key={action}
              danger={action === "delete"}
              disabled={
                (action === "review" && row.processingState !== "processed") ||
                (action === "confirm-portrait-auth" && row.portraitAuth.fileCount < 1)
              }
              onClick={() => open({ kind: action, row })}
            >
              {assetActionLabels[action]}
            </Button>
          ))}
      </Space>
      {row.portraitAuthFileIds.length &&
      (assetPermission(access, "merchant.asset.review") ||
        assetPermission(access, "merchant.asset.upload_on_behalf")) ? (
        <div>
          <p>肖像授权材料须逐次现签核验，补交本身不表示授权已确认。</p>
          {row.portraitAuthFileIds.map((fileId, index) => (
            <Button
              key={fileId}
              loading={busy === fileId}
              disabled={!!busy}
              onClick={async () => {
                if (busy) return;
                const mine = ++generation.current;
                controller.current?.abort();
                controller.current = new AbortController();
                setBusy(fileId);
                setError(undefined);
                try {
                  const signed = await api.portraitUrl(fileId, controller.current.signal);
                  if (
                    !active.current ||
                    mine !== generation.current ||
                    !row.portraitAuthFileIds.includes(fileId)
                  )
                    return;
                  const url = signedAssetUrl(signed.url, signed.expiresAt);
                  if (!url) throw new Error("材料地址已失效，请重新核验");
                  window.open(url, "_blank", "noopener,noreferrer");
                } catch (failure) {
                  if (active.current && mine === generation.current)
                    setError(failure instanceof Error ? failure.message : "材料读取失败");
                } finally {
                  if (active.current && mine === generation.current) setBusy(undefined);
                }
              }}
            >
              核验肖像材料 {index + 1}
            </Button>
          ))}
        </div>
      ) : null}
      {error ? <Alert type="error" title={error} /> : null}
    </div>
  );
}
