import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@liyoxi/db";
import { connectTestDatabase, useSeededDatabase } from "../testing/index.js";
import { buildHarness, META, nextOpenid, openClient } from "./__fixtures__/harness.js";
import type { Harness, Stack } from "./__fixtures__/harness.js";
import { dormantWorld } from "./__fixtures__/dormant-login.js";

const db = useSeededDatabase("services", { label: "dormantrace", max: 1 });
let h: Harness, clients: PrismaClient[], sides: Stack[], pids: number[];
beforeAll(async () => {
  h = await buildHarness(await db.prisma());
  clients = await Promise.all([openClient(db), openClient(db)]);
  sides = clients.map((client) => h.stackOn(client));
  pids = await Promise.all(
    clients.map(async (client) => {
      const [row] = await client.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      if (!row) throw new Error("独立业务连接没有PID");
      return row.pid;
    }),
  );
  expect(new Set(pids).size).toBe(2);
}, 120_000);
afterAll(async () => {
  await Promise.all(clients.map((client) => client.$disconnect()));
});
function gate() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { enter, release, entered, held };
}
async function race(
  hold: ReturnType<typeof gate>,
  firstAction: () => Promise<unknown>,
  secondAction: () => Promise<unknown>,
) {
  const observer = await connectTestDatabase(db.name, { role: null });
  let first: Promise<PromiseSettledResult<unknown>[]> | undefined,
    second: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await observer.query("SET default_transaction_read_only=on");
    first = Promise.allSettled([firstAction()]);
    await Promise.race([
      hold.entered,
      first.then(() => {
        throw new Error("首事务未进入真实处置栅栏");
      }),
    ]);
    second = Promise.allSettled([secondAction()]);
    let seen = false;
    const until = Date.now() + 2_000;
    do {
      const result = await observer.query<{ blocked: boolean }>(
        "SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked",
        [pids[1], pids[0]],
      );
      if (result.rows[0]?.blocked) {
        seen = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    } while (Date.now() < until);
    expect(seen).toBe(true);
    hold.release();
    const results = [(await first)[0]!, (await second)[0]!];
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  } finally {
    hold.release();
    await first;
    await second;
    await observer.end();
    vi.restoreAllMocks();
  }
}
describe("休眠登录：两个max1连接的真实锁竞争", { timeout: 120_000 }, () => {
  it.each(["clerk", "owner"] as const)(
    "%s 两个新绑定三轮：仅一次生命周期，第二登录锁后读取无成员",
    async (role) => {
      for (let round = 0; round < 3; round++) {
        const w = await dormantWorld(h, role),
          hold = gate(),
          left = sides[0]!,
          right = sides[1]!;
        if (role === "clerk") {
          const real = left.tenant.removeMemberIn;
          vi.spyOn(left.tenant, "removeMemberIn").mockImplementation(async (...args) => {
            const result = await real(...args);
            hold.enter();
            await hold.held;
            return result;
          });
        } else {
          const real = left.tenant.abandonDraftIn;
          vi.spyOn(left.tenant, "abandonDraftIn").mockImplementation(async (...args) => {
            const result = await real(...args);
            hold.enter();
            await hold.held;
            return result;
          });
        }
        const login = (side: Stack) =>
          side.identity.phoneLogin(META, {
            ...h.codes({ phone: w.phone, openid: nextOpenid() }),
            consents: h.consents(),
          });
        await race(
          hold,
          () => login(left),
          () => login(right),
        );
        expect(
          await h.prisma.entityMember.findUniqueOrThrow({ where: { id: w.member.id } }),
        ).toMatchObject({
          status: "removed",
          removeReason: role === "clerk" ? "dormant" : "draft_abandoned",
        });
        expect(await h.prisma.statusTransition.count({ where: { subjectId: w.member.id } })).toBe(
          1,
        );
        expect(await h.prisma.outboxEvent.count({ where: { aggregateId: w.member.id } })).toBe(1);
        expect(await h.prisma.wechatIdentity.count({ where: { merchantUserId: w.user.id } })).toBe(
          3,
        );
        expect(
          await h.prisma.userSession.count({
            where: { merchantUserId: w.user.id, revokedAt: null },
          }),
        ).toBe(3);
        expect(
          await h.prisma.agreementConsent.count({ where: { merchantUserId: w.user.id } }),
        ).toBe(2);
        expect(
          await h.prisma.authEvent.count({
            where: { subjectId: w.user.id, event: "reverify_required" },
          }),
        ).toBe(0);
      }
    },
  );

  it("老板移除先持主体锁三轮：新登录等锁后走无成员放行，不二次休眠移除", async () => {
    for (let round = 0; round < 3; round++) {
      const w = await dormantWorld(h, "clerk"),
        hold = gate(),
        left = sides[0]!,
        right = sides[1]!;
      await race(
        hold,
        () =>
          left.tx.run(async (tx) => {
            await left.tenant.removeMemberIn(tx, w.ownerCtx, {
              kind: "owner_remove",
              memberId: w.member.id,
            });
            hold.enter();
            await hold.held;
          }),
        () =>
          right.identity.phoneLogin(META, {
            ...h.codes({ phone: w.phone, openid: nextOpenid() }),
            consents: h.consents(),
          }),
      );
      expect(
        await h.prisma.entityMember.findUniqueOrThrow({ where: { id: w.member.id } }),
      ).toMatchObject({ status: "removed", removeReason: "by_owner", displayName: "店员关系称呼" });
      expect(await h.prisma.statusTransition.count({ where: { subjectId: w.member.id } })).toBe(1);
      expect(
        await h.prisma.authEvent.count({ where: { subjectId: w.user.id, event: "login_success" } }),
      ).toBe(1);
    }
  });
});
