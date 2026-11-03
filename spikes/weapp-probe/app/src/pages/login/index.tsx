import { Button, Text, View } from "@tarojs/components";
import { useState } from "react";
import { api, ensurePrivacy, errorCode, isFake, login, observe, report } from "../../lib/api";
import { Frame } from "../../lib/frame";

type PhoneEvent = { detail: { code?: string; errno?: number; errMsg?: string } };
type Phone = { accountId: string; phoneMasked: string; linkedWechatCount: number };
export default function LoginPage() {
  const [ready, setReady] = useState(false);
  const [real, setReal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("先建立登录会话，再操作原生取号组件。");
  const [scenario, setScenario] = useState("normal");
  const [started, setStarted] = useState(0);
  const establish = async () => {
    setBusy(true);
    setReady(false);
    try {
      await observe("V19", "login", async () => {
        const data = await login(true);
        const fake = await isFake();
        setReal(!fake);
        if (!fake) await ensurePrivacy();
        setMessage(`身份标签 ${data.identityTag}；账号 ${data.accountId || "未绑定"}`);
        setReady(true);
      });
    } catch (error) {
      setMessage(errorCode(error));
    } finally {
      setBusy(false);
    }
  };
  const phone = async (event: PhoneEvent, kind: "quick" | "realtime") => {
    if (busy) return;
    setBusy(true);
    let code = "";
    let result: "success" | "failure" | "cancelled" = "success";
    try {
      if (!event.detail.code) throw event.detail;
      const value = await api<Phone>("/phone", "POST", { code: event.detail.code, kind });
      setMessage(
        `账号 ${value.accountId}；${value.phoneMasked}；关联身份数 ${value.linkedWechatCount}`,
      );
    } catch (error) {
      code = errorCode(error);
      result = code === "CANCELLED" ? "cancelled" : "failure";
      setMessage(code);
    } finally {
      await report({
        item: "V19",
        scenario: `${kind}_${scenario}`,
        sizeBytes: 0,
        durationMs: Date.now() - (started || Date.now()),
        result,
        errorCode: code,
      });
      setBusy(false);
    }
  };
  return (
    <Frame title="V19 手机号与多身份" locked={busy}>
      <Button disabled={busy} onClick={() => void establish()}>
        建立 / 重建登录会话
      </Button>
      <View className="panel">
        <Text className="line">场景：{scenario}</Text>
        {["normal", "add_other_number", "second_wechat_same_phone"].map((value) => (
          <Button size="mini" key={value} disabled={busy} onClick={() => setScenario(value)}>
            {value}
          </Button>
        ))}
      </View>
      <Button
        openType="getPhoneNumber"
        disabled={!ready || busy || !real}
        onClick={() => setStarted(Date.now())}
        onGetPhoneNumber={(event) => void phone(event, "quick")}
      >
        快速验证组件
      </Button>
      <Button
        openType="getRealtimePhoneNumber"
        disabled={!ready || busy || !real}
        onClick={() => setStarted(Date.now())}
        onGetRealTimePhoneNumber={(event: PhoneEvent) => void phone(event, "realtime")}
      >
        实时验证组件
      </Button>
      <Button
        disabled={!ready || busy || real}
        onClick={() =>
          void isFake().then((value) =>
            value
              ? phone({ detail: { code: "fake-phone" } }, "quick")
              : setMessage("REAL 模式请使用原生组件"),
          )
        }
      >
        FAKE 取号端点演练
      </Button>
      <Text className="line">{message}</Text>
      <Text className="line">
        “添加其他号码”的入口、允许添加数量与体验判断请写入清单；不要截图或回传完整手机号。换微信后先重新建立会话，再以实时组件验证同一号码的账号与关联身份数。
      </Text>
    </Frame>
  );
}
