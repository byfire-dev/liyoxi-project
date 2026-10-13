import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Alert, Button, Checkbox, Select, Space } from "antd";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { InfoList } from "../../../components/InfoList";
import { QueryTablePage } from "../../../components/QueryTablePage";
import { EmptyState, ErrorState } from "../../../components/StateBlock";
import { hasModuleLevel, canAction, type AccessSnapshot } from "../../../lib/permissions";
import { DETAIL_QUERY, LIST_QUERY } from "../../../lib/query";
import { type MerchantApi, type StoreHeader } from "./api";
import {
  closeIntent,
  contactedIntent,
  createAccountIntent,
  decideAccountIntent,
  followIntent,
  managerIntent,
  profileIntent,
  quotaIntent,
  userIntent,
  type MerchantIntent,
} from "./actions";
import { allowed, amount, MERCHANT_KEY, merchantScope, moment, status, text } from "./model";
export interface PanelProps {
  api: MerchantApi;
  row: StoreHeader;
  access: AccessSnapshot | null;
  open(intent: MerchantIntent): void;
  dismiss(): void;
}
function Resource<T>({
  query,
  children,
}: {
  query: UseQueryResult<T, Error>;
  children(data: T): ReactNode;
}) {
  return query.isPending ? (
    <p aria-busy="true">正在加载…</p>
  ) : query.isError ? (
    <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
  ) : (
    children(query.data)
  );
}
const key = (p: PanelProps, kind: string, ...rest: unknown[]) => [
  ...MERCHANT_KEY,
  merchantScope(p.access),
  p.row.storeId,
  kind,
  ...rest,
];
export function ProfilePanel(p: PanelProps) {
  const q = useQuery({
    queryKey: key(p, "profile"),
    queryFn: () => p.api.profile(p.row.storeId),
    ...DETAIL_QUERY,
  });
  return (
    <Resource query={q}>
      {(r) => (
        <>
          {allowed(p.access, "merchant.profile.proxy_edit", r.actions, "update") ? (
            <Button onClick={() => p.open(profileIntent(r))}>代改免审档案</Button>
          ) : null}
          <InfoList
            labelWidth={110}
            items={[
              { label: "门店名称", value: text(r.storeName) },
              { label: "品牌", value: text(r.brandName) },
              {
                label: "行业 / 品类",
                value: `${text(r.industry?.name)} / ${text(r.category?.name)}`,
              },
              {
                label: "地址",
                value:
                  [
                    r.address.province?.name,
                    r.address.city?.name,
                    r.address.district?.name,
                    r.address.detail,
                  ]
                    .filter(Boolean)
                    .join(" ") || "—",
              },
              { label: "门店电话", value: text(r.storeTel) },
              {
                label: "营业时间",
                value: r.businessHours.map((v) => `${v.start}–${v.end}`).join("、") || "—",
              },
              { label: "人均消费", value: amount(r.avgSpendFen) },
              { label: "品牌介绍", value: text(r.brandIntro, 500) },
              { label: "优惠 / 团购", value: `${text(r.promoText)} / ${text(r.groupBuyText)}` },
              { label: "卖点", value: r.sellingPoints.map((v) => v.name).join("、") || "—" },
              { label: "卖点补充", value: text(r.sellingNote) },
              {
                label: "资料完整度",
                value: `${r.completeness.pct}%（${r.completeness.requiredFilled}/${r.completeness.requiredTotal}）`,
              },
              { label: "档案版本", value: r.lockVersion },
              {
                label: "最后修改",
                value: `${moment(r.lastEditedAt)} · ${text(r.lastEditor?.name)}`,
              },
            ]}
          />
          {r.pendingChange ? (
            <Alert
              type="info"
              title={`存在档案变更轮次：${text(r.pendingChange.phase)}`}
              description={
                <a
                  className="lyx-link"
                  href={`/merchants/review?id=${r.pendingChange.qualificationSubmissionId}`}
                >
                  查看该轮审核
                </a>
              }
            />
          ) : null}
          <h3>服务项目</h3>
          {r.serviceItems.length ? (
            <ul>
              {r.serviceItems.map((item) => (
                <li key={item.serviceItemId}>
                  {text(item.name)} · {amount(item.priceFen)} · {text(item.intro)}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="暂无服务项目" />
          )}
          <h3>门店照片</h3>
          {Object.values(r.media).some((items) => items.length) ? (
            <ul>
              {Object.entries(r.media).map(([group, items]) => (
                <li key={group}>
                  {text(group)} · {items.length} 项
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="暂无门店照片" />
          )}
        </>
      )}
    </Resource>
  );
}
export function QualificationPanel(p: PanelProps) {
  const q = useQuery({
    queryKey: key(p, "qualification"),
    queryFn: () => p.api.qualification(p.row.storeId),
    ...DETAIL_QUERY,
  });
  const [view, notice] = useSignedRead(p.api);
  return (
    <Resource query={q}>
      {(r) => (
        <>
          <InfoList
            labelWidth={110}
            items={[
              {
                label: "当前资质",
                value: status(r.qualificationStatus, "store.qualification_status"),
              },
              { label: "主体", value: text(r.entity.name) },
              { label: "信用代码", value: text(r.entity.usccMask) },
              { label: "法定代表人", value: text(r.entity.legalRepNameMask) },
              { label: "首次提交", value: moment(r.firstSubmittedAt) },
              { label: "首次认证", value: moment(r.firstVerifiedAt) },
              { label: "最近决定", value: moment(r.lastDecidedAt) },
            ]}
          />
          {notice ? <Alert type="error" title={notice} /> : null}
          {r.openRound ? (
            <p>
              当前第 {r.openRound.roundNo} 轮 · 截止 {moment(r.openRound.dueAt)}{" "}
              <a
                className="lyx-link"
                href={`/merchants/review?id=${r.openRound.qualificationSubmissionId}`}
              >
                查看本轮审核
              </a>
            </p>
          ) : (
            <p>当前没有开放审核轮次</p>
          )}
          <h3>生效证照</h3>
          {r.effectiveDocs.length ? (
            r.effectiveDocs.map((doc) => (
              <section key={doc.qualificationDocId} className="lyx-merchant-item">
                <strong>
                  {text(doc.docType)} · {text(doc.permitType?.name)}
                </strong>
                <InfoList
                  items={[
                    { label: "持有人", value: text(doc.holderName) },
                    { label: "证号", value: text(doc.certNoMask) },
                    { label: "负责人", value: text(doc.principalNameMask) },
                    {
                      label: "有效期",
                      value: doc.isLongTerm
                        ? "长期"
                        : `${text(doc.validStartDate)} — ${text(doc.validEndDate)}`,
                    },
                    { label: "结论", value: text(doc.verdict) },
                  ]}
                />
                <Button onClick={() => void view(doc.fileId)}>查看证照文件</Button>
              </section>
            ))
          ) : (
            <EmptyState title="暂无生效证照" />
          )}
          <h3>审核轮次</h3>
          {r.rounds.length ? (
            <ul>
              {r.rounds.map((round) => (
                <li key={round.qualificationSubmissionId}>
                  第 {round.roundNo ?? "—"} 轮 · {text(round.kind)} ·{" "}
                  {status(round.approval.status, "approval_request.status")} ·{" "}
                  {moment(round.submittedAt)}{" "}
                  <a
                    className="lyx-link"
                    href={`/merchants/review?id=${round.qualificationSubmissionId}`}
                  >
                    查看该轮
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="暂无审核轮次" />
          )}
        </>
      )}
    </Resource>
  );
}
export function EntityPanel(p: PanelProps) {
  const [removed, setRemoved] = useState(false);
  const q = useQuery({
    queryKey: key(p, "entity"),
    queryFn: () => p.api.entity(p.row.entity.entityId),
    ...DETAIL_QUERY,
  });
  const members = useQuery({
    queryKey: key(p, "members", removed),
    queryFn: () =>
      p.api.members(p.row.entity.entityId, { includeRemoved: removed ? "true" : "false" }),
    ...DETAIL_QUERY,
  });
  return (
    <Resource query={q}>
      {(r) => (
        <>
          <Space>
            {allowed(p.access, "merchant.quota.override", r.actions, "update-quota") ? (
              <Button onClick={() => p.open(quotaIntent(r))}>调整主体额度</Button>
            ) : null}
            {allowed(p.access, "merchant.entity.close", r.actions, "close") ? (
              <Button danger onClick={() => p.open(closeIntent(r))}>
                关闭主体
              </Button>
            ) : null}
          </Space>
          <InfoList
            labelWidth={110}
            items={[
              { label: "主体", value: text(r.name) },
              { label: "生命周期", value: status(r.lifecycle, "entity.lifecycle") },
              { label: "信用代码", value: text(r.usccMask) },
              { label: "法定代表人", value: text(r.legalRepNameMask) },
              {
                label: "门店用量",
                value: `${r.usage.storesUsed}/${r.usage.storeLimit} · 超限 ${r.usage.storesOver}`,
              },
              {
                label: "成员用量",
                value: `${r.usage.seatsUsed}/${r.usage.memberLimit ?? "不限"} · 超限 ${r.usage.seatsOver}`,
              },
              { label: "待接受邀请", value: r.usage.pendingInvitationCount },
              { label: "可用积分", value: r.spendablePoints },
              { label: "归因来源", value: text(r.referralCode?.code) },
              { label: "关闭时间", value: moment(r.closedAt) },
            ]}
          />
          <h3>主体门店</h3>
          <ul>
            {r.stores.map((store) => (
              <li key={store.storeId}>
                <a className="lyx-link" href={`/merchants/${store.storeId}`}>
                  {text(store.name)}
                </a>{" "}
                · {status(store.lifecycle, "store.lifecycle")} · {store.isPrimary ? "主店" : "分店"}{" "}
                · 素材 {store.assetCount} / 已审 {store.reviewedAssetCount}
              </li>
            ))}
          </ul>
          <h3>成员</h3>
          <Checkbox checked={removed} onChange={(e) => setRemoved(e.target.checked)}>
            包含历史已移出成员
          </Checkbox>
          <Resource query={members}>
            {(value) =>
              value.items.length ? (
                <div>
                  {value.items.map((member) => (
                    <section key={member.memberId} className="lyx-merchant-item">
                      <strong>{text(member.user.displayName)}</strong> ·{" "}
                      <span>{text(member.user.phoneMask)}</span> · {text(member.role)} ·{" "}
                      {status(member.user.status, "merchant_user.status")} · {text(member.status)}
                      <p>
                        加入 {moment(member.joinedAt)} · 上传 {member.uploadedAssetCount} / 采纳{" "}
                        {member.adoptedAssetCount}
                        {member.removedAt
                          ? ` · 移出 ${moment(member.removedAt)}（${text(member.removeReason)}）`
                          : ""}
                      </p>
                      <Space>
                        {(
                          [
                            ["disable", "disable", "merchant.user.disable", "禁用"],
                            ["enable", "enable", "merchant.user.disable", "启用"],
                            ["logout", "force-logout", "merchant.user.force_logout", "强制下线"],
                          ] as const
                        )
                          .filter(([_kind, action, permission]) =>
                            allowed(p.access, permission, member.actions, action),
                          )
                          .map(([kind, _action, _permission, label]) => (
                            <Button
                              key={kind}
                              danger={kind !== "enable"}
                              onClick={() => p.open(userIntent(member, kind))}
                            >
                              {label}
                            </Button>
                          ))}
                      </Space>
                    </section>
                  ))}
                </div>
              ) : (
                <EmptyState title="暂无可见成员" />
              )
            }
          </Resource>
          <h3>待接受邀请</h3>
          {r.pendingInvitations.length ? (
            <ul>
              {r.pendingInvitations.map((i) => (
                <li key={i.invitationId}>
                  {text(i.remarkName)} · 邀请人 {text(i.inviterName)} · 到期 {moment(i.expiresAt)}
                </li>
              ))}
            </ul>
          ) : (
            <p>暂无待接受邀请</p>
          )}
        </>
      )}
    </Resource>
  );
}
export function FollowPanel(p: PanelProps) {
  const [page, setPage] = useState(1),
    [poolPage, setPoolPage] = useState(1),
    [isOpen, setIsOpen] = useState<string>();
  const mayManage =
    allowed(p.access, "merchant.manager.assign", p.row.actions, "assign-delivery-manager") ||
    allowed(p.access, "merchant.manager.transfer", p.row.actions, "reassign-delivery-manager");
  const q = useQuery({
    queryKey: key(p, "follows", page, isOpen),
    queryFn: () =>
      p.api.follows({
        storeId: p.row.storeId,
        page,
        pageSize: 20,
        ...(isOpen ? { isOpen: isOpen === "true" } : {}),
      }),
    ...LIST_QUERY,
    placeholderData: undefined,
  });
  const pool = useQuery({
    queryKey: key(p, "manager-pool", poolPage),
    queryFn: () =>
      p.api.staff({
        pool: "delivery_manager",
        status: "active",
        withLoad: true,
        page: poolPage,
        pageSize: 20,
      }),
    enabled: mayManage,
    ...LIST_QUERY,
    placeholderData: undefined,
  });
  return (
    <>
      <h3>负责人和联系任务</h3>
      <InfoList
        labelWidth={110}
        items={[
          { label: "当前交付经理", value: text(p.row.deliveryManager?.name) },
          {
            label: "当前工作量",
            value: `短剧 ${p.row.managerOpenWork.dramaOrderCount} / 制作 ${p.row.managerOpenWork.deliveryTicketProducingCount} / 服务 ${p.row.managerOpenWork.deliveryTicketInServiceCount} / 客服 ${p.row.managerOpenWork.serviceTicketCount}`,
          },
          {
            label: "联系截止",
            value: p.row.managerContact
              ? `${moment(p.row.managerContact.contactDueAt)}${p.row.managerContact.isOverdue ? "（已逾期）" : ""}`
              : "暂无联系任务",
          },
        ]}
      />
      {mayManage ? (
        <Resource query={pool}>
          {(v) => (
            <Space>
              <Button
                disabled={!v.items.length}
                onClick={() =>
                  p.open(
                    managerIntent(
                      p.row,
                      v.items.map((s) => ({
                        value: s.staffId,
                        label: `${s.name} · 工号 ${s.staffNo}`,
                      })),
                    ),
                  )
                }
              >
                {p.row.deliveryManager ? "转移交付经理" : "指派交付经理"}
              </Button>
              <Button disabled={poolPage <= 1} onClick={() => setPoolPage(poolPage - 1)}>
                上一页候选
              </Button>
              <Button disabled={poolPage * 20 >= v.total} onClick={() => setPoolPage(poolPage + 1)}>
                下一页候选
              </Button>
            </Space>
          )}
        </Resource>
      ) : null}
      {p.row.managerContact &&
      p.row.deliveryManager?.staffId === p.access?.staff.id &&
      hasModuleLevel(p.access, "merchant", "o") ? (
        <Button onClick={() => p.open(contactedIntent(p.row))}>已联系商家</Button>
      ) : null}
      <h3>跟进记录</h3>
      <Select
        aria-label="跟进状态"
        allowClear
        placeholder="全部跟进"
        value={isOpen}
        options={[
          { value: "true", label: "待跟进" },
          { value: "false", label: "已完成" },
        ]}
        onChange={(v) => {
          setIsOpen(v);
          setPage(1);
        }}
      />
      <QueryTablePage
        label="门店跟进记录"
        search={{ page, pageSize: 20, filters: {} }}
        onSearchChange={(next) => setPage(next.page)}
        columns={[
          {
            key: "content",
            title: "跟进",
            render: (r) => (
              <span className="lyx-cell-2">
                {text(r.content, 200)}
                <span className="lyx-cell-2__sub">
                  {text(r.subjectType)} · {text(r.channel)} · {text(r.owner?.name)}
                </span>
              </span>
            ),
          },
          {
            key: "time",
            title: "时间",
            width: 180,
            render: (r) => (
              <span className="lyx-cell-2">
                {moment(r.createdAt)}
                <span className="lyx-cell-2__sub">下次 {moment(r.nextFollowAt)}</span>
              </span>
            ),
          },
          {
            key: "action",
            title: "操作",
            width: 200,
            render: (r) => (
              <Space>
                {hasModuleLevel(p.access, "merchant", "o") && r.actions.includes("update") ? (
                  <Button type="link" onClick={() => p.open(followIntent(r, "update"))}>
                    调整时间
                  </Button>
                ) : null}
                {hasModuleLevel(p.access, "merchant", "o") && r.actions.includes("complete") ? (
                  <Button type="link" onClick={() => p.open(followIntent(r, "complete"))}>
                    完成
                  </Button>
                ) : null}
                {hasModuleLevel(p.access, "merchant", "o") &&
                r.subjectType !== "store" &&
                r.actions.length ? (
                  <Button type="link" onClick={() => p.open(followIntent(r, "continue"))}>
                    继续跟进
                  </Button>
                ) : null}
              </Space>
            ),
          },
        ]}
        rowKey={(r) => r.followUpId}
        query={
          q.isPending
            ? { status: "loading" }
            : q.isError
              ? { status: "error", message: q.error.message }
              : { status: "success", items: q.data.items, total: q.data.total }
        }
        onRetry={() => void q.refetch()}
        refreshing={q.isFetching}
        empty={{ title: "暂无跟进记录" }}
      />
    </>
  );
}
export function AccountsPanel(p: PanelProps) {
  const [page, setPage] = useState(1),
    [selected, setSelected] = useState<string>(),
    [targetId, setTargetId] = useState<string>();
  const entity = useQuery({
    queryKey: key(p, "entity"),
    queryFn: () => p.api.entity(p.row.entity.entityId),
    ...DETAIL_QUERY,
  });
  const members = useQuery({
    queryKey: key(p, "account-members"),
    queryFn: () => p.api.members(p.row.entity.entityId),
    ...DETAIL_QUERY,
  });
  const reasons = useQuery({
    queryKey: [...MERCHANT_KEY, merchantScope(p.access), "account-reasons"],
    queryFn: () => p.api.dict({ typeKey: "account_change_reason" }),
    enabled: canAction(p.access, "merchant.account_change.request"),
    ...LIST_QUERY,
  });
  const q = useQuery({
    queryKey: key(p, "requests", page),
    queryFn: () => p.api.requests({ entityId: p.row.entity.entityId, page, pageSize: 20 }),
    ...LIST_QUERY,
    placeholderData: undefined,
  });
  const detail = useQuery({
    queryKey: key(p, "request", selected),
    queryFn: () => p.api.request(selected!),
    enabled: !!selected,
    ...DETAIL_QUERY,
  });
  const requestable =
    canAction(p.access, "merchant.account_change.request") && hasModuleLevel(p.access, "merchant");
  const factsReady =
    entity.isSuccess &&
    !entity.isFetching &&
    members.isSuccess &&
    !members.isFetching &&
    reasons.isSuccess &&
    !reasons.isFetching;
  const target = factsReady
    ? members.data.items.find((m) => m.user.merchantUserId === targetId)?.user
    : undefined;
  const client = useQueryClient(),
    dismiss = p.dismiss;
  const protectedKeys = [
    JSON.stringify(key(p, "entity")),
    JSON.stringify(key(p, "account-members")),
    JSON.stringify([...MERCHANT_KEY, merchantScope(p.access), "account-reasons"]),
  ].join("|");
  useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        if (
          requestable &&
          protectedKeys.split("|").includes(JSON.stringify(event.query.queryKey)) &&
          (event.query.state.status === "error" || event.query.state.status === "pending")
        ) {
          setTargetId(undefined);
          dismiss();
        }
      }),
    [client, requestable, protectedKeys, dismiss],
  );
  return (
    <>
      {requestable ? (
        <div className="lyx-merchant-item">
          <h3>发起账号变更申请</h3>
          <p>申请与批准分别鉴权，服务端复核当前范围、证明归属、目标状态与自审限制。</p>
          <Select
            aria-label="账号变更目标"
            disabled={!factsReady}
            placeholder="选择当前成员"
            style={{ minWidth: 240 }}
            value={targetId}
            options={(members.data?.items ?? [])
              .filter((m) => m.status === "active" && m.user.status !== "deleted")
              .map((m) => ({
                value: m.user.merchantUserId,
                label: `${text(m.user.displayName)} · ${text(m.user.phoneMask)}`,
              }))}
            onChange={setTargetId}
          />
          <Space>
            {factsReady && entity.data && target && reasons.data ? (
              <>
                <Button
                  onClick={() =>
                    p.open(
                      createAccountIntent(
                        "phone_rebind",
                        entity.data,
                        target,
                        reasons.data.items.map((r) => ({ value: r.code, label: r.name })),
                      ),
                    )
                  }
                >
                  申请手机号改绑
                </Button>
                {entity.data.owner?.merchantUserId === target.merchantUserId ? (
                  <>
                    <Button
                      onClick={() =>
                        p.open(
                          createAccountIntent(
                            "owner_transfer",
                            entity.data,
                            target,
                            reasons.data.items.map((r) => ({ value: r.code, label: r.name })),
                          ),
                        )
                      }
                    >
                      申请更换老板
                    </Button>
                    <Button
                      onClick={() =>
                        p.open(
                          createAccountIntent(
                            "owner_reverify",
                            entity.data,
                            target,
                            reasons.data.items.map((r) => ({ value: r.code, label: r.name })),
                          ),
                        )
                      }
                    >
                      申请重认证放行
                    </Button>
                  </>
                ) : null}
              </>
            ) : null}
          </Space>
          {members.isError || entity.isError || reasons.isError ? (
            <ErrorState
              message="申请所需事实加载失败"
              onRetry={() => {
                void members.refetch();
                void entity.refetch();
                void reasons.refetch();
              }}
            />
          ) : null}
        </div>
      ) : null}
      <QueryTablePage
        label="账号变更申请列表"
        search={{ page, pageSize: 20, filters: {} }}
        onSearchChange={(next) => setPage(next.page)}
        columns={[
          {
            key: "request",
            title: "申请单",
            render: (r) => (
              <span className="lyx-cell-2">
                {r.requestNo}
                <span className="lyx-cell-2__sub">
                  {text(r.kind)} · {text(r.target?.displayName)} · {text(r.target?.phoneMask)}
                </span>
              </span>
            ),
          },
          {
            key: "status",
            title: "状态",
            width: 120,
            render: (r) => status(r.approval.status, "approval_request.status"),
          },
          {
            key: "time",
            title: "申请时间",
            width: 180,
            render: (r) => moment(r.approval.submittedAt),
          },
        ]}
        rowKey={(r) => r.accountChangeRequestId}
        onRowClick={(r) => setSelected(r.accountChangeRequestId)}
        selectedRowKey={selected}
        query={
          q.isPending
            ? { status: "loading" }
            : q.isError
              ? { status: "error", message: q.error.message }
              : { status: "success", items: q.data.items, total: q.data.total }
        }
        onRetry={() => void q.refetch()}
        refreshing={q.isFetching}
        empty={{ title: "暂无账号变更申请" }}
      />
      {selected ? (
        <Resource query={detail}>
          {(r) => (
            <section className="lyx-merchant-item">
              <h3>{r.requestNo}</h3>
              <InfoList
                labelWidth={110}
                items={[
                  { label: "申请类型", value: text(r.kind) },
                  { label: "原手机号", value: text(r.target?.phoneMask) },
                  { label: "新手机号", value: text(r.newPhoneMask) },
                  { label: "原因", value: `${text(r.reason.name)} · ${text(r.reasonText, 500)}` },
                  { label: "申请人", value: text(r.approval.requester?.name) },
                  { label: "核验方式", value: text(r.verifyMethod) },
                  { label: "核验记录", value: text(r.verifyRecord, 500) },
                  {
                    label: "当前复核",
                    value: r.precheck
                      ? r.precheck.ok
                        ? "当前检查通过；执行时仍会重核"
                        : r.precheck.issues.map((v) => text(v)).join("、")
                      : "尚无复核结果",
                  },
                  { label: "执行时间", value: moment(r.appliedAt) },
                ]}
              />
              <Space>
                {r.proofFileIds.map((fileId, index) => (
                  <ProofLink key={fileId} api={p.api} fileId={fileId} index={index} />
                ))}
              </Space>
              <Space>
                {(["approve", "reject", "withdraw"] as const)
                  .filter(
                    (kind) =>
                      r.actions.includes(kind) &&
                      (kind === "withdraw"
                        ? requestable || canAction(p.access, "merchant.account_change.approve")
                        : canAction(p.access, "merchant.account_change.approve")),
                  )
                  .map((kind) => (
                    <Button
                      key={kind}
                      danger={kind !== "approve"}
                      onClick={() => p.open(decideAccountIntent(r, kind))}
                    >
                      {kind === "approve" ? "批准" : kind === "reject" ? "驳回" : "撤回"}
                    </Button>
                  ))}
              </Space>
            </section>
          )}
        </Resource>
      ) : (
        <p>选择申请单查看证明与当前可用操作。</p>
      )}
    </>
  );
}
function useSignedRead(api: MerchantApi) {
  const lifetime = useRef<{ active: boolean; generation: number; controller?: AbortController }>({
    active: false,
    generation: 0,
  });
  const [error, setError] = useState<string>();
  useEffect(() => {
    const state = lifetime.current;
    state.active = true;
    return () => {
      state.active = false;
      state.generation++;
      state.controller?.abort();
    };
  }, [lifetime]);
  const view = useCallback(
    async (fileId: string) => {
      const state = lifetime.current;
      state.controller?.abort();
      const current = new AbortController(),
        mine = ++state.generation;
      state.controller = current;
      setError(undefined);
      try {
        const signed = await api.download(fileId, current.signal);
        if (!state.active || current.signal.aborted || mine !== state.generation) return;
        if (!signed.url) throw new Error("当前文件没有可用签读地址");
        window.open(signed.url, "_blank", "noopener,noreferrer");
      } catch (failure) {
        if (state.active && !current.signal.aborted && mine === state.generation)
          setError(failure instanceof Error ? failure.message : "文件读取失败");
      }
    },
    [api, lifetime],
  );
  return [view, error] as const;
}
function ProofLink({ api, fileId, index }: { api: MerchantApi; fileId: string; index: number }) {
  const [view, error] = useSignedRead(api);
  return (
    <span>
      <Button onClick={() => void view(fileId)}>查看证明 {index + 1}</Button>
      {error ? <span role="alert">{error}</span> : null}
    </span>
  );
}
export function ActivityPanel(p: PanelProps) {
  const [cursors, setCursors] = useState<string[]>([]),
    [actor, setActor] = useState<string>();
  const cursor = cursors.at(-1);
  const q = useQuery({
    queryKey: key(p, "activity", cursor, actor),
    queryFn: () =>
      p.api.activity(p.row.storeId, {
        limit: 20,
        ...(cursor ? { cursor } : {}),
        ...(actor ? { actorType: actor } : {}),
      }),
    ...DETAIL_QUERY,
  });
  return (
    <>
      <Select
        aria-label="活动操作人类型"
        allowClear
        placeholder="全部操作人"
        value={actor}
        options={[
          { value: "merchant", label: "商家" },
          { value: "staff", label: "员工" },
          { value: "system", label: "系统" },
        ]}
        onChange={(v) => {
          setActor(v);
          setCursors([]);
        }}
      />
      <Resource query={q}>
        {(r) => (
          <>
            {r.items.length ? (
              <ul>
                {r.items.map((item) => (
                  <li className="lyx-merchant-item" key={item.auditLogId}>
                    <strong>{text(item.summary, 500)}</strong>
                    <p>
                      {moment(item.createdAt)} · {text(item.actor.name)} · {text(item.actor.role)} ·{" "}
                      {item.isEntityLevel ? "主体级" : "门店级"}
                    </p>
                    {item.reason ? <p>原因：{text(item.reason.text, 500)}</p> : null}
                    <p>变更字段：{item.changedKeys.map((v) => text(v)).join("、") || "—"}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="暂无活动记录" />
            )}
            <Space>
              <Button disabled={!cursors.length} onClick={() => setCursors(cursors.slice(0, -1))}>
                上一页活动
              </Button>
              <Button
                disabled={!r.hasMore || !r.nextCursor}
                onClick={() => {
                  if (r.nextCursor) setCursors([...cursors, r.nextCursor]);
                }}
              >
                下一页活动
              </Button>
              <span>约 {r.totalApprox} 条</span>
            </Space>
          </>
        )}
      </Resource>
    </>
  );
}
