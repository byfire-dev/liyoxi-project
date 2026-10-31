import { useEffect, useRef, useState } from "react";
import { RichText, View } from "@tarojs/components";
import Taro, {
  useDidHide,
  useDidShow,
  usePullDownRefresh,
  useReachBottom,
  useRouter,
} from "@tarojs/taro";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { DescList } from "@/components/DescList";
import { Empty } from "@/components/Empty";
import { ListFooter } from "@/components/ListFooter";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { Sheet } from "@/components/Sheet";
import { Skeleton } from "@/components/Skeleton";
import { TextButton } from "@/components/TextButton";
import { account, useAccount } from "@/lib/account-runtime";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { createContractsApi } from "./api";
import type { SignedItem } from "./api";
import { contractContext, createContractsModel, sceneLabel } from "./model";
import { contractsDocument, contractsRequest } from "./runtime";
import { createLicenseApi } from "./license-api";
import { createLicenseModel, licenseContext } from "./license-model";
import { LicenseSection } from "./license-section";
import "./index.scss";

function contextInput() {
  const store = useContextStore.getState();
  return {
    token: useSessionStore.getState().accessToken,
    storeId: store.currentStoreId,
    contextRev: store.contextRev,
    me: account.snapshot().me,
  };
}
const context = () => contractContext(contextInput());
export default function ContractsPage() {
  const orderId = useRouter().params.orderId;
  const me = useAccount().me;
  const storeId = useContextStore((value) => value.currentStoreId);
  const contextRev = useContextStore((value) => value.contextRev);
  const token = useSessionStore((value) => value.accessToken);
  const key = contractContext({ token, storeId, contextRev, me }).key;
  return <ContractsContent key={JSON.stringify([key, orderId ?? null])} orderId={orderId} />;
}

function ContractCard({
  item,
  records,
  onRead,
}: {
  item: SignedItem;
  records: Array<{ label: string; rows: Array<{ label: string; value: string }> }>;
  onRead(): void;
}) {
  return (
    <Card title={item.name} eyebrow={item.consentedVersion.versionLabel}>
      <View className="billing-contracts__version">
        {item.currentVersionId !== item.consentedVersion.agreementVersionId
          ? "已签历史版本"
          : "已签版本"}
        {item.isCurrentVersionConsented ? "" : " · 当前版本尚未确认"}
      </View>
      {records.map((record) => (
        <View className="billing-contracts__record" key={record.label}>
          <View className="billing-contracts__record-title">{record.label}</View>
          <DescList items={record.rows} labelWidth="lg" />
        </View>
      ))}
      <TextButton arrow onClick={onRead}>
        查看所签版本
      </TextButton>
    </Card>
  );
}
const rows = (record: SignedItem["firstConsent"]) => [
  { label: "确认时间", value: appDateTimeFormat.dateTimeFull(record.consentedAt) },
  { label: "确认场景", value: sceneLabel(record.scene) },
  { label: "版本", value: record.versionLabel },
  { label: "确认编号", value: record.consentNo },
];

