import { View } from "@tarojs/components";
import { Card } from "@/components/Card";
import { Empty } from "@/components/Empty";
import { Button } from "@/components/Button";
import { useContextStore } from "@/stores/context";
import { Frame, useTenantRead } from "../../member/members/view";
import { tenantNavigate } from "../../member/members/runtime";
import { selfProfile } from "./model";
export default function StaffProfile() {
  const storeId = useContextStore((s) => s.currentStoreId);
  const read = useTenantRead(async (api) => {
    const me = await api.me(),
      self = selfProfile(me, storeId);
    if (!self) return null;
    return {
      self,
      profile: await api.profile(),
      members: await api.members(),
      summary: await api.assetSummary(),
      demands: await api.demands(),
    };
  });
  const data = read.data;
  return (
    <Frame loading={read.loading} error={read.error} retry={() => void read.load()}>
      <View className="tenant-stack">
        {!data ? (
          <Empty
            title="这里是店员本人的资料"
            description="请切换到已加入的门店，老板可在门店档案查看门店资料"
          />
        ) : (
          <>
            <Card
              title={data.self.member.memberDisplayName ?? data.self.user.displayName ?? "我的资料"}
            >
              <View>{data.self.user.phoneMask}</View>
              <View className="tenant-muted">
                加入时间 {data.self.member.joinedAt.slice(0, 10)} · 店员
              </View>
            </Card>
            <Card title={data.profile.store.name ?? "当前门店"}>
              <View>资质状态：{data.profile.store.qualificationStatus}</View>
              <Button
                variant="outline"
                onClick={() => void tenantNavigate("sub/profile/basic/index")}
              >
                查看基础信息
              </Button>
              <Button
                variant="outline"
                onClick={() => void tenantNavigate("sub/profile/stores/index")}
              >
                查看可进门店
              </Button>
            </Card>
            <Card title="我上传的素材">
              <View>
                {data.summary.tabs.all} 条 · {data.summary.adoptedCount} 条被采用
              </View>
              <Button onClick={() => void tenantNavigate("sub/asset/upload/index")}>
                上传素材
              </Button>
              <Button
                variant="outline"
                onClick={() => void tenantNavigate("sub/asset/lib/index?uploader=me")}
              >
                查看我的素材
              </Button>
            </Card>
            {data.demands.items.map((d) => (
              <Card key={d.assetDemandId} title={d.title}>
                <Button
                  variant="outline"
                  onClick={() =>
                    void tenantNavigate(
                      `sub/asset/upload/index?assetDemandId=${encodeURIComponent(d.assetDemandId)}`,
                    )
                  }
                >
                  去补充素材
                </Button>
              </Card>
            ))}
            <Card title="门店成员">
              <View>{data.members.items.length} 位</View>
              <Button
                variant="outline"
                onClick={() => void tenantNavigate("sub/member/members/index")}
              >
                查看成员
              </Button>
            </Card>
          </>
        )}
      </View>
    </Frame>
  );
}
