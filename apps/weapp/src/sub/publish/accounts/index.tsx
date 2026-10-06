import { useEffect, useRef, useState } from "react";
import { View } from "@tarojs/components";
import Taro, { useReachBottom } from "@tarojs/taro";
import type { components } from "@liyoxi/contract/types/merchant";
import type { Data } from "@/lib/account-api";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { DescList } from "@/components/DescList";
import { Empty } from "@/components/Empty";
import { Field } from "@/components/Field";
import { Input } from "@/components/Input";
import { ListFooter } from "@/components/ListFooter";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { Sheet } from "@/components/Sheet";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag, merchantStatusByEnum } from "@/components/StatusTag";
import { account } from "@/lib/account-runtime";
import { newIdempotencyKey } from "@/lib/runtime";
import { useUploadBusy } from "@/lib/upload/taro";
import { catalogScope, viewerRole, useCatalogStore } from "@/stores/catalog";
import { useContextStore } from "@/stores/context";
import { useOrderStore } from "@/stores/order";
import { usePublishStore } from "@/stores/publish";
import { useSessionStore } from "@/stores/session";
import { publishApi } from "./api";
import { usePublishResource } from "./resource";
import { Screenshots, type Screenshot } from "./screenshots";
import "./index.scss";
type CardData = components["schemas"]["ChannelAccountCard"];
const platformNames = { douyin: "抖音", wechat_channels: "视频号" };
const typeNames = { enterprise: "企业认证", personal: "个人认证", none: "未认证" };
export default function AccountsPage() {
  const rev = useContextStore((s) => s.contextRev),
    token = useSessionStore((s) => s.accessToken);
  return <Accounts key={`${rev}:${token}`} />;
}
function Accounts() {
  const resource = usePublishResource(async () =>
    viewerRole(account.snapshot().me, catalogScope()) === "owner" ? publishApi.list() : null,
  );
  const [page, setPage] = useState<Data<"m.channelAccount.list"> | null>(null),
    [more, setMore] = useState(false),
    [moreError, setMoreError] = useState<string | null>(null),
    [form, setForm] = useState<CardData | "new" | null>(null);
  const paging = useRef<object | null>(null);
  const loaded = resource.data,
    initialLoading = resource.loading,
    guard = resource.guard;
  useEffect(() => {
    paging.current = null;
    const current = guard(true);
    void Promise.resolve().then(() => {
      if (!current()) return;
      setMore(false);
      setMoreError(null);
      if (!initialLoading) setPage(loaded);
    });
  }, [loaded, initialLoading, guard]);
  const loadMore = async () => {
    if (paging.current || resource.loading || !page?.hasMore || !page.nextCursor) return;
    const own = {},
      current = resource.guard(true);
    paging.current = own;
    setMore(true);
    setMoreError(null);
    try {
      const next = await publishApi.list(page.nextCursor);
      if (current() && paging.current === own)
        setPage((p) => {
          const seen = new Set(p?.items.map((i) => i.channelAccountId));
          return {
            ...next,
            items: [
              ...(p?.items ?? []),
              ...next.items.filter(
                (i) => !seen.has(i.channelAccountId) && Boolean(seen.add(i.channelAccountId)),
              ),
            ],
          };
        });
    } catch (e: unknown) {
      if (current() && paging.current === own)
        setMoreError(e instanceof Error ? e.message : "加载失败，请重试");
    } finally {
      if (current() && paging.current === own) {
        paging.current = null;
        setMore(false);
      }
    }
  };
  useReachBottom(() => {
    void loadMore();
  });
  return (
    <View className="accounts-page" id={resource.loading ? undefined : "publish-ready"}>
      <PageBody>
        <Note>
          成片交付后，请在绑定账号一次性发布并回填链接，平台负责核验。平台不会索取账号密码。
        </Note>
        {resource.error ? (
          <LoadError
            message={resource.error}
            onRetry={resource.refresh}
            retrying={resource.loading}
          />
        ) : null}
        {!page && resource.loading ? (
          <Skeleton cards={2} />
        ) : !page ? (
          <Empty title="仅老板可管理发布账号" />
        ) : (
          <>
            {page.items.length ? (
              page.items.map((item) => {
                const tone = merchantStatusByEnum("channel_account.status", item.status);
                return (
                  <Card
                    key={item.channelAccountId}
                    title={`${platformNames[item.platform]} · ${item.accountName}`}
                    extra={
                      tone ? (
                        <StatusTag plain tone={tone.tone}>
                          {tone.label}
                        </StatusTag>
                      ) : null
                    }
                  >
                    <DescList
                      items={[
                        { label: "账号 ID", value: item.accountUid },
                        {
                          label: "认证类型",
                          value: typeNames[item.accountType ?? item.submittedAccountType],
                        },
                        {
                          label: "使用情况",
                          value: `制作中 ${item.usage.inProgressCount} 部 · 待上线 ${item.usage.toLaunchCount} 部 · 上线中 ${item.usage.liveCount} 部`,
                        },
                      ]}
                    />
                    {item.status === "pending_verify" ? (
                      <Note>待核验，通过后即可在订购时选择</Note>
                    ) : null}
                    {item.abnormalReason ? (
                      <Note tone="warning">
                        核验未通过：{item.abnormalReason.name}
                        {item.abnormalNote ? ` · ${item.abnormalNote}` : ""}
                      </Note>
                    ) : null}
                    {item.actions.includes("submit") ? (
                      <Button size="sm" variant="outline" onClick={() => setForm(item)}>
                        重新提交主页截图
                      </Button>
                    ) : null}
                  </Card>
                );
              })
            ) : (
              <Empty title="暂无发布账号" description="绑定并通过核验后可在订购时选择" />
            )}
            {moreError ? (
              <LoadError
                message={moreError}
                retrying={more}
                onRetry={() => {
                  void loadMore();
                }}
              />
            ) : null}
            {more || !page.hasMore ? (
              <ListFooter status={more ? "loading" : "done"} />
            ) : (
              <Button
                block
                variant="outline"
                size="sm"
                onClick={() => {
                  void loadMore();
                }}
              >
                继续查看账号
              </Button>
            )}
            <Button block variant="outline" onClick={() => setForm("new")}>
              绑定新账号
            </Button>
          </>
        )}
      </PageBody>
      {form ? (
        <AccountForm
          key={form === "new" ? "new" : form.channelAccountId}
          accountData={form === "new" ? null : form}
          guard={resource.guard}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            usePublishStore.getState().changed();
            useOrderStore.getState().changed();
            useCatalogStore.getState().changed();
            resource.refresh();
          }}
        />
      ) : null}
    </View>
  );
}
function AccountForm({
  accountData,
  guard,
  onClose,
  onSaved,
}: {
  accountData: CardData | null;
  guard: (includeRead?: boolean) => () => boolean;
  onClose(): void;
  onSaved(): void;
}) {
  const [platform, setPlatform] = useState<"douyin" | "wechat_channels">(
      accountData?.platform ?? "douyin",
    ),
    [name, setName] = useState(accountData?.accountName ?? ""),
    [uid, setUid] = useState(accountData?.accountUid ?? ""),
    [kind, setKind] = useState<"enterprise" | "personal" | "none">(
      accountData?.submittedAccountType ?? "none",
    ),
    [files, setFiles] = useState<Screenshot[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey("channel_bind")),
    active = useRef(false),
    mounted = useRef(true),
    uploading = useUploadBusy();
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const change = () => {
    if (active.current) return;
    key.current = newIdempotencyKey("channel_bind");
    setError(null);
  };
  const valid =
    name.trim().length > 0 &&
    uid.trim().length > 0 &&
    files.length > 0 &&
    new Set(files.map((f) => f.fileId)).size === files.length;
  const submit = async () => {
    if (active.current || uploading || !valid) return;
    const current = guard();
    if (!current() || !mounted.current) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      const screenshotFileIds = files.map((f) => f.fileId);
      if (accountData)
        await publishApi.submit(
          accountData.channelAccountId,
          { accountType: kind, screenshotFileIds },
          key.current,
        );
      else
        await publishApi.create(
          {
            platform,
            accountName: name.trim(),
            accountUid: uid.trim(),
            accountType: kind,
            screenshotFileIds,
          },
          key.current,
        );
      if (current() && mounted.current) {
        onSaved();
        void Taro.showToast({ title: "已提交，等待核验", icon: "none" });
      }
    } catch (e: unknown) {
      if (current() && mounted.current)
        setError(e instanceof Error ? e.message : "提交失败，请重试");
    } finally {
      if (current() && mounted.current) {
        active.current = false;
        setBusy(false);
      }
    }
  };
  const close = () => {
    if (!busy && !uploading) onClose();
  };
  return (
    <Sheet
      visible
      title={accountData ? "重新提交主页截图" : "绑定新账号"}
      closeOnOverlayClick={!busy && !uploading}
      onClose={close}
      footer={
        <View className="accounts-page__actions">
          <Button block variant="outline" disabled={busy || uploading} onClick={close}>
            取消
          </Button>
          <Button
            block
            loading={busy}
            disabled={!valid || uploading}
            onClick={() => {
              void submit();
            }}
          >
            提交核验
          </Button>
        </View>
      }
    >
      <View className="accounts-page__form">
        {accountData ? (
          <DescList
            items={[
              { label: "平台", value: platformNames[platform] },
              { label: "账号名称", value: name },
              { label: "账号 ID", value: uid },
            ]}
          />
        ) : (
          <>
            <Field label="平台" required>
              <View className="accounts-page__chips">
                {(["douyin", "wechat_channels"] as const).map((p) => (
                  <Chip
                    key={p}
                    selected={platform === p}
                    disabled={busy || uploading}
                    onClick={() => {
                      change();
                      setPlatform(p);
                    }}
                  >
                    {platformNames[p]}
                  </Chip>
                ))}
              </View>
            </Field>
            <Field label="账号名称" required>
              <Input
                value={name}
                maxlength={30}
                placeholder="与平台主页显示一致"
                disabled={busy || uploading}
                onChange={(v) => {
                  change();
                  setName(v);
                }}
              />
            </Field>
            <Field label={platform === "douyin" ? "抖音号" : "视频号 ID"} required>
              <Input
                value={uid}
                maxlength={64}
                placeholder="在平台主页查看"
                disabled={busy || uploading}
                onChange={(v) => {
                  change();
                  setUid(v);
                }}
              />
            </Field>
          </>
        )}
        <Field label="认证类型" required>
          <View className="accounts-page__chips">
            {(["enterprise", "personal", "none"] as const).map((t) => (
              <Chip
                key={t}
                selected={kind === t}
                disabled={busy || uploading}
                onClick={() => {
                  change();
                  setKind(t);
                }}
              >
                {typeNames[t]}
              </Chip>
            ))}
          </View>
        </Field>
        <Field label="账号主页截图" required>
          <Screenshots
            files={files}
            disabled={busy}
            onChange={(next) => {
              change();
              setFiles(next);
            }}
          />
        </Field>
        {error ? <Note tone="warning">{error}</Note> : null}
      </View>
    </Sheet>
  );
}
