import { View } from "@tarojs/components";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { DescList } from "@/components/DescList";
import { Empty } from "@/components/Empty";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { Sheet } from "@/components/Sheet";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag, merchantStatusByState } from "@/components/StatusTag";
import { TextButton } from "@/components/TextButton";
import type { LicenseCard } from "./license-api";
import type { LicenseModel } from "./license-model";

const statusNames = {
  pending_effective: "待生效",
  effective: "生效中",
  expired: "已失效",
  voided: "已作废",
} as const;
const reasonNames = {
  initial: "首次出件",
  go_live: "上线生效",
  period_changed: "授权期限变化",
  correction: "资料更正",
  resign: "重新签署",
} as const;
const permitNames: Readonly<Record<string, string>> = {
  license_no: "许可证号",
  approval_no: "备案审批号",
  program_no: "节目编号",
};
const period = (item: LicenseCard) =>
  `${item.periodStartDate ?? "自上线首日起"} 至 ${item.periodEndDate}`;
const platform = (item: LicenseCard) => (item.platform === "douyin" ? "抖音" : "视频号");
function verificationCode(url: string) {
  // The API supplies the immutable verification URL. Never construct a portal route or file URL.
  const value = /[?&]code=([^&#]+)/.exec(url)?.[1];
  try {
    return value ? decodeURIComponent(value) : "见 PDF 验真二维码";
  } catch {
    return "见 PDF 验真二维码";
  }
}
function RenderNotice({ item }: { item: LicenseCard }) {
  if (item.renderIssue)
    return (
      <Note>
        因缺少字形暂停出件：
        {item.renderIssue.missing
          .map((entry) => `${entry.character}（${entry.codePoint}）`)
          .join("、")}
        {item.renderIssue.truncated ? "等" : ""}。请联系服务经理修正资料或字体后重新获取。
      </Note>
    );
  if (item.isRendering)
    return (
      <Note>
        {item.canDownload
          ? "新版尚未就绪，当前仍可查看已出件版本。"
          : "PDF尚未就绪，请稍后重新加载授权书。"}
      </Note>
    );
  if (!item.canDownload) return <Note>当前 PDF 暂不可用，历史已出件版本仍可查看。</Note>;
  return null;
}

export function LicenseSection({
  model,
  onRead,
}: {
  model: LicenseModel;
  onRead(item: LicenseCard): void;
}) {
  const state = model.snapshot(),
    detail = state.detail,
    preview = detail?.preview;
  const pendingPeriod =
    preview &&
    detail &&
    (preview.period.startDate !== detail.periodStartDate ||
      preview.period.endDate !== detail.periodEndDate);
  const ready = state.page !== null || state.restricted || state.error !== null;
  return (
    <View className="billing-licenses" id={ready ? "licenses-ready" : undefined}>
      <View className="billing-contracts__section-title">
        定制内容授权书{state.summary ? ` · ${state.summary.all}` : ""}
      </View>
      {state.restricted ? (
        <Note>仅门店老板可查看定制内容授权书。已签协议仍可在下方查看。</Note>
      ) : (
        <>
          {state.summary ? (
            <View className="billing-contracts__version">
              生效中 {state.summary.effective} 份 · 按当前门店展示，包含已作废记录
            </View>
          ) : null}
          <TextButton
            onClick={() => {
              void model.show();
            }}
          >
            重新加载授权书
          </TextButton>
          {state.error ? (
            <LoadError
              message={state.error}
              onRetry={() => {
                void model.show();
              }}
            />
          ) : null}
          {!state.page && state.loading ? <Skeleton cards={2} /> : null}
          {state.page && state.page.items.length === 0 ? (
            <Empty title="暂无定制内容授权书" description="授权书生成后将在这里展示" />
          ) : null}
          {state.page?.items.map((item) => {
            const name = statusNames[item.displayStatus];
            const status = merchantStatusByState(
              "publication",
              item.displayStatus === "voided" ? "已停用" : name,
            );
            return (
              <Card
                key={item.licenseLetterId}
                title={`《${item.dramaTitle}》`}
                eyebrow={item.letterNo}
              >
                {status ? (
                  <StatusTag tone={status.tone} plain>
                    {name}
                  </StatusTag>
                ) : null}
                <DescList
                  items={[
                    { label: "发布账号", value: `${platform(item)} · ${item.accountName}` },
                    { label: "规格", value: `整部 ${item.episodeCount} 集` },
                    { label: "授权期限", value: period(item) },
                    { label: "订单号", value: item.orderNo },
                    { label: "生成时间", value: appDateTimeFormat.dateTimeFull(item.createdAt) },
                    {
                      label: "当前版次",
                      value: item.currentRevNo === null ? "尚未出件" : `第 ${item.currentRevNo} 版`,
                    },
                  ]}
                  labelWidth="lg"
                />
                <RenderNotice item={item} />
                <TextButton arrow onClick={() => onRead(item)}>
                  查看授权详情
                </TextButton>
              </Card>
            );
          })}
          {state.page?.hasMore ? (
            <Button
              variant="secondary"
              block
              loading={state.loading}
              onClick={() => {
                void model.load(true);
              }}
            >
              加载更多授权书
            </Button>
          ) : null}
        </>
      )}
      <Sheet
        visible={state.selected !== null}
        title="定制内容授权书"
        description={
          state.selected
            ? `${state.selected.dramaTitle} · ${state.selected.accountName}`
            : undefined
        }
        onClose={() => model.closeDetail()}
        footer={
          <Button
            block
            loading={state.documentBusy}
            disabled={!detail?.canDownload || state.detailLoading}
            onClick={() => {
              void model.openPdf();
            }}
          >
            打开当前版 PDF
          </Button>
        }
      >
        {state.detailError ? (
          <View className="billing-contracts__error">
            {state.detailError}
            <TextButton
              onClick={() => {
                if (state.selected) void model.read(state.selected);
              }}
            >
              重新加载授权详情
            </TextButton>
          </View>
        ) : null}
        {state.detailLoading ? (
          <Skeleton cards={1} rows={4} />
        ) : detail ? (
          <>
            <RenderNotice item={detail} />
            <DescList
              items={[
                { label: "授权书编号", value: detail.letterNo },
                { label: "授权状态", value: statusNames[detail.displayStatus] },
                { label: "最新授权期限", value: period(detail) },
                { label: "发布账号", value: `${platform(detail)} · ${detail.accountName}` },
              ]}
              labelWidth="lg"
            />
            {preview ? (
              <>
                <View className="billing-contracts__record-title">
                  当前已出件版本 · 第 {preview.revNo} 版
                </View>
                {pendingPeriod ? (
                  <Note>
                    最新期限尚未出件，当前 PDF 仍为第 {preview.revNo} 版，仅包含下方的本版授权期限。
                  </Note>
                ) : null}
                <DescList
                  items={[
                    {
                      label: "本版授权期限",
                      value: `${preview.period.startDate ?? preview.period.startText} 至 ${preview.period.endDate}`,
                    },
                    {
                      label: "授权方",
                      value: `${preview.licensorName}（${preview.licensorCreditCodeMask}）`,
                    },
                    {
                      label: "被授权方",
                      value: `${preview.licenseeName}（${preview.licenseeCreditCodeMask}）`,
                    },
                    { label: "下单门店", value: preview.storeName },
                    {
                      label: "许可信息",
                      value: preview.permits
                        .map(
                          (permit) =>
                            `${permitNames[permit.kind] ?? "许可编号"} · ${permit.number}`,
                        )
                        .join("；"),
                    },
                    {
                      label: "发布账号",
                      value: `${preview.account.name} · ${preview.account.accountId}`,
                    },
                    { label: "授权地域", value: preview.period.territory },
                    {
                      label: "确认记录",
                      value: `${preview.consent.agreementName} · ${preview.consent.consentNo}`,
                    },
                    { label: "验真码", value: verificationCode(preview.verifyUrl) },
                    {
                      label: "签署方式",
                      value: preview.signMode === "stamp" ? "图片章" : "数字证书",
                    },
                  ]}
                  labelWidth="lg"
                />
                {preview.clauses.map((clause) => (
                  <View className="billing-contracts__summary" key={clause.key}>
                    <View className="billing-contracts__record-title">{clause.title}</View>
                    <View>{clause.text}</View>
                  </View>
                ))}
              </>
            ) : (
              <Note>
                {detail.displayStatus === "voided"
                  ? "此授权书已作废，历史已出件版次保留供追溯。"
                  : "首版 PDF 尚未出件，授权详情以当前事实展示；请稍后重新获取。"}
              </Note>
            )}
            {detail.revisions.length ? (
              <View className="billing-contracts__history">
                <View className="billing-contracts__record-title">版次记录</View>
                {detail.revisions.map((revision) => (
                  <View className="billing-contracts__record" key={revision.revNo}>
                    <View>
                      第 {revision.revNo} 版 · {reasonNames[revision.reason]}
                    </View>
                    <View className="billing-contracts__version">
                      {appDateTimeFormat.dateTimeFull(revision.issuedAt)} 出件
                    </View>
                    {revision.revNo !== detail.currentRevNo ? (
                      <TextButton
                        disabled={state.documentBusy}
                        onClick={() => {
                          void model.openPdf(revision.revNo);
                        }}
                      >
                        打开第 {revision.revNo} 版 PDF
                      </TextButton>
                    ) : null}
                  </View>
                ))}
              </View>
            ) : null}
          </>
        ) : null}
      </Sheet>
    </View>
  );
}
