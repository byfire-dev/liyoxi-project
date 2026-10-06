import { View } from "@tarojs/components";
import Taro from "@tarojs/taro";

import { Button } from "@/components/Button";
import { Note } from "@/components/Note";
import { Sheet } from "@/components/Sheet";
import { TextButton } from "@/components/TextButton";
import { agreementEffectiveDate } from "@/lib/account-date";
import { account, useAccount } from "@/lib/account-runtime";
import { useSessionStore } from "@/stores/session";

import "./index.scss";

export function ConsentPopup() {
  const state = useAccount();
  const token = useSessionStore((value) => value.accessToken);
  return (
    <Sheet
      visible={Boolean(token && state.consent.length && !state.agreementVisible)}
      title="请确认更新后的协议"
      description="继续使用前，请阅读以下协议与变更摘要"
      closeLabel="不同意并退出"
      closeOnOverlayClick={false}
      onClose={() => {
        void account.refuseConsent();
      }}
      footer={
        <View className="account-consent__actions">
          <Button
            variant="secondary"
            disabled={state.consentBusy}
            onClick={() => {
              void account.refuseConsent();
            }}
          >
            不同意并退出
          </Button>
          <Button
            loading={state.consentBusy}
            onClick={() => {
              void account.acceptConsent();
            }}
          >
            同意并继续
          </Button>
        </View>
      }
    >
      <View className="account-consent__body">
        {state.consent.map((item) => (
          <View className="account-consent__item" key={item.agreementKey}>
            <TextButton
              arrow
              onClick={() => {
                void Taro.navigateTo({
                  url: `/pages/agreement/index?id=${encodeURIComponent(item.agreementVersionId)}`,
                });
              }}
            >
              {item.name}
            </TextButton>
            <View className="account-consent__version">
              {item.versionLabel} · {agreementEffectiveDate(item.effectiveAt)} 生效
            </View>
            <View className="account-consent__summary">{item.summary}</View>
          </View>
        ))}
        {state.consentError ? <Note>{state.consentError}</Note> : null}
      </View>
    </Sheet>
  );
}