function ContractsContent({ orderId }: { orderId?: string }) {
  const [, render] = useState(0);
  const [model] = useState(() =>
    createContractsModel({
      api: createContractsApi(contractsRequest),
      document: contractsDocument(),
      context,
      now: () => Date.now(),
      changed: () => render((value) => value + 1),
    }),
  );
  const [licenseModel] = useState(() =>
    createLicenseModel({
      api: createLicenseApi(contractsRequest),
      document: contractsDocument(),
      context: () => ({ ...licenseContext(contextInput()), orderId }),
      now: () => Date.now(),
      changed: () => render((value) => value + 1),
    }),
  );
  const visible = useRef(true),
    started = useRef(false);
  useEffect(() => {
    let mounted = true;
    void account
      .start()
      .then(() => {
        if (!mounted) return;
        started.current = true;
        if (visible.current) {
          void model.show();
          void licenseModel.show();
        }
      })
      .catch(() => {
        if (mounted && visible.current) {
          void model.show();
          void licenseModel.show();
        }
      });
    return () => {
      mounted = false;
      model.hide();
      licenseModel.hide();
    };
  }, [model, licenseModel]);
  useDidShow(() => {
    visible.current = true;
    if (started.current) {
      void model.show();
      void licenseModel.show();
    }
  });
  useDidHide(() => {
    visible.current = false;
    model.hide();
    licenseModel.hide();
  });
  usePullDownRefresh(() => {
    void Promise.all([model.show(), licenseModel.show()]).finally(() => Taro.stopPullDownRefresh());
  });
  useReachBottom(() => {
    void model.load(true);
    void licenseModel.load(true);
  });
  const state = model.snapshot(),
    page = state.page;
  return (
    <View className="billing-contracts" id={page ? "contracts-ready" : undefined}>
      <PageBody>
        <LicenseSection
          model={licenseModel}
          onRead={(item) => {
            model.closeDetail();
            void licenseModel.read(item);
          }}
        />
        <View className="billing-contracts__section-title">已签协议</View>
        <Note>
          {page?.viewerRole === "clerk"
            ? "仅展示本人确认的用户协议"
            : "展示本主体的协议确认记录，包含前任老板的确认记录"}
          。查看正文不会再次确认协议。
        </Note>
        {state.total !== null ? (
          <View className="billing-contracts__count">已签协议 {state.total} 份</View>
        ) : null}
        {state.error ? (
          <LoadError
            message={state.error}
            onRetry={() => {
              void model.show();
            }}
          />
        ) : null}
        {!page && state.loading ? <Skeleton cards={2} /> : null}
        {page && !page.items.length ? <Empty title="暂无已签协议" /> : null}
        {page?.viewerRole === "owner"
          ? page.items.map((item) => (
              <ContractCard
                key={item.agreementKey}
                item={item}
                onRead={() => {
                  licenseModel.closeDetail();
                  void model.read(item);
                }}
                records={[
                  { label: "首次确认", record: item.firstConsent },
                  { label: "最近确认", record: item.latestConsent },
                ].map(({ label, record }) => ({
                  label,
                  rows: [
                    ...rows(record),
                    ...(record.bizNo ? [{ label: "关联单号", value: record.bizNo }] : []),
                    ...(record.bizTitle ? [{ label: "单据内容", value: record.bizTitle }] : []),
                  ],
                }))}
              />
            ))
          : page?.viewerRole === "clerk"
            ? page.items.map((item) => (
                <ContractCard
                  key={item.agreementKey}
                  item={item}
                  onRead={() => {
                    licenseModel.closeDetail();
                    void model.read(item);
                  }}
                  records={[
                    { label: "首次确认", rows: rows(item.firstConsent) },
                    { label: "最近确认", rows: rows(item.latestConsent) },
                  ]}
                />
              ))
            : null}
        {page ? (
          page.hasMore ? (
            <Button
              variant="secondary"
              block
              loading={state.loading}
              onClick={() => {
                void model.load(true);
              }}
            >
              加载更多协议
            </Button>
          ) : (
            <ListFooter status="done" />
          )
        ) : null}
      </PageBody>
      <Sheet
        visible={state.selected !== null}
        title={state.selected?.name ?? "所签协议"}
        description={
          state.selected
            ? `${state.selected.consentedVersion.versionLabel} · 只读查看所签版本`
            : undefined
        }
        onClose={() => model.closeDetail()}
        footer={
          <Button
            block
            loading={state.documentBusy}
            onClick={() => {
              void model.openPdf();
            }}
          >
            打开所签版本 PDF
          </Button>
        }
      >
        {state.selected?.currentVersionId !==
        state.selected?.consentedVersion.agreementVersionId ? (
          <Note>这是已确认的历史版本，正文和 PDF 均保留该版本。</Note>
        ) : null}
        {state.detailError ? (
          <View className="billing-contracts__error">
            {state.detailError}
            <TextButton
              onClick={() => {
                if (state.selected) void model.read(state.selected);
              }}
            >
              重新加载正文
            </TextButton>
          </View>
        ) : null}
        {state.bodyLoading ? (
          <Skeleton cards={1} rows={4} />
        ) : state.body ? (
          <>
            <View className="billing-contracts__effective">
              {appDateTimeFormat.dateTimeFull(state.body.effectiveAt)} 生效
            </View>
            {state.body.summary ? (
              <View className="billing-contracts__summary">{state.body.summary}</View>
            ) : null}
            {state.body.contentHtml ? (
              <RichText nodes={state.body.contentHtml} />
            ) : (
              <Empty title="正文准备中" />
            )}
          </>
        ) : null}
      </Sheet>
    </View>
  );
}
