import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button } from "antd";
import { useContext, useState } from "react";
import { DetailPage } from "../../../components/DetailPage";
import { InfoList } from "../../../components/InfoList";
import { FullPageNotice } from "../../../components/StateBlock";
import { AccessContext } from "../../../lib/permissions";
import { DETAIL_QUERY } from "../../../lib/query";
import { createMerchantApi } from "./api";
import { MerchantActionDialog, type MerchantIntent } from "./actions";
import {
  amount,
  MERCHANT_KEY,
  merchantDetailSearch,
  merchantScope,
  moment,
  status,
  text,
  validStoreId,
} from "./model";
import {
  AccountsPanel,
  ActivityPanel,
  EntityPanel,
  FollowPanel,
  ProfilePanel,
  QualificationPanel,
} from "./panels";
import "./merchant.css";
const route = getRouteApi("/merchants/$storeId");
export function MerchantDetailPage() {
  const access = useContext(AccessContext),
    { storeId } = route.useParams();
  return validStoreId(storeId) ? (
    <MerchantDetailContent key={`${merchantScope(access)}:${storeId}`} storeId={storeId} />
  ) : (
    <FullPageNotice
      title="门店地址不正确"
      description="请从商家列表选择实际门店。"
      action={<a href="/merchants">返回商家列表</a>}
    />
  );
}
function MerchantDetailContent({ storeId }: { storeId: string }) {
  const access = useContext(AccessContext),
    { services } = useRouteContext({ from: "__root__" }),
    navigate = route.useNavigate();
  const api = createMerchantApi(services),
    identity = merchantScope(access),
    search = merchantDetailSearch(route.useSearch());
  const [action, setAction] = useState<MerchantIntent>(),
    [notice, setNotice] = useState<string>();
  const query = useQuery({
    queryKey: [...MERCHANT_KEY, identity, storeId, "header"],
    queryFn: () => api.store(storeId),
    ...DETAIL_QUERY,
  });
  const refresh = () =>
    services.queryClient.invalidateQueries({ queryKey: [...MERCHANT_KEY, identity] });
  if (query.isError || !query.data)
    return (
      <DetailPage
        title="商家详情"
        tabs={[]}
        activeTab={search.tab}
        onTabChange={() => {}}
        state={
          query.isPending
            ? { status: "loading" }
            : {
                status: "error",
                message: query.error?.message ?? "当前门店不可见，请返回列表重新选择",
              }
        }
        onRetry={() => void query.refetch()}
      />
    );
  const row = query.data,
    props = { api, row, access, open: setAction };
  const panels = [
    { key: "profile", label: "档案", content: <ProfilePanel {...props} /> },
    { key: "qualification", label: "资质轮次", content: <QualificationPanel {...props} /> },
    { key: "entity", label: "主体与成员", content: <EntityPanel {...props} /> },
    { key: "follow", label: "负责人和跟进", content: <FollowPanel {...props} /> },
    { key: "accounts", label: "账号变更", content: <AccountsPanel {...props} /> },
    { key: "activity", label: "活动记录", content: <ActivityPanel {...props} /> },
  ];
  return (
    <>
      {notice ? (
        <Alert type="info" title={notice} closable onClose={() => setNotice(undefined)} />
      ) : null}
      <DetailPage
        title={text(row.name)}
        subtitle={
          <>
            <a className="lyx-link" href="/merchants">
              商家列表
            </a>{" "}
            · {row.isPrimary ? "主店" : "分店"} · {text(row.entity.name)}
          </>
        }
        tags={
          <span>
            {status(row.qualificationStatus, "store.qualification_status")} ·{" "}
            {status(row.lifecycle, "store.lifecycle")}
            {row.isChangeInReview ? " · 档案变更审核中" : ""}
            {row.isFinalRejected ? " · 最终拒绝" : ""}
          </span>
        }
        actions={<Button onClick={() => void refresh()}>刷新详情</Button>}
        progress={
          <section className="lyx-card lyx-merchant-summary" aria-label="门店服务指标">
            <span>
              付费 <strong>{amount(row.paid.totalPaidFen)}</strong>
            </span>
            <span>
              订单 <strong>{row.paid.paidOrderCount}</strong>
            </span>
            <span>
              上线短剧 <strong>{row.liveDramaCount}</strong>
            </span>
            <span>
              在交付 <strong>{row.deliveringTicketCount}</strong>
            </span>
            <span>
              可用积分 <strong>{row.points.spendablePoints}</strong>
            </span>
          </section>
        }
        tabs={panels}
        activeTab={search.tab}
        onTabChange={(tab) => {
          setAction(undefined);
          setNotice(undefined);
          void navigate({ search: { tab } });
        }}
        state={{ status: "ready" }}
        onRetry={() => void query.refetch()}
        aside={[
          {
            key: "contact",
            title: "联系人与老板",
            content: (
              <InfoList
                items={[
                  { label: "联系人", value: text(row.contact.name) },
                  { label: "联系电话", value: text(row.contact.phoneMask) },
                  { label: "老板", value: text(row.owner?.displayName) },
                  { label: "老板手机", value: text(row.owner?.phoneMask) },
                  { label: "已加企微", value: row.isWecomAdded ? "是" : "否" },
                  { label: "交付经理", value: text(row.deliveryManager?.name) },
                ]}
              />
            ),
          },
          {
            key: "service",
            title: "当前套餐与上线",
            content: (
              <InfoList
                labelWidth={84}
                items={[
                  { label: "套餐", value: text(row.subscription.plan?.name) },
                  { label: "套餐状态", value: text(row.subscription.status) },
                  { label: "套餐截止", value: text(row.subscription.endDate) },
                  { label: "最近上线", value: text(row.liveSummary.firstLiveDate) },
                  { label: "使用截止", value: text(row.liveSummary.latestUsageEndDate) },
                  { label: "约定上线", value: text(row.nearestAgreedLaunchDate) },
                  { label: "注册时间", value: moment(row.registeredAt) },
                  { label: "归档时间", value: moment(row.archivedAt) },
                ]}
              />
            ),
          },
        ]}
      />
      {action ? (
        <MerchantActionDialog
          key={action.id}
          intent={action}
          api={api}
          services={services}
          refresh={refresh}
          close={() => setAction(undefined)}
          done={setNotice}
        />
      ) : null}
    </>
  );
}
