import {
  createFactories,
  assembleForTest,
  createProviderHarness,
  createCodecDemoMasterPreparer,
} from "../testing/index.js";
import type { useSeededDatabase } from "../testing/index.js";
import type { Clock } from "../kernel/index.js";
import { createTxRunner } from "../kernel/index.js";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import { createMedia } from "../media/index.js";
import { createConfig } from "../config/index.js";
import { createContent, createContentLicense, bindContent } from "./index.js";
import { createTimers } from "../timers/index.js";
export async function buildContentTest(db: ReturnType<typeof useSeededDatabase>, clock: Clock) {
  const prisma = await db.prisma(),
    tx = createTxRunner({ prisma, appEnv: "test" }),
    assembly = assembleForTest({ entry: "worker" }),
    events = createEvents({ tx, clock, assembly }),
    flow = createFlow({ clock, assembly, events }),
    providers = createProviderHarness({ clock }).providers,
    media = createMedia({ tx, clock, assembly, events, storage: providers.storage }),
    timers = createTimers({ assembly }),
    license = createContentLicense({ clock, flow, timers }),
    content = createContent({ clock, assembly, flow, media, events, license }),
    config = createConfig({ db: prisma, clock, redis: null }),
    staff = await createFactories({ db: prisma, clock }).staff({ staffRoleKey: "content_ops" });
  const unbind = bindContent(assembly);
  return {
    prepareMasters: createCodecDemoMasterPreparer({ appEnv: "test", tx, clock, media, events }),
    unbind,
    prisma,
    tx,
    assembly,
    events,
    flow,
    media,
    content,
    staff,
    config,
    providers,
  };
}
