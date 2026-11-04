import { useEffect, useRef, useState } from "react";
import { View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow, useRouter } from "@tarojs/taro";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Field } from "@/components/Field";
import { Input } from "@/components/Input";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { gotoAccountLogin } from "@/lib/account-routing";
import { withPrivacy } from "@/lib/runtime";
import { deliveryScope } from "@/stores/delivery";
import { useDeliveryResource } from "../../order/components/resource";
import { DeliveryState, useDeliveryIdentity } from "../../order/components/ui";
import { createPortalApprovalFlow, type ApprovalState } from "./flow";
import { portalCode, ticketExpired } from "./model";
import { portalApprovalApi, portalApprovalIdentity } from "./runtime";
import "./index.scss";

export default function PortalApprovePage() {
  useDeliveryIdentity();
  const identity = portalApprovalIdentity();
  const params = useRouter().params;
  const initial = params.code ?? params.t ?? params.publicId ?? "";
  return <PortalApproveContent key={`${identity}:${initial}`} initial={initial} />;
}

function PortalApproveContent({ initial }: { initial: string }) {
  const [code, setCode] = useState(initial);
  const [pair, setPair] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [flow] = useState(() =>
    createPortalApprovalFlow(
      {
        api: portalApprovalApi,
        scope: deliveryScope,
        identity: portalApprovalIdentity,
        now: Date.now,
        withPrivacy,
        scan: () => Taro.scanCode({ scanType: ["qrCode"] }),
      },
      initial,
    ),
  );
  const resource = useDeliveryResource<ApprovalState>(async (current) => {
    const next = await flow.load(current);
    if (current()) setPair("");
    return next ?? flow.snapshot();
  });
  const hidden = useRef(false);
  useDidHide(() => {
    // 原生扫码可能临时遮住页面，保留其显式调用；作用域改变/卸载仍由 current 拒绝。
    if (flow.nativePending()) return;
    hidden.current = true;
    resource.replace(flow.reset(), () => true);
    setPair("");
    setCode("");
  });
  useDidShow(() => {
    if (hidden.current) {
      hidden.current = false;
      resource.refresh();
    }
  });
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const preview = resource.data?.preview;
  const decision = resource.data?.decision;
  const expired = preview ? ticketExpired(preview.expiresAt, now) : false;
  const disabled = resource.loading || resource.busy;
  const owner = deliveryScope().role === "owner" && Boolean(deliveryScope().token);
  const apply = (next: ApprovalState | null, current: () => boolean) => {
    if (!next || !current()) return;
    setPair("");
    if (next.preview) setCode(next.code);
    else if (next.decision) setCode("");
    resource.replace(next, current);
  };
  const find = () =>
    resource.run(null, async (current) => {
      apply(await flow.find(code, current), current);
    });
  const reset = () =>
    resource.run(null, async (current) => {
      if (!current()) return;
      setCode("");
      setPair("");
      resource.replace(flow.reset(), current);
    });
  const scan = () =>
    resource.run(null, async (current) => {
      apply(await flow.scan(current), current);
    });
  const decide = (approve: boolean) =>
    resource.run(null, async (current) => {
      apply(await flow.decide(approve, pair, current, resource.intent), current);
    });

  return (
    <View className="delivery-page" id={!resource.loading ? "portal-approve-ready" : undefined}>
      <PageBody>
        <DeliveryState loading={resource.loading} error={resource.error} retry={resource.refresh} />
        {!resource.loading && !deliveryScope().token ? (
          <Button block onClick={gotoAccountLogin}>
            登录后授权电脑
          </Button>
        ) : null}
        {!resource.loading && owner && !preview && !decision ? (
          <Card title="在电脑上下载成片">
            <View className="delivery-stack">
              {resource.data?.notice ? <Note tone="warning">{resource.data.notice}</Note> : null}
              <View>在电脑打开下载页，将电脑显示的8位登录代码填在下方。</View>
              <Field label="电脑登录代码" hint="由数字和字母组成，不是短信验证码">
                <Input
                  value={code}
                  maxlength={32}
                  placeholder="输入8位登录代码"
                  disabled={disabled}
                  onChange={setCode}
                  confirmType="search"
                  onConfirm={find}
                />
              </Field>
              <Button
                block
                loading={resource.busy}
                disabled={disabled || !portalCode(code)}
                onClick={find}
              >
                核对这台电脑
              </Button>
              {process.env.TARO_ENV === "weapp" ? (
                <Button block variant="outline" disabled={disabled} onClick={scan}>
                  扫描电脑登录码
                </Button>
              ) : null}
            </View>
          </Card>
        ) : null}
        {preview ? (
          <Card title="确认电脑下载授权">
            <View className="delivery-stack">
              <View>授权门店：{preview.storeName ?? "当前门店"}</View>
              <View>浏览器：{preview.browser}</View>
              <View>大致地区：{preview.regionHint ?? "未取得地区"}</View>
              <View className="delivery-caption">
                发起于 {appDateTimeFormat.dateTime(preview.createdAt)}
              </View>
              <Note>允许后，这台电脑可下载本店已交付的成片。请核对电脑上的两位数字。</Note>
              {expired ? (
                <Note tone="warning">登录码已过期，请在电脑上刷新后重新输入。</Note>
              ) : (
                <>
                  <View className="portal-approve__choices">
                    {preview.pairChoices.map((digits) => (
                      <Button
                        key={digits}
                        className="portal-approve__choice"
                        variant={pair === digits ? "primary" : "outline"}
                        disabled={disabled}
                        onClick={() => setPair(digits)}
                      >
                        {digits}
                      </Button>
                    ))}
                  </View>
                  <View className="delivery-caption">
                    {pair ? `已选择 ${pair}` : "请选择电脑上显示的数字"}
                  </View>
                  <Button
                    block
                    disabled={disabled || !pair}
                    loading={resource.busy}
                    onClick={() => decide(true)}
                  >
                    允许这台电脑下载
                  </Button>
                  <Button
                    block
                    variant="secondary"
                    disabled={disabled}
                    onClick={() => decide(false)}
                  >
                    拒绝授权
                  </Button>
                </>
              )}
              <Button block variant="outline" disabled={disabled} onClick={reset}>
                {expired ? "输入新的登录代码" : "取消本次核对"}
              </Button>
            </View>
          </Card>
        ) : null}
        {decision ? (
          <Card title={decision.status === "approved" ? "本次授权已确认" : "未授权这台电脑"}>
            <View className="delivery-stack">
              <Note tone={decision.status === "approved" ? "success" : "warning"}>
                {decision.status === "approved"
                  ? "请回到电脑继续。"
                  : decision.rejectReason === "pair_mismatch"
                    ? "配对数字不一致，此登录码已作废。请在电脑重新获取登录码。"
                    : "你已拒绝本次电脑登录。"}
              </Note>
              <Button block variant="outline" disabled={disabled} onClick={reset}>
                授权其他电脑
              </Button>
            </View>
          </Card>
        ) : null}
      </PageBody>
    </View>
  );
}
