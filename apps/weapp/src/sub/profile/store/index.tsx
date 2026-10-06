import { useUploadBusy } from "@/lib/upload/taro";
import { useState } from "react";
import { View } from "@tarojs/components";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { FooterBar } from "@/components/FooterBar";
import { Note } from "@/components/Note";
import { StepBar } from "@/components/StepBar";
import { FileGrid, type MediaFile } from "../private/uploads";
import { Frame, Feedback, STEP_NAMES, useAction, useResource } from "../private/ui";
import { profileRuntime } from "../private/runtime";
export default function Store() {
  const uploading = useUploadBusy();
  const resource = useResource((api) => api.media());
  const action = useAction("profile_media", 2);
  const data = resource.data;
  const [groups, setGroups] = useState<{
    door: MediaFile[];
    interior: MediaFile[];
    product: MediaFile[];
    promo: MediaFile[];
  }>({ door: [], interior: [], product: [], promo: [] });
  const [video, setVideo] = useState(false);
  const [source, setSource] = useState(data);
  if (data && source !== data) {
    setSource(data);
    setGroups({
      door: data.groups.door.flatMap((item) => (item.file ? [item.file] : [])),
      interior: data.groups.interior.flatMap((item) => (item.file ? [item.file] : [])),
      product: data.groups.product.flatMap((item) => (item.file ? [item.file] : [])),
      promo: data.groups.promo.flatMap((item) => (item.file ? [item.file] : [])),
    });
  }
  const readonly = data?.viewerRole !== "owner";
  return (
    <Frame
      loading={resource.loading}
      error={resource.error}
      retry={() => {
        void resource.load();
      }}
    >
      <StepBar steps={STEP_NAMES} current={1} />
      <Feedback
        action={action}
        refresh={() => {
          void resource.load();
        }}
      />
      <Note>实拍门头和店内环境，便于制作门店广告。至少1张门头、3张环境照片</Note>
      {(
        [
          ["door", "门头照片", "门店招牌清晰、正面实拍"],
          ["interior", "店内环境", "展示整体环境、桌椅与服务区"],
          ["product", "产品与服务实拍", "选填，可添加图片或视频"],
          ["promo", "已有宣传素材", "选填，图片或宣传视频"],
        ] as const
      ).map(([group, name, description]) => (
        <Card
          key={group}
          title={name}
          extra={<View className="profile-subtitle">{groups[group].length}/12</View>}
        >
          <View className="profile-subtitle">{description}</View>
          {group === "product" || group === "promo" ? (
            <Button variant="secondary" disabled={readonly} onClick={() => setVideo(!video)}>
              {video ? "选择视频" : "选择照片"} · 切换
            </Button>
          ) : null}
          <FileGrid
            key={`${group}-${group === "product" || group === "promo" ? video : false}`}
            files={groups[group]}
            category={
              group === "promo"
                ? "profile_promo"
                : group === "product" && video
                  ? "profile_video"
                  : "profile_image"
            }
            video={(group === "product" || group === "promo") && video}
            disabled={readonly}
            onChange={(files) => setGroups((old) => ({ ...old, [group]: files }))}
          />
        </Card>
      ))}
      {!readonly ? (
        <FooterBar>
          <Button
            block
            loading={action.busy}
            disabled={uploading}
            onClick={() => {
              if (!data || data.viewerRole !== "owner") return;
              const body = {
                draft: true,
                lockVersion: data.lockVersion,
                groups: {
                  door: groups.door.map((file) => ({ fileId: file.fileId })),
                  interior: groups.interior.map((file) => ({ fileId: file.fileId })),
                  product: groups.product.map((file) => ({ fileId: file.fileId })),
                  promo: groups.promo.map((file) => ({ fileId: file.fileId })),
                },
              };
              void action
                .run(body, async (key) => {
                  const value = await (await profileRuntime()).api.saveMedia(body, key);
                  return value;
                })
                .then((value) => {
                  if (value) resource.setData(value);
                });
            }}
          >
            保存门店环境
          </Button>
        </FooterBar>
      ) : null}
    </Frame>
  );
}
