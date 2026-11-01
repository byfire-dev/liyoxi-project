import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { formatInteger } from "@liyoxi/shared/format/money";
import { Button } from "@/components/Button";
import { Checkbox } from "@/components/Checkbox";
import { Chip } from "@/components/Chip";
import { DescList } from "@/components/DescList";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { Sheet } from "@/components/Sheet";
import { TextArea } from "@/components/TextArea";
import { TextButton } from "@/components/TextButton";
import { adApi, type AdKind, type AdQuote } from "./api";
import { quoteIdentity } from "./model";
import { useAdResource } from "./resource";
import { AdReferences } from "./references";

export function AdCreateForm({ close, done }: { close(): void; done(id: string): void }) {
  const [choice, setChoice] = useState<{ type?: AdKind; durationSec?: number }>({}),
    [codes, setCodes] = useState<string[]>([]),
    [copy, setCopy] = useState(""),
    [remark, setRemark] = useState(""),
    [refs, setRefs] = useState<string[]>([]),
    [agreed, setAgreed] = useState<string | null>(null);
  const latest = useRef(choice);
  useLayoutEffect(() => {
    latest.current = choice;
  }, [choice]);
  const r = useAdResource(async () => {
    const [quote, dictionary] = await Promise.all([adApi.quote(latest.current), adApi.promo()]);
    return {
      quote,
      promo:
        dictionary.items
          .find((item) => item.typeKey === "ad_promo_point")
          ?.items.filter((item) => item.isSelectable) ?? [],
    };
  });
  const q = r.data?.quote;
  const previous = useRef<AdQuote | null>(null);
  useEffect(() => {
    if (q && previous.current && quoteIdentity(q) !== quoteIdentity(previous.current))
      setAgreed(null);
    if (q) previous.current = q;
  }, [q]);
  const choose = (value: typeof choice) => {
    latest.current = value;
    setChoice(value);
    setAgreed(null);
    r.refresh();
  };
  const allowed =
    q &&
    choice.type &&
    choice.durationSec &&
    q.chargePoints !== null &&
    q.blockers.length === 0 &&
    codes.length > 0 &&
    agreed === q.agreement.agreementVersionId;
  return (
    <Sheet
      visible
      title="制作广告需求"
      onClose={() => {
        if (!r.busy) close();
      }}
      closeOnOverlayClick={!r.busy}
      footer={
        <Button
          block
          loading={r.busy}
          disabled={!allowed || r.loading}
          onClick={() =>
            r.run(async (current) => {
              if (!q || !choice.type || !choice.durationSec) return;
              const fresh = await adApi.quote(choice);
              if (!current()) return;
              if (quoteIdentity(fresh) !== quoteIdentity(q)) {
                setAgreed(null);
                r.replace({ ...r.data!, quote: fresh }, current);
                throw new Error("报价或协议已更新，请重新核对并同意");
              }
              if (!allowed || fresh.blockers.length || fresh.chargePoints === null) return;
              const body = {
                type: choice.type,
                durationSec: choice.durationSec,
                promoPointCodes: codes,
                ...(copy.trim() ? { copy: copy.trim() } : {}),
                ...(remark.trim() ? { remark: remark.trim() } : {}),
                ...(refs.length ? { referenceStoreAssetIds: refs } : {}),
                expectChargePoints: fresh.chargePoints,
                agreementVersionId: fresh.agreement.agreementVersionId,
                isAgreementChecked: true,
              };
              const result = await adApi.create(body, r.intent("adCreate", body));
              if (!current()) return;
              const actual = await adApi.get(result.adId);
              if (current()) done(actual.adId);
            }, "ad_submit")
          }
        >
          提交需求
          {q?.chargePoints !== null && q?.chargePoints !== undefined
            ? ` · 冻结${formatInteger(q.chargePoints)}积分`
            : ""}
        </Button>
      }
    >
      {r.error ? <LoadError message={r.error} onRetry={r.refresh} /> : null}
      {q ? (
        <>
          <Note>提交时冻结积分，指派制作后扣减；报价与免费修改次数以服务端为准。</Note>
          <View className="ad-options">
            {q.typeOptions
              .filter((option) => option.type === "opening" || option.type === "ending")
              .map((option) => (
                <Chip
                  key={option.type}
                  selected={choice.type === option.type}
                  disabled={r.busy || r.loading}
                  onClick={() => choose({ type: option.type as AdKind })}
                >
                  {option.type === "opening" ? "片头" : "片尾"}
                </Chip>
              ))}
          </View>
          <View className="ad-options">
            {q.typeOptions
              .find((option) => option.type === choice.type)
              ?.durationOptions.map((seconds) => (
                <Chip
                  key={seconds}
                  selected={choice.durationSec === seconds}
                  disabled={r.busy || r.loading}
                  onClick={() => choose({ ...choice, durationSec: seconds })}
                >
                  {seconds}秒
                </Chip>
              ))}
          </View>
          <DescList
            items={[
              { label: "套餐", value: q.planName ?? "暂无生效套餐" },
              {
                label: "冻结积分",
                value:
                  q.chargePoints === null ? "请先选择类型与时长" : formatInteger(q.chargePoints),
              },
              { label: "可用积分", value: formatInteger(q.availablePoints) },
              { label: "免费修改", value: `${q.freeRevisions}次` },
            ]}
          />
          {q.blockers.map((item) => (
            <Note key={item.code} tone="warning">
              {item.message}
            </Note>
          ))}
          <Note>推广重点（至少选择1项，最多5项）</Note>
          <View className="ad-options">
            {r.data?.promo.map((item) => (
              <Chip
                key={item.code}
                selected={codes.includes(item.code)}
                disabled={r.busy || (codes.length >= 5 && !codes.includes(item.code))}
                onClick={() => {
                  setAgreed(null);
                  setCodes((values) =>
                    values.includes(item.code)
                      ? values.filter((code) => code !== item.code)
                      : [...values, item.code],
                  );
                }}
              >
                {item.name}
              </Chip>
            ))}
          </View>
          <TextArea
            value={copy}
            onChange={(value) => {
              setAgreed(null);
              setCopy(value);
            }}
            maxLength={50}
            disabled={r.busy}
            placeholder="广告文案（选填，最多50字）"
          />
          <TextArea
            value={remark}
            onChange={(value) => {
              setAgreed(null);
              setRemark(value);
            }}
            maxLength={200}
            disabled={r.busy}
            placeholder="制作要求（选填，最多200字）"
          />
          <AdReferences
            selected={refs}
            change={(value) => {
              setAgreed(null);
              setRefs(value);
            }}
            disabled={r.busy}
          />
          <TextButton
            onClick={() =>
              void Taro.navigateTo({
                url: `/pages/agreement/index?id=${encodeURIComponent(q.agreement.agreementVersionId)}`,
              })
            }
          >
            《{q.agreement.name}》 · {q.agreement.versionLabel}
          </TextButton>
          <Checkbox
            checked={agreed === q.agreement.agreementVersionId}
            disabled={r.busy || r.loading}
            onChange={(value) => setAgreed(value ? q.agreement.agreementVersionId : null)}
          >
            我已阅读并同意广告制作协议
          </Checkbox>
        </>
      ) : (
        <Note>正在取得广告报价…</Note>
      )}
    </Sheet>
  );
}
