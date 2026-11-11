import { Alert, Button, Checkbox, Input, Modal } from "antd";
import { useEffect, useRef, useState } from "react";
import { showSuccessNotice } from "../../../app/feedback";
import { FormField } from "../../../components/FormField";
import { InfoList } from "../../../components/InfoList";
import { useCan } from "../../../lib/permissions";
import { usePublishWrite } from "../../delivery/ticket-detail/publish-write";
import type { VerifyApi, VerifyDetail } from "./api";
import { canRevoke, revokeBody } from "./revoke-model";
export function RevokePanel({
  detail,
  api,
  refresh,
}: {
  detail: VerifyDetail;
  api: VerifyApi;
  refresh(): void;
}) {
  const allowed = useCan("publish.link.verify_revoke");
  const [fresh, setFresh] = useState<VerifyDetail>(),
    [reason, setReason] = useState(""),
    [checked, setChecked] = useState(false);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState<string>();
  const busy = useRef(false),
    lifetime = useRef<AbortController | null>(null),
    write = usePublishWrite();
  useEffect(() => {
    const own = new AbortController();
    lifetime.current = own;
    return () => own.abort();
  }, []);
  const reload = async () => {
    if (busy.current || write.pending) return;
    busy.current = true;
    setLoading(true);
    setError(undefined);
    setChecked(false);
    try {
      const signal = lifetime.current!.signal;
      const current = await api.detail(detail.launchSubmissionId, signal);
      if (signal.aborted) return;
      if (current.launchSubmissionId !== detail.launchSubmissionId || !canRevoke(current)) {
        setFresh(undefined);
        setError("当前记录已不可撤销，请刷新核验队列");
        refresh();
        return;
      }
      setFresh(current);
      write.clear();
    } catch (failure) {
      if (!lifetime.current?.signal.aborted)
        setError(failure instanceof Error ? failure.message : "刷新核验记录失败");
    } finally {
      if (!lifetime.current?.signal.aborted) {
        setLoading(false);
        busy.current = false;
      }
    }
  };
  const body = fresh ? revokeBody(fresh, reason) : null;
  const locked = write.pending || write.phase !== "idle" || loading;
  return (
    <>
      {allowed && canRevoke(detail) ? (
        <Button aria-label="撤销核验" danger loading={loading} onClick={() => void reload()}>
          撤销核验
        </Button>
      ) : null}
      {error ? <Alert type="error" title={error} /> : null}
      {fresh ? (
        <Modal
          open
          title="撤销已通过的核验"
          footer={null}
          closable={!write.pending}
          keyboard={!write.pending}
          mask={{ closable: !write.pending }}
          onCancel={() => {
            if (!write.pending) {
              setFresh(undefined);
              setReason("");
              setChecked(false);
              write.abandon();
            }
          }}
        >
          <div className="lyx-revoke-form">
            <InfoList
              items={[
                { label: "发布账号", value: fresh.account.accountName },
                { label: "核验轮次", value: `第 ${fresh.roundNo} 轮` },
                { label: "已核验集数", value: `${fresh.verifiedEpisodeCount} 集` },
              ]}
            />
            <p>撤销后将重开新一轮核验，原核验记录保留。请核对当前轮次和集数。</p>
            <FormField label="撤销原因">
              {(field) => (
                <Input.TextArea
                  {...field}
                  value={reason}
                  maxLength={200}
                  disabled={locked}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setChecked(false);
                  }}
                />
              )}
            </FormField>
            <Checkbox
              checked={checked}
              disabled={locked}
              onChange={(e) => setChecked(e.target.checked)}
            >
              我已核对本轮集数并确认重开核验
            </Checkbox>
            {write.error ? (
              <Alert
                type="error"
                title={
                  write.error instanceof Error ? write.error.message : "撤销结果尚未确认，请重试"
                }
              />
            ) : null}
            {write.phase === "blocked" ? (
              <Button
                aria-label="刷新核验记录并重新确认"
                loading={loading}
                onClick={() => void reload()}
              >
                刷新核验记录并重新确认
              </Button>
            ) : null}
            <div className="lyx-confirm__footer">
              <Button
                disabled={write.pending}
                onClick={() => {
                  setFresh(undefined);
                  setReason("");
                  setChecked(false);
                  write.abandon();
                }}
              >
                取消
              </Button>
              <Button
                danger
                type="primary"
                aria-label={write.phase === "accepted" ? "重试读取撤销结果" : "确认撤销核验"}
                loading={write.pending}
                disabled={!checked || !body || write.phase === "blocked" || loading}
                onClick={() => {
                  if (!body || !allowed) return;
                  void write
                    .run(
                      { id: fresh.launchSubmissionId, body },
                      (key, signal) => api.revoke(fresh.launchSubmissionId, body, key, signal),
                      (signal, value) => api.detail(value.launchSubmissionId, signal),
                    )
                    .then((done) => {
                      if (!done) return;
                      setFresh(undefined);
                      setReason("");
                      setChecked(false);
                      refresh();
                      showSuccessNotice(`核验已撤销，当前为第 ${done.value.roundNo} 轮`);
                    });
                }}
              >
                {write.phase === "accepted" ? "重试读取撤销结果" : "确认撤销核验"}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
