import { Alert, Button, Select } from "antd";
import { useState } from "react";
import { FormField } from "../../../components/FormField";
import { useCan } from "../../../lib/permissions";
import { publishError, type PackResult, type PublishApi } from "./publish-api";
import { usePublishWrite } from "./publish-write";
type Release = Awaited<ReturnType<PublishApi["history"]>>["releases"][number];
export function PackPanel({ api, releases }: { api: PublishApi; releases: Release[] }) {
  const [id, setId] = useState(releases.find((r) => r.state === "pushed")?.deliveryReleaseId ?? "");
  const selected = releases.find((r) => r.deliveryReleaseId === id);
  return (
    <section className="lyx-production-card">
      <h3>交付包预打包</h3>
      <FormField label="交付版本">
        {(field) => (
          <Select
            {...field}
            value={id || undefined}
            onChange={setId}
            options={releases.map((r) => ({
              value: r.deliveryReleaseId,
              label: `第 ${r.releaseNo} 版 · ${r.kind === "initial" ? "原包" : "补发包"} · ${r.variant === "common" ? "通用" : r.variant === "douyin" ? "抖音" : "视频号"}${r.state !== "pushed" ? "（历史版本）" : ""}`,
            }))}
          />
        )}
      </FormField>
      {selected ? (
        <PackAction key={id} api={api} release={selected} />
      ) : (
        <p>尚无可打包的交付版本</p>
      )}
    </section>
  );
}
export function packStatus(result: PackResult) {
  const labels = { none: "尚未打包", building: "正在打包", failed: "打包失败", ready: "打包完成" };
  return {
    type:
      result.zipState === "ready"
        ? ("success" as const)
        : result.zipState === "failed"
          ? ("error" as const)
          : ("info" as const),
    title: `${labels[result.zipState]} · 第 ${result.zipGen} 次打包`,
  };
}
function PackAction({ api, release }: { api: PublishApi; release: Release }) {
  const canPack = useCan("publish.package.push"),
    write = usePublishWrite();
  const [result, setResult] = useState<PackResult>();
  return (
    <div className="lyx-production-form">
      <p>仅在点击后读取或发起打包；失败任务可能重新打包。以下为上次确认状态，不会自动刷新。</p>
      {result ? <Alert {...packStatus(result)} /> : <p>尚未确认打包状态</p>}
      {write.error ? <Alert type="error" title={publishError(write.error)} /> : null}
      {canPack ? (
        <Button
          loading={write.pending}
          disabled={
            write.phase === "blocked" || (release.state !== "pushed" && write.phase === "idle")
          }
          onClick={() => {
            setResult(undefined);
            void write
              .run(
                { id: release.deliveryReleaseId },
                (key, signal) => api.pack(release.deliveryReleaseId, key, signal),
                async (_signal, value) => {
                  if (value.deliveryReleaseId !== release.deliveryReleaseId)
                    throw new Error("打包结果所属版本不一致，请重新确认");
                  return value;
                },
              )
              .then((done) => {
                if (done) setResult(done.value);
              });
          }}
        >
          预打包 / 查看或重试打包
        </Button>
      ) : (
        <p>当前权限仅可查看交付版本</p>
      )}
      {write.phase === "blocked" ? (
        <Button onClick={() => write.clear()}>重新确认打包意图</Button>
      ) : null}
    </div>
  );
}
