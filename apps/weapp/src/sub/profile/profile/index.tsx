import { View } from "@tarojs/components";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Empty } from "@/components/Empty";
import { List, ListRow } from "@/components/List";
import { ProgressBar } from "@/components/ProgressBar";
import { StatusTag, merchantStatusByEnum } from "@/components/StatusTag";
import { accountPageImplemented } from "@/lib/account-entries";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { gotoAccountLogin } from "@/lib/account-routing";
import {
  Frame,
  Feedback,
  navigate,
  STEP_NAMES,
  STEP_PATHS,
  useAction,
  useResource,
} from "../private/ui";
import { profileRuntime } from "../private/runtime";
import { profileMissingLabel } from "../private/model";
export default function Profile() {
  const storeId = useContextStore((s) => s.currentStoreId);
  const token = useSessionStore((s) => s.accessToken);
  const resource = useResource(async (api) =>
    useContextStore.getState().currentStoreId ? api.overview() : null,
  );
  const action = useAction("entity_create");
  const data = resource.data;
  const tag =
    data && merchantStatusByEnum("store.qualification_status", data.store.qualificationStatus);
  return (
    <Frame
      loading={resource.loading}
      error={resource.error}
      retry={() => {
        void resource.load();
      }}
    >
      <Feedback action={action} />
      {!token ? (
        <Card>
          <Empty title="登录后，建立门店档案" actionText="去登录" onAction={gotoAccountLogin} />
        </Card>
      ) : !storeId ? (
        <Card>
          <Empty
            title="开始你的门店建档"
            description="填写门店信息与资质，平台将为门店定制短剧广告"
          />
          <Button
            block
            loading={action.busy}
            onClick={() => {
              void action.run({}, async (key) => {
                const runtime = await profileRuntime();
                await runtime.api.create(key);
                await runtime.reloadMe();
                await resource.load();
              });
            }}
          >
            开始建档
          </Button>
        </Card>
      ) : data ? (
        <>
          <View className="profile-row">
            <View>
              <View className="profile-title">{data.store.name ?? "门店档案"}</View>
              <View className="profile-subtitle">
                {data.store.category?.name ?? "填写门店资料，让短剧更懂你的门店"}
              </View>
            </View>
            {tag ? <StatusTag tone={tag.tone}>{tag.label}</StatusTag> : null}
          </View>
          <Card title="建档完成度">
            <View className="profile-counter">{data.completeness.pct}%</View>
            <ProgressBar percent={data.completeness.pct} />
            <View className="profile-subtitle">
              已完成 {data.completeness.requiredFilled}/{data.completeness.requiredTotal} 项必填资料
            </View>
          </Card>
          <List className="profile-steps">
            {data.completeness.steps.map((step) => (
              <ListRow
                key={step.step}
                title={`${step.step} · ${STEP_NAMES[step.step - 1]}`}
                description={
                  step.missing.length
                    ? `需补充：${step.missing.map((item) => profileMissingLabel(item.item)).join("、")}`
                    : "已完成"
                }
                value={
                  step.state === "completed"
                    ? "已完成"
                    : step.state === "not_started"
                      ? "未开始"
                      : "填写中"
                }
                onClick={() => navigate(STEP_PATHS[step.step - 1]!)}
              />
            ))}
          </List>
          <Card title="资质审核" onClick={() => navigate("review")}>
            <View className="profile-subtitle">
              {tag?.label ?? "未知状态"} · 查看进度与审核结果
            </View>
          </Card>
          {[
            ["sub/asset/lib/index", "门店素材"],
            ["sub/member/members/index", "成员管理"],
            ["sub/ad/ads/index", "我的广告"],
          ]
            .filter(([route]) => accountPageImplemented(route!))
            .map(([route, name]) => (
              <Card
                key={route}
                title={name}
                onClick={() => {
                  void import("@tarojs/taro").then(({ default: taro }) =>
                    taro.navigateTo({ url: `/${route}` }),
                  );
                }}
              />
            ))}
        </>
      ) : null}
    </Frame>
  );
}
