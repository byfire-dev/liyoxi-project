import { useEffect, useRef, useState } from "react";
import { useShareAppMessage, useUnload } from "@tarojs/taro";
import { View } from "@tarojs/components";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Note } from "@/components/Note";
import { uuid } from "@/lib/platform";
import { newIdempotencyKey } from "@/lib/runtime";
import { ActionError, Frame, TextField, useTenantAction, useTenantRead } from "../members/view";
import { tenantContext, tenantRuntime } from "../members/runtime";
import type { Invitation } from "../members/api";
import { useDraft } from "../../profile/private/draft";
import { createInvitationFlow, invitationSharePath } from "./runtime";
export default function InvitePage() {
  const read = useTenantRead((api) => api.members());
  const create = useTenantAction("invitation_create", uuid),
    revoke = useTenantAction("invitation_revoke");
  const [form, setForm] = useDraft(undefined, () => ({ remarkName: "", phone: "" }), {
    remarkName: "",
    phone: "",
  });
  const { remarkName, phone } = form;
  const setRemark = (remarkName: string) => setForm((old) => ({ ...old, remarkName }));
  const setPhone = (phone: string) => setForm((old) => ({ ...old, phone }));
  const [card, setCard] = useState<{ value: Invitation; context: string; form: string } | null>(
    null,
  );
  const [revoked, setRevoked] = useState(false);
  const flow = useRef<ReturnType<typeof createInvitationFlow> | null>(null);
  const initial = useRef<string | null>(null);
  const currentCard = card?.context === tenantContext() ? card.value : null;
  const makeCard = () =>
    void create.run({ remarkName, phone }, async (clientRequestId, current) => {
      if (read.data?.viewerRole !== "owner") throw new Error("仅老板可邀请店员");
      const runtime = await tenantRuntime();
      if (!current()) return;
      const value = await runtime.api.invite({
        clientRequestId,
        remarkName: remarkName.trim() || null,
        targetPhone: phone || null,
      });
      if (current()) {
        setCard({ value, context: tenantContext(), form: JSON.stringify({ remarkName, phone }) });
        setRevoked(false);
        flow.current = createInvitationFlow(runtime.api, () =>
          newIdempotencyKey("invitation_share"),
        );
      }
      return value;
    });
  useEffect(() => {
    const context = tenantContext();
    if (read.data?.viewerRole === "owner" && initial.current !== context) {
      initial.current = context;
      makeCard();
    }
  });
  useShareAppMessage(() => {
    if (
      !currentCard ||
      card?.context !== tenantContext() ||
      card.form !== JSON.stringify(form) ||
      create.busy ||
      revoke.busy
    )
      return { title: "狸有戏门店邀请", path: "/pages/mine/index" };
    void flow.current?.share(currentCard).catch(() => undefined);
    return {
      title: `${currentCard.inviterName}邀请你加入${currentCard.storeName ?? "门店"}`,
      path: invitationSharePath(currentCard),
    };
  });
  const latest = useRef({ card: currentCard, context: tenantContext() });
  const context = tenantContext();
  useEffect(() => {
    latest.current = { card: currentCard, context };
  }, [currentCard, context]);
  useUnload(() => {
    const value = latest.current;
    if (value.card && value.context === tenantContext())
      void flow.current?.leave(value.card).catch(() => undefined);
  });
  return (
    <Frame loading={read.loading} error={read.error} retry={() => void read.load()}>
      <View className="tenant-stack">
        <ActionError error={create.error ?? revoke.error} />
        {read.data?.viewerRole !== "owner" ? (
          <Note>仅老板可创建邀请</Note>
        ) : (
          <>
            <Card title="邀请店员">
              <TextField
                label="备注名（选填）"
                value={remarkName}
                onChange={setRemark}
                max={10}
                disabled={create.busy || revoke.busy}
              />
              <TextField
                label="对方手机号（按要求填写）"
                value={phone}
                onChange={setPhone}
                max={11}
                numeric
                disabled={create.busy || revoke.busy}
              />
              <Note>填写手机号时，仅该号码可接受邀请；手机号不在分享卡片或链接中展示</Note>
              <Button
                variant="outline"
                loading={create.busy}
                disabled={revoke.busy}
                onClick={makeCard}
              >
                {currentCard ? "保存邀请内容" : "生成邀请"}
              </Button>
            </Card>
            {currentCard ? (
              <Card title={`${currentCard.inviterName}邀请你加入门店`}>
                <View>{currentCard.storeName ?? "未命名门店"}</View>
                <View>有效期至 {currentCard.expiresAt}</View>
                <View>{currentCard.isPhoneRestricted ? "限指定手机号" : "不限手机号"}</View>
                <View className="tenant-muted">
                  名额 {currentCard.seats.seatsUsed}/{currentCard.seats.memberLimit ?? "不限"} ·
                  待接受 {currentCard.seats.pendingInvitationCount}
                </View>
                {card?.form !== JSON.stringify(form) ? <Note>请先保存修改后的邀请内容</Note> : null}
                <Button
                  openType="share"
                  disabled={create.busy || revoke.busy || card?.form !== JSON.stringify(form)}
                >
                  发送给微信好友
                </Button>
                <Button
                  variant="danger"
                  loading={revoke.busy}
                  disabled={create.busy}
                  onClick={() =>
                    void revoke.run({ id: currentCard.invitationId }, async (key, current) => {
                      const runtime = await tenantRuntime();
                      if (!current()) return;
                      await runtime.api.revoke(currentCard.invitationId, "by_owner", key);
                      if (current()) {
                        setCard(null);
                        setRevoked(true);
                      }
                    })
                  }
                >
                  撤回邀请
                </Button>
              </Card>
            ) : revoked ? (
              <Note>邀请已撤回，原分享卡片无法加入</Note>
            ) : null}
          </>
        )}
      </View>
    </Frame>
  );
}
