import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Picker, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow, usePullDownRefresh, useReachBottom } from "@tarojs/taro";
import { formatSignedPoints } from "@liyoxi/shared/format/money";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Empty } from "@/components/Empty";
import { InfoTag } from "@/components/InfoTag";
import { ListFooter } from "@/components/ListFooter";
import { LoadError } from "@/components/LoadError";
import { PageBody } from "@/components/PageBody";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag, merchantStatusByEnum } from "@/components/StatusTag";
import { Tabs } from "@/components/Tabs";
import { TextButton } from "@/components/TextButton";
import { useAccount } from "@/lib/account-runtime";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { messageScope } from "@/stores/messages-scope";
import { LEDGER_TABS, ledgerMonth } from "./model";
import { currentLedgerContext, ledgerModel } from "./runtime";
import "./index.scss";

export default function LedgerPage() {
  const me = useAccount().me;
  const token = useSessionStore((s) => s.accessToken);
  const { currentStoreId: storeId, contextRev } = useContextStore();
  return <LedgerContent key={messageScope({ me, token, storeId, contextRev })} />;
}
function LedgerContent() {
  const model = useMemo(() => ledgerModel(), []);
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  useEffect(() => {
    void model.show();
    return () => model.hide();
  }, [model]);
  useDidShow(() => {
    void model.show();
  });
  useDidHide(() => model.hide());
  useReachBottom(() => {
    void model.more();
  });
  usePullDownRefresh(() => {
    const key = currentLedgerContext().key;
    void model.refresh().finally(() => {
      if (model.isActive() && key === currentLedgerContext().key) void Taro.stopPullDownRefresh();
    });
  });
  const page = state.page;
  return (
    <View className="billing-ledger" id={!state.loading ? "ledger-ready" : undefined}>
      {state.restricted ? (
        <PageBody>
          <Empty title="当前身份无法查看积分流水" description="请使用有权限的老板账号查看。" />
        </PageBody>
      ) : (
        <>
          <Tabs
            items={LEDGER_TABS}
            value={state.filter.tab}
            onChange={(tab) => {
              void model.filter(tab);
            }}
          />
          <PageBody>
            <View className="billing-ledger__filters">
              <Picker
                mode="date"
                fields="month"
                value={state.filter.month}
                end={ledgerMonth(new Date())}
                onChange={(e) => {
                  void model.filter(state.filter.tab, e.detail.value.slice(0, 7));
                }}
              >
                <TextButton>{state.filter.month} · 选择月份</TextButton>
              </Picker>
              <TextButton
                onClick={() => {
                  void model.clear();
                }}
              >
                清除筛选
              </TextButton>
              <TextButton
                onClick={() => {
                  void model.refresh();
                }}
              >
                刷新
              </TextButton>
            </View>
            {state.loading ? (
              <Skeleton cards={3} />
            ) : state.error ? (
              <LoadError
                message={state.error}
                onRetry={() => {
                  void model.refresh();
                }}
              />
            ) : page ? (
              <>
                <View className="billing-ledger__month">{page.month} 积分流水</View>
                {page.items.length ? (
                  <Card variant="list">
                    {page.items.map((row) => {
                      const hold = row.holdStatus
                        ? merchantStatusByEnum("point_hold.status", row.holdStatus)
                        : null;
                      return (
                        <View className="billing-ledger__row" key={row.rowKey}>
                          <View className="billing-ledger__heading">
                            <Text className="billing-ledger__title">{row.title}</Text>
                            <Text
                              className={`billing-ledger__points billing-ledger__points--${row.category}`}
                            >
                              {formatSignedPoints(row.deltaPoints)}
                            </Text>
                          </View>
                          <View className="billing-ledger__meta">
                            {row.lotKind !== null ? (
                              <InfoTag>{row.lotKind === "plan" ? "套餐积分" : "加购积分"}</InfoTag>
                            ) : null}
                            {hold ? <StatusTag tone={hold.tone}>{hold.label}</StatusTag> : null}
                            <Text>{appDateTimeFormat.dateTime(row.occurredAt)}</Text>
                            {row.itemCount > 1 ? <Text>共 {row.itemCount} 项</Text> : null}
                          </View>
                          {row.remark !== null ? (
                            <View className="billing-ledger__remark">{row.remark}</View>
                          ) : row.storeName !== null || row.refNo !== null ? (
                            <View className="billing-ledger__remark">
                              {[row.storeName, row.refNo]
                                .filter((value) => value !== null)
                                .join(" · ")}
                            </View>
                          ) : null}
                          {row.formula !== null ? (
                            <View className="billing-ledger__remark">{row.formula}</View>
                          ) : null}
                        </View>
                      );
                    })}
                  </Card>
                ) : (
                  <Empty title="本月没有此类记录" description="可切换类型或月份查看其他流水。" />
                )}
                {state.moreError ? (
                  <LoadError
                    message={state.moreError}
                    onRetry={() => {
                      void model.more();
                    }}
                  />
                ) : null}
                {page.hasMore ? (
                  <Button
                    variant="secondary"
                    loading={state.moreBusy}
                    onClick={() => {
                      void model.more();
                    }}
                  >
                    加载更多
                  </Button>
                ) : page.prevMonth ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      void model.previous();
                    }}
                  >
                    查看 {page.prevMonth} 记录
                  </Button>
                ) : page.items.length ? (
                  <ListFooter
                    status="done"
                    doneText={
                      page.firstEntryAt === null
                        ? "已显示全部记录"
                        : `已显示全部记录（${appDateTimeFormat.date(page.firstEntryAt)} 首条记录）`
                    }
                  />
                ) : null}
              </>
            ) : null}
          </PageBody>
        </>
      )}
    </View>
  );
}
