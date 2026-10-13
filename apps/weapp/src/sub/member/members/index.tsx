import { appDateTimeFormat as fmtMerchant } from "@liyoxi/shared/format/datetime";
import Taro from "@tarojs/taro";
import { View } from "@tarojs/components";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Checkbox } from "@/components/Checkbox";
import { Empty } from "@/components/Empty";
import { Note } from "@/components/Note";
import { Sheet } from "@/components/Sheet";
import { account } from "@/lib/account-runtime";
import { useSessionStore } from "@/stores/session";
import { ActionError, Frame, useTenantAction, useTenantRead } from "./view";
import { tenantNavigate, tenantRuntime } from "./runtime";
import type { Member } from "./api";
import { useDraft } from "../../profile/private/draft";
export default function MembersPage() {
  const read = useTenantRead(async (api) => ({
    members: await api.members(),
    stores: await api.stores(),
  }));
  const action = useTenantAction("member_manage");
  const [editing, setEditing] = useDraft<undefined, { member: Member; ids: string[] } | null>(
    undefined,
    () => null,
    null,
  );
  const data = read.data?.members;
  const write = (member: Member, verb: "update" | "remove") =>
    void action.run({ id: member.memberId, verb, storeIds: editing?.ids }, async (key, current) => {
      if (data?.viewerRole !== "owner" || !member.actions.includes(verb))
        throw new Error("该成员当前不可操作，请刷新");
      if (verb === "remove") {
        const confirm = await Taro.showModal({
          title: "移除成员",
          content: `将解除${member.displayName ?? "该成员"}的全部门店关系，其已上传素材保留。是否继续？`,
        });
        if (!confirm.confirm || !current()) return;
      }
      const { api } = await tenantRuntime();
      if (!current()) return;
      if (verb === "update") {
        if (!editing?.ids.length) throw new Error("请至少保留一家门店；如不再合作，请移除成员");
        await api.updateMember(member.memberId, { storeIds: editing.ids }, key);
      } else await api.removeMember(member.memberId, key);
      if (current()) {
        setEditing(null);
        await read.load();
      }
    });
  const leave = () =>
    void action.run({ leave: true }, async (key, current) => {
      if (data?.viewerRole !== "clerk" || !data.items.some((m) => m.isSelf))
        throw new Error("仅店员本人可退出");
      const confirm = await Taro.showModal({
        title: "退出门店",
        content: "退出将解除该主体下全部门店关系；上传素材保留。是否继续？",
      });
      if (!confirm.confirm || !current()) return;
      const { api } = await tenantRuntime();
      if (!current()) return;
      await api.leave(key);
      if (current()) {
        const token = useSessionStore.getState().accessToken;
        await account.reloadMe();
        if (token === useSessionStore.getState().accessToken)
          await Taro.switchTab({ url: "/pages/mine/index" });
      }
    });
  return (
    <Frame loading={read.loading} error={read.error} retry={() => void read.load()}>
      <View className="tenant-stack">
        <ActionError error={action.error} />
        {data?.viewerRole === "owner" ? (
          <Card title="成员名额">
            <View>
              已用 {data.seats.seatsUsed}/{data.seats.memberLimit ?? "不限"} · 待接受{" "}
              {data.seats.pendingInvitationCount}
            </View>
            <View className="tenant-muted">
              {data.seats.planName ?? "暂无生效套餐"} · 待接受的邀请也占名额
            </View>
            <Button
              disabled={action.busy}
              onClick={() => void tenantNavigate("sub/member/invite/index")}
            >
              邀请店员
            </Button>
          </Card>
        ) : null}
        {!data?.items.length ? (
          <Empty title="暂无成员" />
        ) : (
          data.items.map((m) => (
            <Card key={m.memberId} title={`${m.displayName ?? "成员"}${m.isSelf ? "（我）" : ""}`}>
              <View>
                {m.role === "owner" ? "老板" : "店员"} · {fmtMerchant.date(m.joinedAt)} 加入
              </View>
              {data.viewerRole === "owner" && "actions" in m ? (
                <>
                  <View className="tenant-muted">
                    {m.phoneMask} · {m.stores.map((s) => s.name ?? "未命名门店").join("、")} · 上传{" "}
                    {m.uploadCount} / 采用 {m.adoptedCount}
                  </View>
                  <View className="tenant-row">
                    {m.actions.includes("update") ? (
                      <Button
                        variant="outline"
                        disabled={action.busy}
                        onClick={() =>
                          setEditing({ member: m, ids: m.stores.map((s) => s.storeId) })
                        }
                      >
                        所属门店
                      </Button>
                    ) : null}
                    {m.actions.includes("remove") ? (
                      <Button
                        variant="danger"
                        disabled={action.busy}
                        onClick={() => write(m, "remove")}
                      >
                        移除成员
                      </Button>
                    ) : null}
                  </View>
                </>
              ) : null}
            </Card>
          ))
        )}
        {data?.viewerRole === "owner" ? (
          data.pendingInvitations.map((inv) => (
            <Card key={inv.invitationId} title={inv.remarkName ?? "待接受的邀请"}>
              <View>
                有效期至 {fmtMerchant.dateTime(inv.expiresAt)} ·{" "}
                {inv.isPhoneRestricted ? "限指定手机号" : "不限手机号"}
              </View>
              {inv.actions.includes("revoke") ? (
                <Button
                  variant="danger"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run({ revoke: inv.invitationId }, async (key, current) => {
                      const yes = await Taro.showModal({
                        title: "撤回邀请",
                        content: "撤回后原卡片无法加入，名额会释放",
                      });
                      if (!yes.confirm || !current()) return;
                      const runtime = await tenantRuntime();
                      if (!current()) return;
                      await runtime.api.revoke(inv.invitationId, "by_owner", key);
                      if (current()) await read.load();
                    })
                  }
                >
                  撤回邀请
                </Button>
              ) : null}
            </Card>
          ))
        ) : (
          <Note>店员只查看成员称呼与角色，名额及手机号由老板管理</Note>
        )}
        {data?.viewerRole === "clerk" ? (
          <Button variant="danger" loading={action.busy} onClick={leave}>
            退出所在主体的门店
          </Button>
        ) : null}
        <Sheet
          visible={editing !== null}
          title={`所属门店 · ${editing?.member.displayName ?? "成员"}`}
          onClose={() => {
            if (!action.busy) setEditing(null);
          }}
          footer={
            <Button
              loading={action.busy}
              onClick={() => {
                if (editing) write(editing.member, "update");
              }}
            >
              保存门店
            </Button>
          }
        >
          <View className="tenant-stack">
            {read.data?.stores.items
              .filter((s) => s.lifecycle === "active")
              .map((s) => (
                <Checkbox
                  key={s.storeId}
                  checked={editing?.ids.includes(s.storeId) ?? false}
                  disabled={action.busy}
                  onChange={(yes) =>
                    setEditing((old) =>
                      old
                        ? {
                            ...old,
                            ids: yes
                              ? [...old.ids, s.storeId]
                              : old.ids.filter((id) => id !== s.storeId),
                          }
                        : old,
                    )
                  }
                >
                  {s.name ?? "未命名门店"}
                </Checkbox>
              ))}
          </View>
        </Sheet>
      </View>
    </Frame>
  );
}
