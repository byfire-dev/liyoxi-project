import type { PrismaClient } from "@liyoxi/db";
import { STAFF_ROLE_DEFAULTS, defaultRoleActions } from "@liyoxi/contract";
import { buildStaffContext, normalizeRoleConfig } from "../../authz/index.js";
import { createEvents } from "../../events/index.js";
import {
  createIdentityContext,
  createIdempotencyContext,
  createTxRunner,
  uuidv7,
} from "../../kernel/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  createBatchMediaForTest,
} from "../../testing/index.js";
import type { Media, MediaActor } from "../index.js";
import { fileCategoryGuardPort, fileRefTypePort } from "../ports.js";
import { createBatchWorkerHooks } from "./worker.js";
import type { MediaProductionDeps } from "../production-types.js";

export const MP4_HEADER = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
export const batchDraft = (name: string, token = uuidv7()) => ({
  clientToken: token,
  originalName: name,
  sizeBytes: String(MP4_HEADER.length),
});
export async function batchHarness(
  prisma: PrismaClient,
  production?: (fake: ReturnType<typeof createFakeProviders>) => MediaProductionDeps,
) {
  const clock = createClock(),
    make = createFactories({ db: prisma, clock });
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const assembly = assembleForTest({ entry: "worker" });
  const events = createEvents({ assembly, clock, tx });
  const fake = createFakeProviders({ clock });
  const media: Media = createBatchMediaForTest({
    tx,
    clock,
    assembly,
    events,
    storage: fake.storage,
    ...(production ? { production: production(fake) } : {}),
  });
  const row = await make.staff({ staffRoleKey: "super_admin" });
  const role = STAFF_ROLE_DEFAULTS.find((item) => item.key === "super_admin")!;
  const actor: MediaActor = {
    identity: createIdentityContext({ actor: { type: "staff", id: row.id, client: "admin" } }),
    staff: buildStaffContext({
      staff: { id: row.id, roleKey: "super_admin", isLead: true, staffGroupId: null },
      role: normalizeRoleConfig("super_admin", {
        moduleLevels: role.moduleLevels,
        dataScope: role.dataScope,
        actions: defaultRoleActions("super_admin"),
      }),
      groupStaffIds: [],
      stepUpAt: null,
    }),
  };
  const drama = await make.drama({ totalEpisodes: 20 });
  for (let episodeNo = 1; episodeNo <= 20; episodeNo++)
    await make.dramaEpisode({ dramaId: drama.id, episodeNo });
  const body = (files = [batchDraft("第1集.mp4")], scope: "full" | "partial" = "partial") => ({
    purpose: "drama_master",
    targetId: drama.id,
    scope,
    files,
  });
  const options = (operation: string, requestBody: unknown, key = uuidv7(), target = "") => ({
    idem: createIdempotencyContext({
      mode: "required",
      scope: `admin.uploadBatch.${operation}`,
      actor: actor.identity.actor,
      key,
      request: { method: "POST", pathParams: target ? { id: target } : {}, body: requestBody },
    }),
  });
  const create = (
    files = [batchDraft("第1集.mp4")],
    scope: "full" | "partial" = "partial",
    key = uuidv7(),
  ) => {
    const draft = body(files, scope);
    return media.uploadBatches.create(actor, draft, options("create", draft, key));
  };
  const worker = createBatchWorkerHooks({
    tx,
    clock,
    assembly,
    events,
    storage: fake.storage,
    refTypes: assembly.portEntries(fileRefTypePort),
    guards: assembly.portEntries(fileCategoryGuardPort),
  });
  return { prisma, clock, make, tx, fake, media, worker, actor, drama, body, options, create };
}
