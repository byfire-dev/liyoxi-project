import { copyTree, runCopyCheck } from "../lib/copy.mjs";
const PAGE = "apps/weapp/src/pages/mall/index.tsx";
export default {
  gate: "文案约束（lint:copy）",
  mutation: "商城按钮写热度",
  reason: /文案约束检查未通过[\s\S]*规则 catalog-no-heat：出现“热度”/,
  run(ctx) {
    return runCopyCheck(ctx, copyTree(ctx, { [PAGE]: "<View>热度</View>\n" }));
  },
};
