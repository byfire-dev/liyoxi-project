// 本机新增功能分段证明，不能替代 m2.e2e.test.ts 的完整链/90 秒或 CI 十连。
import { expect, it } from "vitest";
import { createM2Support } from "@liyoxi/services/testing";
import { createM1Api } from "./in-process.js";
import { runM1Chain } from "./runner.js";
import { prepareM2Lifecycle } from "./m2-lifecycle.js";
import { finishM2Stages } from "./m2-runner.js";
import { bootstrapM1Admin } from "./m1-auth.js";
import { loginM2Merchant } from "./m2-lifecycle.js";
import { createM1Caller } from "./runner-api.js";
import { verifyM2Ops } from "./m2-ops.js";

it("M2 分段：真实 HTTP 合法前置、生命周期、运输闭环及全量不变量", async () => {
  const support = await createM2Support();
  const segmentComplete = Symbol("M2 segment complete");
  let completed = false;
  process.stdout.write(`M2分段隔离资源：${support.databaseName}；${support.redisPrefix}\n`);
  try {
    try {
      await runM1Chain({
        api: createM1Api(support),
        support,
        uploadConcurrency: 1,
        say: (message) => process.stdout.write(`${message}\n`),
        async beforeOrder(context) {
          const lifecycle = await prepareM2Lifecycle(context, support);
          const report = await finishM2Stages(context, support, lifecycle, (message) =>
            process.stdout.write(`${message}\n`),
          );
          const invariants = await support.fullInvariants();
          expect(invariants).toMatchObject({ status: "succeeded", violationsFound: 0, errors: [] });
          expect(invariants.checksRun).toBeGreaterThan(0);
          expect(report.ops).toMatchObject({ timerRescheduled: true, deliveryRetried: true });
          expect(report.replay).toEqual({ invitations: true, seedsInserted: 0 });
          process.stdout.write(
            `M2分段完成：${JSON.stringify({ ...report, invariants: { checksRun: invariants.checksRun, violationsFound: invariants.violationsFound, errors: invariants.errors.length } })}\n`,
          );
          completed = true;
          // 仅诊断目标在公开钩子处结束；正式完整链仍继续二十集原链。
          throw segmentComplete;
        },
      });
    } catch (error) {
      if (error !== segmentComplete) throw error;
    }
    expect(completed).toBe(true);
  } finally {
    await support.close();
  }
}, 90_000);

it("M2 运维最小分段：真实邀请事件与到期、恢复审计及全量不变量", async () => {
  const support = await createM2Support();
  process.stdout.write(`M2运维隔离资源：${support.databaseName}；${support.redisPrefix}\n`);
  try {
    const api = createM1Api(support),
      call = createM1Caller(api);
    const admin = await bootstrapM1Admin(api);
    // 沿原公共种子提供现行协议；所有非空员工组同样遵循 staff.I6。
    await support.seedDemo();
    const members = (await call("admin.staff.list", admin.headers, { query: { limit: 100 } }))
      .items;
    for (const groupId of new Set(
      members.flatMap((member) => (member.staffGroup ? [member.staffGroup.staffGroupId] : [])),
    )) {
      const group = members.filter((member) => member.staffGroup?.staffGroupId === groupId);
      if (group.some((member) => member.status === "active" && member.isLead)) continue;
      const candidate = group.find((member) => member.status === "active");
      expect(candidate).toBeDefined();
      const detail = await call("admin.staff.get", admin.headers, {
        params: { staffId: candidate!.staffId },
      });
      await call("admin.staff.update", admin.headers, {
        params: { staffId: candidate!.staffId },
        body: { isLead: true, lockVersion: detail.lockVersion, ackNoLead: false },
      });
    }
    const owner = await loginM2Merchant(api, support, "13700000235");
    const membership = await call("m.entity.create", owner.headers, { body: {} });
    const entity = await call("admin.entity.get", admin.headers, {
      params: { entityId: membership.entityId },
    });
    await call("admin.entity.quota.update", admin.headers, {
      params: { entityId: membership.entityId },
      body: {
        storeLimitOverride: 2,
        memberLimitOverride: 4,
        lockVersion: entity.lockVersion,
        confirm: {
          storeLimitOverride: entity.usage.storeLimitOverride,
          memberLimitOverride: entity.usage.memberLimitOverride,
        },
        reasonText: "隔离运维最小段真实邀请前置",
      },
    });
    const report = await verifyM2Ops(
      api,
      support,
      admin,
      owner,
      membership.entityId,
      membership.storeId,
    );
    const invariants = await support.fullInvariants();
    expect(invariants).toMatchObject({ status: "succeeded", violationsFound: 0, errors: [] });
    expect(invariants.checksRun).toBeGreaterThan(0);
    expect(report).toMatchObject({
      timerFailures: 12,
      deliveryFailures: 10,
      timerRescheduled: true,
      deliveryRetried: true,
    });
    process.stdout.write(
      `M2运维分段完成：${JSON.stringify({ report, invariants: { checksRun: invariants.checksRun, violationsFound: invariants.violationsFound, errors: invariants.errors.length } })}\n`,
    );
  } finally {
    await support.close();
  }
}, 90_000);
