import { sharedTokens } from "@liyoxi/shared/design/tokens";
import { View } from "@tarojs/components";
import { useState } from "react";

import { Cover } from "@/components/Cover";
import { TextButton } from "@/components/TextButton";

import { Demo } from "../demo";

import sample from "../assets/sample-cover.png";

import "./Cover.scss";

// 占位底色本该是每部剧自己的主色（接口给）；这里借几个样式变量的值当示例数据
const color = sharedTokens.color;

function CoverRecoveryPreview() {
  const [source, setSource] = useState<string | undefined>("/cover-recovery-missing.png");
  const [mount, setMount] = useState(0);
  const [refresh, setRefresh] = useState(0);
  return (
    <Demo title="失败恢复：换地址重新加载；同地址更新保留占位，重新挂载再试一次">
      <View id="cover-recovery" className="lyx-cover-demo__scroll">
        <Cover
          key={mount}
          variant="scroll"
          title="封面恢复示例"
          src={source}
          color={color.primary}
          caption={`父层更新 ${refresh}`}
        />
      </View>
      <TextButton onClick={() => setSource(sample)}>切换有效封面</TextButton>
      <TextButton onClick={() => setSource("/cover-recovery-missing.png")}>切换失败地址</TextButton>
      <TextButton onClick={() => setSource(undefined)}>清空封面地址</TextButton>
      <TextButton onClick={() => setRefresh((value) => value + 1)}>同地址重渲染</TextButton>
      <TextButton onClick={() => setMount((value) => value + 1)}>重新挂载重试</TextButton>
    </Demo>
  );
}

export default function CoverPreview() {
  return (
    <>
      <Demo title="宫格封面（两列）：占位样式，带角标与左下角文字">
        <View className="lyx-cover-demo__grid">
          <Cover
            title="巷口那家店"
            color={color.primary}
            badge="新剧"
            badgeTone="info"
            caption="80 集"
          />
          <Cover
            title="山那边的信"
            color={color.info}
            badge="推荐"
            badgeTone="warning"
            caption="60 集"
          />
        </View>
      </Demo>
      <Demo title="有封面图：铺满裁切，不显示细框与剧名；文字下垫暗色渐变">
        <View className="lyx-cover-demo__grid">
          <Cover title="巷口那家店" src={sample} badge="新剧" badgeTone="info" caption="80 集" />
          <Cover
            title="加载失败回落占位"
            src="/no-such-image.png"
            color={color.success}
            caption="40 集"
          />
        </View>
      </Demo>
      <Demo title="失效态：去色，不透明度 0.45；没给底色时的兜底" row>
        <View className="lyx-cover-demo__scroll">
          <Cover variant="scroll" title="旧时光" color={color.primary} invalid />
        </View>
        <View className="lyx-cover-demo__scroll">
          <Cover variant="scroll" title="无名之辈" />
        </View>
      </Demo>
      <Demo title="缩略图：60 × 80 与 42 × 56" row>
        <Cover variant="thumb" title="巷口那家店" color={color.primary} />
        <Cover variant="thumb" title="巷口那家店" src={sample} />
        <Cover variant="thumb-sm" title="山那边的信" color={color.info} />
        <Cover variant="thumb-sm" title="旧时光" color={color.success} />
        <Cover variant="thumb-sm" title="巷口那家店" src={sample} invalid />
      </Demo>
      <CoverRecoveryPreview />
    </>
  );
}
