import { useState } from "react";
import { View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";

import { Button } from "@/components/Button";
import { Checkbox } from "@/components/Checkbox";
import { Field } from "@/components/Field";
import { Input } from "@/components/Input";
import { accountError } from "@/lib/account-controller";
import { account, useAccount } from "@/lib/account-runtime";
import { ApiError } from "@/lib/request";
import { useBootstrapStore } from "@/stores/bootstrap";

/** M1 替身表单；G2-B 只替换此组件的号码凭证采集。 */
export function PhoneForm() {
  const state = useAccount();
  const copy = useBootstrapStore((value) => value.data.copy);
  const [phone, setPhone] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy) return;
    if (!agreed) {
      setError("请先阅读并勾选下方协议");
      return;
    }
    if (!/^1\d{10}$/.test(phone)) {
      setError("请填写有效的11位手机号");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await account.phoneLogin(phone, agreed);
    } catch (failure) {
      if (failure instanceof ApiError && failure.error === "AGREEMENT_VERSION_STALE")
        setAgreed(false);
      setError(
        failure instanceof ApiError
          ? accountError(failure)
          : failure instanceof Error
            ? failure.message
            : accountError(failure),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="account-login__form">
      <Field label="手机号" error={error ?? undefined}>
        <Input
          type="number"
          error={Boolean(error)}
          value={phone}
          maxlength={11}
          onChange={setPhone}
        />
      </Field>
      <Button
        block
        size="xl"
        loading={busy}
        disabled={!state.agreements.length}
        onClick={() => {
          void submit();
        }}
      >
        {copy["login.button"] ?? "手机号快捷登录"}
      </Button>
      <View className="account-login__legal">
        <Checkbox checked={agreed} disabled={busy} onChange={setAgreed}>
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
