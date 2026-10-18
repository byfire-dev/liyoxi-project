import { latestStaffWecomInviteKey } from "../audit/index.js";
import type { PrismaClient } from "@liyoxi/db";
import type { StaffRoleKey } from "@liyoxi/contract";
import { createConfig } from "../config/index.js";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import { createIdentityContext, createTxRunner, staffWorkSourcesOf } from "../kernel/index.js";
import { createSla } from "../sla/index.js";
import { createTimers } from "../timers/index.js";
import { sendStaffWecomInvite } from "../notify/index.js";
import { readUnassignedStoreOrderIds, syncUnassignedStoreOrders } from "../order/index.js";
import { assembleForTest } from "./assembly.js";
import { createClock } from "./clock.js";
import { createFactories, TEST_KEYRING } from "./data/index.js";
import { sampleStaffContext } from "./approval.js";
import { createStaffAssembly } from "../staff/index.js";
import type { StaffManagementDeps } from "../staff/index.js";

export async function fullStaffWorld(prisma: PrismaClient) {
  const clock = createClock();
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const scope = createStaffAssembly(assembleForTest({ entry: "api" }));
  const assembly = scope.assembly;
  const events = createEvents({ assembly, clock, tx });
  const flow = createFlow({ assembly, events, clock });
  const timers = createTimers({ assembly });
  const sla = createSla({ assembly, clock });
  const make = createFactories({ db: prisma, clock });
  const config = createConfig({ db: prisma, clock, redis: null });
  const deps: StaffManagementDeps = {
    tx,
    clock,
    flow,
    config,
    events,
    sla,
    timers,
    keyring: () => TEST_KEYRING,
    workSources: staffWorkSourcesOf(assembly),
    storeManagerOrders: {
      readUnassignedIds: readUnassignedStoreOrderIds,
      syncUnassigned: syncUnassignedStoreOrders,
    },
    sendActivation: async () => ({ status: "failed" }),
    sendWecomInvite: (input) =>
      tx.run(async (t) =>
        sendStaffWecomInvite(t, {
          staffId: input.staffId,
          invitationKey:
            (await latestStaffWecomInviteKey(t, input.staffId)) ?? input.createdAt.toISOString(),
          now: clock.now(),
        }),
      ),
  };
  const service = scope.attach(deps);
  const person = async (roleKey: StaffRoleKey, isLead = true) => {
    const group = await prisma.staffGroup.findFirstOrThrow({
      where: { staffRoleKey: roleKey, isDefault: true },
    });
    return make.staff({ staffRoleKey: roleKey, staffGroupId: group.id, isLead });
  };
  const operator = await person("super_admin");
  const ctx = await sampleStaffContext(prisma, operator.id, { stepUpAt: clock.now() });
  const actor = createIdentityContext({
    actor: { type: "staff", id: operator.id, client: "admin" },
  });
  return {
    prisma,
    tx,
    clock,
    assembly,
    scope,
    events,
    flow,
    timers,
    sla,
    make,
    deps,
    service,
    person,
    operator,
    ctx,
    actor,
  };
}
export type FullStaffWorld = Awaited<ReturnType<typeof fullStaffWorld>>;
