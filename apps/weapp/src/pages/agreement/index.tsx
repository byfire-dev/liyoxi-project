import { useState } from "react";
import { RichText, View } from "@tarojs/components";
import { useDidHide, useDidShow, useLoad } from "@tarojs/taro";

import { Empty } from "@/components/Empty";
import { LoadError } from "@/components/LoadError";
import { Skeleton } from "@/components/Skeleton";
import type { Data } from "@/lib/account-api";
import { accountError } from "@/lib/account-controller";
import { agreementEffectiveDate } from "@/lib/account-date";
import { account } from "@/lib/account-runtime";

import "./index.scss";

export default function AgreementPage() {
  const [id, setId] = useState("");
  const [data, setData] = useState<Data<"m.agreementVersion.get"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = (versionId: string) => {
    setError(null);
    void account
      .agreement(versionId)
      .then(setData)
      .catch((failure) => setError(accountError(failure)));
  };
  useDidShow(() => account.showAgreement(true));
  useDidHide(() => account.showAgreement(false));
  useLoad((options) => {
    const value = options.id;
    if (value) {
      setId(value);
      load(value);
    } else setError("未找到协议，请返回后重试");
  });
  return (
    <View className="account-agreement" id={data ? "account-ready" : undefined}>
      {error ? (
        <LoadError message={error} onRetry={() => load(id)} />
      ) : data ? (
        <>
          <View className="account-agreement__title">{data.name}</View>
          <View className="account-agreement__version">
            {data.versionLabel} · {agreementEffectiveDate(data.effectiveAt)} 生效
          </View>
          {data.summary ? <View className="account-agreement__summary">{data.summary}</View> : null}
          {data.contentHtml ? <RichText nodes={data.contentHtml} /> : <Empty title="正文准备中" />}
        </>
      ) : (
        <Skeleton cards={2} rows={4} />
      )}
    </View>
  );
}
