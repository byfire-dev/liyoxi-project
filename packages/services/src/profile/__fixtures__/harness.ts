import type { PrismaClient } from "@liyoxi/db";
import { createApproval } from "../../approval/index.js";
import { createEvents } from "../../events/index.js";
import { createFlow } from "../../flow/index.js";
import { createBizNoIssuer, createIdentityContext, createTxRunner } from "../../kernel/index.js";
import type { ModuleRegistration } from "../../kernel/index.js";
import { createMedia } from "../../media/index.js";
import { createTenant } from "../../tenant/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  TEST_KEYRING,
} from "../../testing/index.js";
import { createProfile } from "../service.js";
import type { ProfileViewer } from "../context.js";

export function harness(prisma: PrismaClient, extra: ModuleRegistration[] = []) {
  const clock = createClock(),
    tx = createTxRunner({ prisma, appEnv: "test" }),
    assembly = assembleForTest({ entry: "api", extra });
  const make = createFactories({ db: prisma, clock }),
    fake = createFakeProviders({ clock });
  const events = createEvents({ tx, clock, assembly }),
    flow = createFlow({ assembly, clock, events }),
    tenant = createTenant({ tx, clock, flow, assembly });
  const approval = createApproval({
    assembly,
    clock,
    flow,
    events,
    bizNo: createBizNoIssuer({ clock, appEnv: "test" }),
  });
  const media = createMedia({ tx, clock, assembly, events, storage: fake.storage });
  const profile = createProfile({
    tx,
    clock,
    assembly,
    tenant,
    approval,
    events,
    media: { link: media.link, release: media.release, signRead: media.signRead },
    keyring: () => TEST_KEYRING,
    wechat: fake.wechat,
    currentOpenid: async () => "lyxtest_profile_openid",
  });
  async function owner() {
    const user = await make.merchantUser();
    const entity = await make.entity({ createdByUserId: user.id });
    // 后台计费事实已接真实拥有者；与 tenant 建主体同样具备账户，不能靠未注册键补零。
    await make.billingAccount({ entityId: entity.id });
    const store = await make.store({ entityId: entity.id, isPrimary: true });
    const member = await make.entityMember({
      entityId: entity.id,
      merchantUserId: user.id,
      role: "owner",
    });
    const viewer: ProfileViewer = {
      ctx: createIdentityContext({
        actor: { type: "merchant", id: user.id, client: "weapp" },
        requestId: "req_profile",
      }),
      principal: {
        sessionId: user.id,
        merchantUserId: user.id,
        wechatIdentityId: user.id,
        consentStamp: "test",
      },
      membership: {
        memberId: member.id,
        entityId: entity.id,
        storeId: store.id,
        role: "owner",
        storeMode: "active",
      },
    };
    return { user, entity, store, member, viewer };
  }
  return { prisma, tx, clock, make, fake, events, flow, tenant, approval, media, profile, owner };
}
export type Harness = ReturnType<typeof harness>;

// Preserve existing profile-test imports while the shared prerequisites live in testing.
export {
  createQualificationFixtureUscc as uscc,
  installQualificationFixtureDicts as installDicts,
  createQualificationFixtureFile as ownedFile,
  completeQualificationFixture as complete,
  submitQualificationFixture as submit,
} from "../../testing/index.js";
