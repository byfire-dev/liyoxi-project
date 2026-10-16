import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow, usePullDownRefresh, useReachBottom } from "@tarojs/taro";
import { formatMoney } from "@liyoxi/shared/format/money";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
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
import { Tabs } from "@/components/Tabs";
import { withSubscribe } from "@/lib/runtime";
import { useAccount } from "@/lib/account-runtime";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { invoiceContext, invoiceModel } from "./runtime";
import { invoiceStateLabel, mailLabel } from "./model";
import "./index.scss";
export default function InvoicesPage() {
  const model = useMemo(() => invoiceModel(), []);
  const visible = useRef(true);
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const rev = useContextStore((s) => s.contextRev),
    token = useSessionStore((s) => s.accessToken);
  const me = useAccount().me;
  const [tab, setTab] = useState<"todo" | "records">("todo");
  useEffect(() => {
    if (visible.current) {
      model.activate();
      void model.load();
    } else model.suspend();
    return () => model.dispose();
  }, [model, rev, token, me]);
  useDidShow(() => {
    visible.current = true;
    model.activate();
    void model.load();
  });
  useDidHide(() => {
    visible.current = false;
    model.suspend();
  });
  usePullDownRefresh(() => {
    const context = invoiceContext();
    void model.load().finally(() => {
      if (model.isActive() && context === invoiceContext()) void Taro.stopPullDownRefresh();
    });
  });
  useReachBottom(() => {
    void model.more(tab);
  });
  const draft = state.draft,
    context = state.context;
  return (
    <View className="billing-invoices" id={!state.loading ? "invoices-ready" : undefined}>
      {state.restricted ? (
        <PageBody>
          <Empty title="仅老板可管理发票" description="请联系当前门店的老板处理开票。" />
        </PageBody>
      ) : (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { key: "todo", label: `可开票 · ${state.eligibleCount}` },
              { key: "records", label: `开票记录 · ${state.recordCount}` },
            ]}
          />
          <PageBody>
            {state.receipt ? (
              <Note>已提交开票申请 {state.receipt.no}，开具后将在消息中心通知您。</Note>
            ) : null}
            {state.error && !state.form ? (
              <LoadError
                message={state.error}
                onRetry={() => {
                  void model.load();
                }}
              />
            ) : null}
            {state.loading && !context ? (
              <Skeleton cards={3} />
            ) : (
              <>
                {context ? (
                  <Card
                    title={context.invoiceTitle.entityName ?? "主体尚未认证"}
                    extra={<Text>{context.invoiceTitle.isVerified ? "已认证" : "待认证"}</Text>}
                  >
                    <View>税号 {context.invoiceTitle.taxNoMask ?? "—"}</View>
                    <View className="billing-invoices__hint">抬头取认证主体，不可修改</View>
                  </Card>
                ) : null}
                {tab === "todo" ? (
                  <>
                    {state.payments.length ? (
                      state.payments.map((payment) => (
                        <Card
                          key={payment.paymentOrderId}
                          title={payment.title}
                          extra={
                            <Text className="billing-invoices__amount">
                              ¥{formatMoney(payment.amountFen)}
                            </Text>
                          }
                        >
                          <DescList
                            items={[
                              { label: "付款单号", value: payment.orderNo },
                              { label: "开票项目", value: payment.invoiceItemName ?? "待财务配置" },
                              {
                                label: "付款时间",
                                value: payment.paidAt
                                  ? appDateTimeFormat.dateTimeFull(payment.paidAt)
                                  : "—",
                              },
                            ]}
                          />
                          {payment.actions.includes("submit-invoice") ? (
                            <Button
                              variant="outline"
                              disabled={!context?.invoiceTitle.isVerified}
                              onClick={() => model.open(payment)}
                            >
                              申请开票
                            </Button>
                          ) : (
                            <Note>
                              {payment.invoiceState === "applying"
                                ? "已申请，开票中"
                                : "当前暂不可申请开票"}
                            </Note>
                          )}
                        </Card>
                      ))
                    ) : (
                      <Empty
                        title="暂无可开票的付款"
                        description="套餐与加购积分按付款单开票，订剧和广告不单独开票。"
                      />
                    )}
                    {state.payments.length ? (
                      state.paymentsMore ? (
                        <Button
                          variant="secondary"
                          loading={state.moreBusy}
                          onClick={() => {
                            void model.more("todo");
                          }}
                        >
                          加载更多
                        </Button>
                      ) : (
                        <ListFooter status="done" />
                      )
                    ) : null}
                  </>
                ) : (
                  <>
                    {state.records.length ? (
                      state.records.map((record) => {
                        const status = merchantStatusByEnum(
                          "invoice_request.status",
                          record.status,
                        );
                        return (
                          <Card
                            key={record.invoiceRequestId}
                            title={record.itemName}
                            extra={
                              status ? (
                                <StatusTag tone={status.tone}>{status.label}</StatusTag>
                              ) : (
                                <Text>{invoiceStateLabel(record.status)}</Text>
                              )
                            }
                          >
                            <View>{record.title}</View>
                            <View className="billing-invoices__amount">
                              ¥{formatMoney(record.amountFen)}
                            </View>
                            <DescList
                              items={[
                                { label: "申请单号", value: record.requestNo },
                                { label: "付款单号", value: record.paymentOrderNo },
                                {
                                  label: "申请时间",
                                  value: appDateTimeFormat.dateTimeFull(record.appliedAt),
                                },
                                {
                                  label: "接收信息",
                                  value: record.recvEmailMask ?? record.mailToMask ?? "—",
                                },
                              ]}
                            />
                            <Note>{record.progressNote}</Note>
                            {record.reject ? (
                              <Note>
                                {record.reject.reason?.name ?? "申请已驳回"}
                                {record.reject.note ? `：${record.reject.note}` : ""}
                              </Note>
                            ) : null}
                            {record.docs.map((doc) => (
                              <View className="billing-invoices__doc" key={doc.docKind}>
                                <DescList
                                  items={[
                                    {
                                      label: doc.docKind === "blue" ? "蓝字票号" : "红字票号",
                                      value: doc.invoiceNo,
                                    },
                                    {
                                      label: "开具时间",
                                      value: appDateTimeFormat.dateTimeFull(doc.issuedAt),
                                    },
                                    ...(doc.trackingNo
                                      ? [
                                          {
                                            label: "快递信息",
                                            value: `${doc.expressCompany?.name ?? "快递"} ${doc.trackingNo}`,
                                          },
                                        ]
                                      : []),
                                  ]}
                                />
                                {mailLabel(doc.emailState) ? (
                                  <View className="billing-invoices__hint">
                                    {mailLabel(doc.emailState)}
                                  </View>
                                ) : null}
                                {doc.hasFile && doc.fileFormat ? (
                                  <Button
                                    variant="outline"
                                    loading={
                                      state.fileBusy === `${record.invoiceRequestId}:${doc.docKind}`
                                    }
                                    disabled={state.fileBusy !== null}
                                    onClick={() => {
                                      void model.file(record, doc.docKind);
                                    }}
                                  >
                                    {doc.docKind === "red" ? "下载红字发票" : "下载发票"}（
                                    {doc.fileFormat.toUpperCase()}）
                                  </Button>
                                ) : (
                                  <Text>票据文件暂不可用</Text>
                                )}
                                {doc.fileFormat && doc.fileFormat !== "pdf" ? (
                                  <View className="billing-invoices__hint">
                                    {doc.fileFormat.toUpperCase()}需使用支持该格式的软件查看
                                  </View>
                                ) : null}
                              </View>
                            ))}
                          </Card>
                        );
                      })
                    ) : (
                      <Empty title="暂无开票记录" />
                    )}
                    {state.records.length ? (
                      state.recordsMore ? (
                        <Button
                          variant="secondary"
                          loading={state.moreBusy}
                          onClick={() => {
                            void model.more("records");
                          }}
                        >
                          加载更多
                        </Button>
                      ) : (
                        <ListFooter status="done" />
                      )
                    ) : null}
                  </>
                )}
              </>
            )}
          </PageBody>
        </>
      )}
      <Sheet
        visible={state.form !== null}
        title="申请开票"
        description="财务审核后开具，结果将通过消息中心通知您"
        closeOnOverlayClick={!state.busy}
        onClose={model.closeForm}
        footer={
          <Button
            block
            loading={state.busy}
            onClick={withSubscribe("invoice_apply", () => {
              void model.submit();
            })}
          >
            提交申请
          </Button>
        }
      >
        {state.form ? (
          <View className="billing-invoices__form">
            <Card title={state.form.title}>
              <Text>
                付款单 {state.form.orderNo} · ¥{formatMoney(state.form.amountFen)}
              </Text>
            </Card>
            <Field label="发票类型" required>
              <View className="billing-invoices__choices">
                <Chip
                  selected={draft.invoiceType === "normal"}
                  disabled={state.busy}
                  onClick={() => model.edit({ invoiceType: "normal", medium: "electronic" })}
                >
                  普通发票
                </Chip>
                <Chip
                  selected={draft.invoiceType === "special"}
                  disabled={state.busy}
                  onClick={() => model.edit({ invoiceType: "special" })}
                >
                  增值税专用发票
                </Chip>
              </View>
            </Field>
            <Field
              label="发票介质"
              required
              hint={draft.invoiceType === "normal" ? "普通发票仅开具电子发票" : undefined}
            >
              <View className="billing-invoices__choices">
                <Chip
                  selected={draft.medium === "electronic"}
                  disabled={state.busy}
                  onClick={() => model.edit({ medium: "electronic" })}
                >
                  电子发票
                </Chip>
                <Chip
                  selected={draft.medium === "paper"}
                  disabled={state.busy || draft.invoiceType === "normal"}
                  onClick={() => model.edit({ medium: "paper" })}
                >
                  纸质发票
                </Chip>
              </View>
            </Field>
            <Field label="抬头与税号">
              <View>
                {context?.invoiceTitle.entityName}
                <View>{context?.invoiceTitle.taxNoMask}</View>
              </View>
            </Field>
            {draft.invoiceType === "special" ? (
              <>
                <Field label="地址与电话" required>
                  <Input
                    value={draft.addrTel}
                    maxlength={100}
                    disabled={state.busy}
                    onChange={(addrTel) => model.edit({ addrTel })}
                  />
                </Field>
                <Field label="开户行与账号" required>
                  <Input
                    value={draft.bankAccount}
                    maxlength={100}
                    disabled={state.busy}
                    onChange={(bankAccount) => model.edit({ bankAccount })}
                  />
                </Field>
              </>
            ) : null}
            {draft.medium === "electronic" ? (
              <Field label="接收邮箱" required>
                <Input
                  value={draft.recvEmail}
                  maxlength={100}
                  disabled={state.busy}
                  onChange={(recvEmail) => model.edit({ recvEmail })}
                  placeholder="请填写接收邮箱"
                />
              </Field>
            ) : (
              <>
                <Field label="收件人" required>
                  <Input
                    value={draft.recipientName}
                    maxlength={20}
                    disabled={state.busy}
                    onChange={(recipientName) => model.edit({ recipientName })}
                  />
                </Field>
                <Field label="收件电话" required>
                  <View className="billing-invoices__choices">
                    <Chip
                      selected={draft.phoneSource === "login"}
                      disabled={state.busy}
                      onClick={() => model.edit({ phoneSource: "login", phone: "" })}
                    >
                      登录手机号 {context?.applyDefaults.loginPhoneMask}
                    </Chip>
                    {context?.applyDefaults.contactPhoneMask ? (
                      <Chip
                        selected={draft.phoneSource === "store_contact"}
                        disabled={state.busy}
                        onClick={() => model.edit({ phoneSource: "store_contact", phone: "" })}
                      >
                        门店联系人 {context.applyDefaults.contactPhoneMask}
                      </Chip>
                    ) : null}
                    <Chip
                      selected={draft.phoneSource === "input"}
                      disabled={state.busy}
                      onClick={() => model.edit({ phoneSource: "input" })}
                    >
                      手工填写
                    </Chip>
                  </View>
                  {draft.phoneSource === "input" ? (
                    <Input
                      value={draft.phone}
                      maxlength={20}
                      disabled={state.busy}
                      onChange={(phone) => model.edit({ phone })}
                    />
                  ) : null}
                </Field>
                <Field label="邮寄地址" required>
                  <Input
                    value={draft.address}
                    maxlength={120}
                    disabled={state.busy}
                    onChange={(address) => model.edit({ address })}
                  />
                </Field>
              </>
            )}
            {state.error ? <Note>{state.error}</Note> : null}
          </View>
        ) : null}
      </Sheet>
    </View>
  );
}
