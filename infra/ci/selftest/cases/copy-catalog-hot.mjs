import { copyTree, runCopyCheck } from "../lib/copy.mjs";
const PAGE = "apps/weapp/src/pages/mall/index.tsx";
export default {
  gate: "文案约束（lint:copy）",
  mutation: "商城按钮写热播",
  reason: /文案约束检查未通过[\s\S]*规则 catalog-no-hot：出现“热播”/,
  run(ctx) {
    return runCopyCheck(ctx, copyTree(ctx, { [PAGE]: "<View>热播</View>\n" }));
  },
};
