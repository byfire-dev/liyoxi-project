import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Alert, Button, Radio, Spin } from "antd";
import { useEffect, useRef, useState } from "react";

import type { AppServices } from "../../../app/services";
import { InfoList } from "../../../components/InfoList";
import { CompareTable as SharedCompareTable } from "../../../components/CompareTable";
import { readFailure } from "../../../lib/api-errors";
import type { Detail, Doc } from "./model";

export function CompareTable({
  doc,
}: {
  doc: Pick<
    Doc,
    | "docType"
    | "holderName"
    | "certNoMask"
    | "principalNameMask"
    | "validStartDate"
    | "validEndDate"
    | "isLongTerm"
    | "displayFields"
    | "fieldChecks"
  >;
}) {
  const fields = [
    { key: "name", label: "名称", value: doc.holderName ?? "—" },
    {
      key: "uscc",
      label: doc.docType === "industry_permit" ? "许可证编号" : "统一社会信用代码",
      value: doc.certNoMask ?? "—",
    },
    { key: "principal", label: "负责人", value: doc.principalNameMask ?? "—" },
    { key: "validFrom", label: "有效期起", value: doc.validStartDate ?? "—" },
    {
      key: "validTo",
      label: "有效期至",
      value: doc.isLongTerm ? "长期" : (doc.validEndDate ?? "—"),
    },
    ...doc.displayFields,
  ];
  return (
    <SharedCompareTable
      ariaLabel="证照人工核对"
      rows={fields.map((field) => {
        const check = doc.fieldChecks.find((item) => item.field === field.key);
        return {
          key: field.key,
          label: field.label,
          value: field.value || "—",
          result: check
            ? ((
                {
                  pass: "通过",
                  fail: "异常",
                  warn: "需留意",
                  manual: "人工核对",
                  info: "—",
                } as Record<string, string>
              )[String(check.result)] ?? "人工核对")
            : "人工核对",
        };
      })}
    />
  );
}
function Original({ services, doc }: { services: AppServices; doc: Doc }) {
  const busy = useRef(false),
    controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const [url, setUrl] = useState<string>(),
    [loading, setLoading] = useState(false),
    [error, setError] = useState<string>();
  return (
    <div className="lyx-review-original">
      {url ? (
        <img
          src={url}
          alt={`${doc.permitType?.name ?? "营业执照"}原图`}
          onError={() => {
            setUrl(undefined);
            setError("原图地址已失效，请重新查看");
          }}
        />
      ) : (
        <div className="lyx-review-original__placeholder">
          证照原图
          <br />
          点击后签发 5 分钟查看地址
        </div>
      )}
      <Button
        aria-label="查看原图"
        loading={loading}
        onClick={async () => {
          if (busy.current) return;
          busy.current = true;
          const active = new AbortController();
          controller.current = active;
          setLoading(true);
          setError(undefined);
          try {
            const { data, response } = await services.api.client.POST(
              "/api/v1/admin/files/{fileId}/download-urls",
              {
                params: { path: { fileId: doc.fileId } },
                body: { disposition: "inline", purpose: "资质审核人工核对" },
                signal: active.signal,
              },
            );
            if (active.signal.aborted) return;
            if (!data) setError((await readFailure(response)).message);
            else setUrl(data.data.url);
          } catch {
            if (!active.signal.aborted) setError("原图没有加载成功，请重试");
          } finally {
            busy.current = false;
            if (!active.signal.aborted) setLoading(false);
          }
        }}
      >
        查看原图
      </Button>
      {error ? <span role="alert">{error}</span> : null}
    </div>
  );
}
export function ReviewDetails({ services, detail }: { services: AppServices; detail: Detail }) {
  const [selected, setSelected] = useState(detail.docs[0]?.qualificationDocId);
  const doc = detail.docs.find((item) => item.qualificationDocId === selected) ?? detail.docs[0];
  const contact = [detail.contact?.name, detail.contact?.phoneMask].filter(Boolean).join(" ");
  return (
    <div className="lyx-review-body">
      <InfoList
        labelWidth={84}
        items={[
          { label: "主体", value: detail.entity.name ?? doc?.holderName ?? "尚未认证" },
          {
            label: "行业品类",
            value:
              [detail.store.industry?.name, detail.store.category?.name]
                .filter(Boolean)
                .join(" / ") || "—",
          },
          {
            label: "门店区域",
            value:
              [
                detail.store.region.province?.name,
                detail.store.region.city?.name,
                detail.store.region.district?.name,
              ]
                .filter(Boolean)
                .join(" ") || "—",
          },
          { label: "联系人", value: contact || "—" },
          { label: "提交时间", value: appDateTimeFormat.dateTime(detail.approval.submittedAt) },
          {
            label: "档案",
            value: `完整度 ${detail.profileDigest.completenessPct}% · 门头 ${detail.profileDigest.doorCount} 张 · 店内 ${detail.profileDigest.interiorCount} 张 · 服务 ${detail.profileDigest.serviceItemCount} 项`,
          },
        ]}
      />
      <Alert
        type={detail.checkSummary?.fail ? "warning" : "info"}
        title={
          detail.checkSummary?.fail
            ? `系统发现 ${detail.checkSummary.fail} 项异常，请核对后处理`
            : "证照未识别，请手动核对已提交资料与原图"
        }
      />
      {detail.duplicateUscc.isVerifiedElsewhere ||
      detail.duplicateUscc.inReviewElsewhereCount > 0 ? (
        <Alert type="warning" title="该信用代码在其他主体已认证或在审，请核对主体关系" />
      ) : null}
      {detail.docs.length > 1 ? (
        <Radio.Group
          aria-label="证照"
          value={doc?.qualificationDocId}
          onChange={(event) => setSelected(String(event.target.value))}
          options={detail.docs.map((item) => ({
            value: item.qualificationDocId,
            label:
              item.permitType?.name ??
              (item.docType === "branch_license" ? "分支机构执照" : "营业执照"),
          }))}
          optionType="button"
        />
      ) : (
        <h3 className="lyx-section-title">{doc?.permitType?.name ?? "营业执照"}</h3>
      )}
      {doc ? (
        <div className="lyx-review-doc">
          <Original key={doc.qualificationDocId} services={services} doc={doc} />
          <div>
            <CompareTable doc={doc} />
            <p className="lyx-review-note">
              敏感号码已脱敏。未识别资料须人工核对；本阶段不提供修正或放行。
            </p>
          </div>
        </div>
      ) : (
        <Spin />
      )}
      {detail.relatedOrders.map((order) => (
        <p key={order.id}>
          关联{order.kind === "payment_order" ? "付款单" : "订购单"}：{order.no} · {order.title} ·{" "}
          {order.statusText}
        </p>
      ))}
      {detail.approval.decisionNote ? (
        <Alert
          type={detail.outcome === "rejected" ? "error" : "success"}
          title={detail.approval.decisionNote}
        />
      ) : null}
    </div>
  );
}
