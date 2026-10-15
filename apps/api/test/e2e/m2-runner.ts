import assert from "node:assert/strict";
import type { M2Support } from "@liyoxi/services/testing";
import type { M1Api } from "./in-process.js";
import { runM1Chain } from "./runner.js";
import type { M1ChainContext } from "./runner.js";
import { prepareM2Lifecycle, finishM2Lifecycle } from "./m2-lifecycle.js";
import type { M2Lifecycle } from "./m2-lifecycle.js";
import { verifyM2Messages, verifyM2Ops } from "./m2-ops.js";
import { createM2Http } from "./m2-http.js";

/** 与正式 afterChain 共用；本机分段证明只省去已经验过的二十集媒体段。 */
export async function finishM2Stages(
  context: M1ChainContext,
  support: M2Support,
  lifecycle: M2Lifecycle,
  say: (message: string) => void = () => {},
) {
  const { api } = context;
  say("M2 消息已读、未配订阅报告与真实埋点去重");
  const messages = await verifyM2Messages(api, support, context.owner.headers);
  const repeated = await createM2Http(api).call(
    "m.invitation.accept",
    lifecycle.clerk.headers,
    lifecycle.acceptInput,
  );
  assert.equal(repeated.memberId, lifecycle.joined.memberId);
  const seed = await support.seedDemo();
  assert.equal(seed.inserted, 0);
  say("M2 换绑、身份移除、人工老板更换、员工禁用移交与注销");
  const security = await finishM2Lifecycle(context, support, lifecycle);
  say("M2 真实运输失败、告警、HTTP 重调度/死信重投及恢复");
  const ops = await verifyM2Ops(
    api,
    support,
    context.admin,
    security.clerk,
    context.owner.entityId,
    context.owner.storeId,
  );
  return {
    lifecycle: { stores: 2, qualificationRounds: 3, invitedRole: lifecycle.joined.role },
    messages,
    security: {
      uniqueOwner: true,
      employeeDisabled: true,
      emptyAccountDeleted: true,
      paidDeletionBlockers: security.blocked,
    },
    ops,
    replay: { invitations: true as const, seedsInserted: seed.inserted },
  };
}

export async function runM2Chain(input: {
  api: M1Api;
  support: M2Support;
  say?: (message: string) => void;
}) {
  const { api, support, say = () => {} } = input;
  let lifecycle: M2Lifecycle | undefined;
  let completed: Awaited<ReturnType<typeof finishM2Stages>> | undefined;
  const chain = await runM1Chain({
    api,
    support,
    say,
    episodeCount: 20,
    // Air 本机单路；专用 CI 沿原 M1 四路，不改集数、断言或 90 秒判据。
    uploadConcurrency: process.env.CI === "true" ? 4 : 1,
    async beforeOrder(context) {
      say("M2 多门店额度、邀请店员、多轮资质与即时开关");
      lifecycle = await prepareM2Lifecycle(context, support);
      return [];
    },
    async afterChain(context) {
      assert.ok(lifecycle);
      completed = await finishM2Stages(context, support, lifecycle, say);
    },
  });
  assert.ok(completed);
  return { ...chain, ...completed };
}
