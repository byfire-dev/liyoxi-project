import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button as NativeButton, View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { Button } from "@/components/Button";
import { Checkbox } from "@/components/Checkbox";
import { accountError } from "@/lib/account-controller";
import { account, useAccount } from "@/lib/account-runtime";
import { ApiError } from "@/lib/request";
import { ensurePrivacyAuthorized, captureError } from "@/lib/runtime";
import { useBootstrapStore } from "@/stores/bootstrap";
import { useSessionStore } from "@/stores/session";
import { useContextStore } from "@/stores/context";
import { createPhoneAuthorization } from "./phone-authorization";
import "../../sub/service/settings/phone-button.scss";

/** 原生组件只采集 opaque code；H5 明确不可用，不接收手填手机号。 */
function PhoneFormContent() {
  const state = useAccount();
  const copy = useBootstrapStore((value) => value.data.copy);
  const [agreed, setAgreed] = useState(false);
  const authorization = useMemo(
    () =>
      createPhoneAuthorization({
        supported: process.env.TARO_ENV === "weapp",
        scope: () =>
          JSON.stringify([
            useSessionStore.getState().accessToken,
            useContextStore.getState().contextRev,
          ]),
        privacy: ensurePrivacyAuthorized,
        exhausted: () => captureError("handler", new Error("phone_component_quota_exhausted")),
      }),
    [],
  );
  useEffect(() => authorization.dispose, [authorization]);
  const phone = useSyncExternalStore(
    authorization.subscribe,
    authorization.snapshot,
    authorization.snapshot,
  );
  return (
    <View className="account-login__form">
      {phone.error ? (
        <View role="alert" className="settings-phone-error">
          {phone.error}
        </View>
      ) : null}
      {phone.ready && agreed ? (
        <NativeButton
          className="settings-phone-button"
          openType="getPhoneNumber"
          disabled={phone.busy || !state.agreements.length}
          onGetPhoneNumber={(event) => {
            void authorization.accept(event.detail, async (code) => {
              try {
                await account.phoneLogin(code, agreed);
              } catch (error) {
                if (error instanceof ApiError && error.error === "AGREEMENT_VERSION_STALE")
                  setAgreed(false);
                throw new Error(accountError(error), { cause: error });
              }
            });
          }}
        >
          {copy["login.button"] ?? "手机号快捷登录"}
        </NativeButton>
      ) : (
        <Button
          block
          size="xl"
          loading={phone.busy}
          disabled={!state.agreements.length}
          onClick={() => {
            void authorization.prepare(agreed);
          }}
        >
          {copy["login.button"] ?? "手机号快捷登录"}
        </Button>
      )}
      <View className="account-login__legal">
        <Checkbox
          checked={agreed}
          disabled={phone.busy}
          onChange={(value) => {
            setAgreed(value);
            void authorization.prepare(value);
          }}
        >
          我已阅读并同意
        </Checkbox>
        <View className="account-login__links">
          {state.agreements.map((item) => (
            <Text
              key={item.agreementKey}
              className="account-login__link"
              onClick={() => {
                if (item.currentVersion)
                  void Taro.navigateTo({
                    url: `/pages/agreement/index?id=${encodeURIComponent(item.currentVersion.agreementVersionId)}`,
                  });
              }}
            >
              《{item.name}》
            </Text>
          ))}
        </View>
      </View>
      <View className="account-login__first">
        {copy["login.firstLogin"] ?? "首次登录将自动创建商家账号"}
      </View>
    </View>
  );
}
export function PhoneForm() {
  const token = useSessionStore((s) => s.accessToken),
    revision = useContextStore((s) => s.contextRev);
  return <PhoneFormContent key={JSON.stringify([token, revision])} />;
}
