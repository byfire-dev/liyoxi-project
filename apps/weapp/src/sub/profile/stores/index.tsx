import Taro from "@tarojs/taro";
import { View } from "@tarojs/components";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Empty } from "@/components/Empty";
import { Note } from "@/components/Note";
import { account } from "@/lib/account-runtime";
import { Frame, ActionError, useTenantAction, useTenantRead } from "../../member/members/view";
import { tenantNavigate, tenantRuntime } from "../../member/members/runtime";
import { permittedStoreAction, storeName } from "./model";
export default function StoresPage() {
  const read = useTenantRead((api) => api.stores());
  const action = useTenantAction("store_manage");
  const data = read.data;
  const write = (storeId: string, verb: "archive" | "delete" | "restore") => {
    void action.run({ storeId, verb }, async (key, current) => {
      if (!data || !permittedStoreAction(data, storeId, verb))
        throw new Error("当前门店不支持该操作，请刷新");
      const choice = await Taro.showModal({
        title: { archive: "停用门店", delete: "删除草稿门店", restore: "恢复门店" }[verb],
        content: "将按门店当前状态与额度处理，是否继续？",
      });
      if (!choice.confirm || !current()) return;
      const { api } = await tenantRuntime();
      if (!current()) return;
      const result =
        verb === "delete" ? await api.removeStore(storeId, key) : await api[verb](storeId, key);
      if (current()) {
        await account.reloadMe();
        await read.load();
      }
      return result;
    });
  };
  return (
    <Frame loading={read.loading} error={read.error} retry={() => void read.load()}>
      <View className="tenant-stack">
        <ActionError error={action.error} />
        {data?.viewerRole === "owner" ? (
          <Card title="主体与额度">
            <View>{data.entity.name ?? "尚未认证主体"}</View>
            <View>
              门店 {data.entity.storesUsed}/{data.entity.storeLimit} · 成员 {data.entity.seatsUsed}/
              {data.entity.memberLimit ?? "不限"}
            </View>
            <View className="tenant-muted">
              待接受邀请 {data.entity.pendingInvitationCount} ·{" "}
              {data.entity.subscription?.planName ?? "暂未开通套餐"}
            </View>
            <Button
              disabled={!data.entity.canAddStore || action.busy}
              onClick={() => void tenantNavigate("sub/profile/store-add/index")}
            >
              新增门店
            </Button>
          </Card>
        ) : null}
        {!data?.items.length ? (
          <Empty title="暂无可管理门店" description="老板可建立门店档案；店员请向老板获取邀请" />
        ) : (
          data.items.map((store) => (
            <Card key={store.storeId} title={storeName(store)}>
              <View>
                {store.isPrimary ? "首家门店 · " : ""}
                {store.lifecycle === "archived" ? "已停用" : "营业中"} · {store.qualificationStatus}
              </View>
              <View className="tenant-muted">
                {store.city?.name} {store.category?.name} · 素材 {store.assetCount} · 店员{" "}
                {store.clerkCount} · 待办 {store.todoCount}
              </View>
              <View className="tenant-row">
                <Button
                  variant="outline"
                  disabled={action.busy}
                  onClick={() => {
                    void action.run({ select: store.storeId }, async (_key, current) => {
                      if (!current()) return;
                      const runtime = await tenantRuntime();
                      await runtime.selectResult(
                        store.storeId,
                        current,
                        data.viewerRole === "clerk"
                          ? "sub/profile/staff-profile/index"
                          : "sub/profile/profile/index",
                      );
                    });
                  }}
                >
                  进入本店
                </Button>
                {store.actions.map((verb) => (
                  <Button
                    key={verb}
                    variant={verb === "restore" ? "secondary" : "danger"}
                    disabled={action.busy}
                    onClick={() => write(store.storeId, verb)}
                  >
                    {{ archive: "停用", delete: "删除草稿", restore: "恢复" }[verb]}
                  </Button>
                ))}
              </View>
            </Card>
          ))
        )}
        {data?.viewerRole === "clerk" ? (
          <Note>仅显示老板授权给你的门店，额度与财务信息由老板管理</Note>
        ) : null}
      </View>
    </Frame>
  );
}
