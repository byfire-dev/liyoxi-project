import { useEffect, useState } from "react";
import { View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Field } from "@/components/Field";
import { Input } from "@/components/Input";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { gotoAccountLogin } from "@/lib/account-routing";
import { request, withPrivacy } from "@/lib/runtime";
import { deliveryScope } from "@/stores/delivery";
import { useDeliveryResource } from "../../order/components/resource";
import { DeliveryState, useDeliveryIdentity } from "../../order/components/ui";
import { createPortalApprovalApi, type PortalDecision, type PortalPreview } from "./api";
import { assertPortalDecision, portalCode, ticketExpired } from "./model";
import "./index.scss";

const api = createPortalApprovalApi(request);
type State = { preview: PortalPreview | null; decision: PortalDecision | null };
const empty = (): State => ({ preview: null, decision: null });

export default function PortalApprovePage() {
  const identity = useDeliveryIdentity();
  const params = useRouter().params;
  const initial = params.code ?? params.t ?? params.publicId ?? "";
  return <PortalApproveContent key={`${identity}:${initial}`} initial={initial} />;
}

function PortalApproveContent({ initial }: { initial: string }) {
  const [code, setCode] = useState(initial);
  const [pair, setPair] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const lookup = async (input: string) => {
    const normalized = portalCode(input);
    if (!normalized) throw new Error("请输入电脑显示的8位登录代码，或扫描电脑上的登录二维码");
    const preview = await api.lookup(normalized);
    if (preview.storeId !== deliveryScope().store)
      throw new Error("当前门店已变化，请重新打开电脑下载授权");
    return preview;
  };
  const resource = useDeliveryResource<State>(async () =>
    initial ? { preview: await lookup(initial), decision: null } : empty(),
  );
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const preview = resource.data?.preview;
  const decision = resource.data?.decision;
  const expired = preview ? ticketExpired(preview.expiresAt, now) : false;
  const disabled = resource.loading || resource.busy;
  const find = () =>
    resource.run(null, async (current) => {
      const result = await lookup(code);
      if (current()) setPair("");
      resource.replace({ preview: result, decision: null }, current);
    });
  const reset = () =>
    resource.run(null, async (current) => {
      if (!current()) return;
      setCode("");
      setPair("");
      resource.replace(empty(), current);
    });
  const scan = () =>
    resource.run(null, async (current) => {
      const result = await withPrivacy(() => Taro.scanCode({ scanType: ["qrCode"] }));
      if (!current()) return;
      if (!result.ok) throw new Error("请同意隐私指引后再扫码，也可手输登录代码");
      const resultCode = portalCode(result.value.result);
      if (!resultCode) throw new Error("这不是电脑下载登录码，请扫描电脑下载页的二维码");
      const next = await lookup(resultCode);
      if (current()) {
        setCode(resultCode);
        setPair("");
      }
      resource.replace({ preview: next, decision: null }, current);
    });
  const decide = (approve: boolean) =>
    resource.run(null, async (current) => {
      if (!preview) throw new Error("请先核对这台电脑");
      assertPortalDecision(preview, deliveryScope(), Date.now(), approve ? pair : undefined);
      const key = resource.intent(approve ? "portal-approve" : "portal-reject", {
        id: preview.portalTicketId,
        ...(approve ? { pair } : {}),
      });
      const result = approve
        ? await api.approve(preview.portalTicketId, pair, key)
        : await api.reject(preview.portalTicketId, key);
      resource.replace({ preview: null, decision: result }, current);
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
        {resource.data && !preview && !decision ? (
          <Card title="在电脑上下载成片">
            <View className="delivery-stack">
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
                重新输入登录代码
              </Button>
            </View>
          </Card>
        ) : null}
        {decision ? (
          <Card title={decision.status === "approved" ? "电脑已获授权" : "未授权这台电脑"}>
            <View className="delivery-stack">
              <Note tone={decision.status === "approved" ? "success" : "warning"}>
                {decision.status === "approved"
                  ? "请回到电脑下载页继续下载。"
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
