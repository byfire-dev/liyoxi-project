import { useState } from "react";
import { View } from "@tarojs/components";
import Taro, { useReachBottom, useRouter } from "@tarojs/taro";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { Cover } from "@/components/Cover";
import { Field } from "@/components/Field";
import { Input } from "@/components/Input";
import { ListFooter } from "@/components/ListFooter";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { Sheet } from "@/components/Sheet";
import { Tabs } from "@/components/Tabs";
import { deliveryRequest } from "../../order/components/delivery-runtime";
import { createTaskReadApi } from "../components/task-read-api";
import { createTaskWriteApi } from "./api";
import { createReleaseApi } from "../components/release-api";
import type { TaskPage } from "../../order/components/delivery-api";
import { mergeTaskPages, submitBody, type LinkForm } from "./model";
import { useDeliveryResource } from "../../order/components/resource";
import {
  DeliveryEmpty,
  DeliveryState,
  DeliveryStatus,
  useDeliveryIdentity,
} from "../../order/components/ui";
type Selected = { id: string; title: string; account: string; count: number; date: string };
const emptyForm: LinkForm = {
  kind: "collection",
  collection: "",
  episodes: "",
  count: "",
  date: "",
};
const api = {
  ...createTaskReadApi(deliveryRequest),
  ...createTaskWriteApi(deliveryRequest),
  ...createReleaseApi(deliveryRequest),
};
export default function TasksPage() {
  const identity = useDeliveryIdentity(),
    [tab, setTab] = useState<"todo" | "done" | "all">(
      useRouter().params.launchTaskId ? "all" : "todo",
    );
  const orderId = useRouter().params.orderId,
    launchTaskId = useRouter().params.launchTaskId;
  return (
    <TasksContent
      key={`${identity}:${orderId}:${launchTaskId}:${tab}`}
      tab={tab}
      setTab={setTab}
      orderId={orderId}
      launchTaskId={launchTaskId}
    />
  );
}
function TasksContent({
  tab,
  setTab,
  orderId,
  launchTaskId,
}: {
  tab: "todo" | "done" | "all";
  setTab: (v: "todo" | "done" | "all") => void;
  orderId?: string;
  launchTaskId?: string;
}) {
  const query = { tab, limit: 20, ...(orderId ? { orderId } : {}) };
  const r = useDeliveryResource(async (current) => {
    const orderItemId = launchTaskId ? (await api.task(launchTaskId)).task.orderItemId : undefined;
    if (!current()) throw new Error("门店上下文已变化");
    const resolved = { ...query, ...(orderItemId ? { orderItemId } : {}) };
    const [page, summary] = await Promise.all([api.tasks(resolved), api.summary()]);
    return { page, summary, query: resolved };
  });
  const [selected, setSelected] = useState<Selected | null>(null),
    [form, setForm] = useState<LinkForm>(emptyForm);
  const data = r.data;
  const more = () =>
    r.run(null, async (current) => {
      if (!data?.page.hasMore || !data.page.nextCursor) return;
      const next = await api.tasks({ ...data.query, cursor: data.page.nextCursor });
      r.replace({ ...data, page: mergeTaskPages(data.page, next) }, current);
    });
  useReachBottom(more);
  const open = (
    task: TaskPage["items"][number]["items"][number]["tasks"][number],
    title: string,
    count: number,
  ) => {
    setSelected({
      id: task.launchTaskId,
      title,
      account: task.channelAccount.accountName,
      count,
      date: task.latestSubmission?.actualLaunchDate ?? "",
    });
    setForm({
      ...emptyForm,
      count: String(task.latestSubmission?.reportedEpisodeCount ?? count),
      date: task.latestSubmission?.actualLaunchDate ?? "",
    });
  };
  const send = () =>
    r.run("link_submit", async (current) => {
      if (!selected) return;
      const body = submitBody(form);
      await api.submit(selected.id, body, r.intent("linkSubmit", { id: selected.id, body }));
      if (!current()) return;
      const [page, summary] = await Promise.all([api.tasks(data?.query ?? query), api.summary()]);
      r.replace({ page, summary, query: data?.query ?? query }, current);
      if (current()) {
        setSelected(null);
        void Taro.showToast({ title: "已提交核验", icon: "none" });
      }
    });
  return (
    <View className="delivery-page" id={!r.loading ? "delivery-ready" : undefined}>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { key: "todo", label: "待处理", badge: data?.summary.todo },
          { key: "done", label: "已完成", badge: data?.summary.done },
          { key: "all", label: "全部" },
        ]}
      />
      <PageBody>
        <DeliveryState loading={r.loading} error={r.error} retry={r.refresh} />
        {data?.summary.needFix ? (
          <Note>有 {data.summary.needFix} 个账号需要补充链接，请查看退回说明。</Note>
        ) : null}
        {data?.page.items.map((group) => (
          <Card
            key={group.orderId}
            title={group.orderNo}
            extra={group.agreedLaunchDate ?? undefined}
          >
            {group.items.map((item) => (
              <View key={item.orderItemId} className="delivery-stack delivery-separator">
                <View className="delivery-row">
                  <Cover title={item.dramaTitle} src={item.posterUrl?.url} variant="thumb" />
                  <View>
                    <View className="delivery-lead">{item.dramaTitle}</View>
                    <View className="delivery-caption">
                      {item.episodeCount} 集 · 核验 {item.liveEpisodeCount} 集
                    </View>
                    <View className="delivery-caption">
                      约定上线 {item.agreedLaunchDate ?? "待确认"}
                    </View>
                  </View>
                </View>
                {item.release ? (
                  <Card variant="subtle" title={`成片包 · 第 ${item.release.releaseNo} 版`}>
                    <View className="delivery-caption">
                      {item.release.episodeCount} 集 ·{" "}
                      {item.release.isGrantValid ? "下载授权有效" : "下载授权已过期"}
                    </View>
                    <Button
                      block
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void Taro.navigateTo({
                          url: `/sub/publish/downloads/index?orderItemId=${encodeURIComponent(item.orderItemId)}`,
                        });
                      }}
                    >
                      查看成片并存到相册
                    </Button>
                  </Card>
                ) : null}
                {item.isPaused ? <Note>制作暂停，请联系服务经理。</Note> : null}
                {item.tasks.map((task) => (
                  <View key={task.launchTaskId} className="delivery-stack delivery-separator">
                    <View className="delivery-row">
                      <View>{task.channelAccount.accountName}</View>
                      <DeliveryStatus
                        column="launch_task.review_status"
                        value={task.reviewStatus}
                      />
                    </View>
                    <View className="delivery-caption">
                      {task.platform === "douyin" ? "抖音" : "视频号"} ·{" "}
                      {task.channelAccount.accountUid}
                    </View>
                    {task.latestSubmission ? (
                      <View className="delivery-caption">
                        已回填 {task.latestSubmission.reportedEpisodeCount} 集 ·{" "}
                        {task.latestSubmission.actualLaunchDate}
                      </View>
                    ) : null}
                    {task.returnInfo ? (
                      <Note>
                        {task.returnInfo.reasons.map((v) => v.name).join("、")}{" "}
                        {task.returnInfo.note}
                      </Note>
                    ) : null}
                    {task.actions.includes("submit") ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={r.busy}
                        onClick={() => open(task, item.dramaTitle, item.episodeCount)}
                      >
                        回填上线链接
                      </Button>
                    ) : null}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        void Taro.navigateTo({
                          url: `/sub/order/launch-record/index?orderItemId=${encodeURIComponent(item.orderItemId)}`,
                        });
                      }}
                    >
                      查看上线记录
                    </Button>
                  </View>
                ))}
              </View>
            ))}
          </Card>
        ))}
        {data && !data.page.items.length ? <DeliveryEmpty text="暂无发布任务" /> : null}
        {data?.page.items.length ? (
          data.page.hasMore ? (
            <Button block variant="secondary" loading={r.busy} onClick={more}>
              继续查看任务
            </Button>
          ) : (
            <ListFooter status="done" />
          )
        ) : null}
      </PageBody>
      <Sheet
        visible={selected !== null}
        title="回填上线链接"
        description={selected ? `${selected.title} · ${selected.account}` : undefined}
        onClose={() => {
          if (!r.busy) setSelected(null);
        }}
        closeOnOverlayClick={!r.busy}
        footer={
          <Button block loading={r.busy} onClick={send}>
            提交核验
          </Button>
        }
      >
        <View className="delivery-stack">
          <View className="delivery-chips">
            {(["collection", "episodes"] as const).map((kind) => (
              <Chip
                key={kind}
                selected={form.kind === kind}
                disabled={r.busy}
                onClick={() => setForm((v) => ({ ...v, kind }))}
              >
                {kind === "collection" ? "合集链接" : "逐集链接"}
              </Chip>
            ))}
          </View>
          {form.kind === "collection" ? (
            <Field label="合集链接" required>
              <Input
                value={form.collection}
                maxlength={2000}
                disabled={r.busy}
                placeholder="请填写 HTTPS 合集链接"
                onChange={(collection) => setForm((v) => ({ ...v, collection }))}
              />
            </Field>
          ) : (
            <View className="delivery-stack">
              {(form.episodes ? form.episodes.split("\n") : [""]).map((line, index, lines) => {
                const [number = "", ...urlParts] = line.split(" ");
                const update = (episodeNo: string, url: string) => {
                  const next = [...lines];
                  next[index] = `${episodeNo} ${url}`;
                  setForm((v) => ({ ...v, episodes: next.join("\n") }));
                };
                return (
                  <View key={index} className="delivery-stack">
                    <Field label={`第 ${index + 1} 条 · 集号`} required>
                      <Input
                        type="number"
                        value={number}
                        disabled={r.busy}
                        onChange={(value) => update(value, urlParts.join(" "))}
                      />
                    </Field>
                    <Field label="本集链接" required>
                      <Input
                        value={urlParts.join(" ")}
                        disabled={r.busy}
                        maxlength={2000}
                        placeholder="请填写 HTTPS 单集链接"
                        onChange={(value) => update(number, value)}
                      />
                    </Field>
                    {lines.length > 1 ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={r.busy}
                        onClick={() =>
                          setForm((v) => ({
                            ...v,
                            episodes: lines.filter((_, i) => i !== index).join("\n"),
                          }))
                        }
                      >
                        移除此条
                      </Button>
                    ) : null}
                  </View>
                );
              })}
              <Button
                variant="outline"
                disabled={r.busy || form.episodes.split("\n").length >= (selected?.count ?? 1)}
                onClick={() =>
                  setForm((v) => ({
                    ...v,
                    episodes: `${v.episodes || "1 "}\n${(v.episodes ? v.episodes.split("\n").length : 1) + 1} `,
                  }))
                }
              >
                添加一集链接
              </Button>
            </View>
          )}
          <Field
            label="已发布集数"
            required
            hint={selected ? `本剧共 ${selected.count} 集` : undefined}
          >
            <Input
              type="number"
              value={form.count}
              disabled={r.busy}
              onChange={(count) => setForm((v) => ({ ...v, count }))}
            />
          </Field>
          <Field label="实际上线日期" required>
            <Input
              value={form.date}
              disabled={r.busy}
              placeholder="YYYY-MM-DD"
              onChange={(date) => setForm((v) => ({ ...v, date }))}
            />
          </Field>
          {r.error ? <Note>{r.error}</Note> : null}
        </View>
      </Sheet>
    </View>
  );
}
