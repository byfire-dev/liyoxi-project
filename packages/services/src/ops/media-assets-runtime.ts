import { AppError } from "../kernel/index.js";
import type { Assembly, Clock } from "../kernel/index.js";
import { createSla } from "../sla/index.js";
import type { Timers } from "../timers/index.js";
import type { Providers } from "../providers/types.js";
import type { Media, MediaAssetsDeps } from "../media/index.js";
import { readStoreAssetFacts, readAssetMerchantUploader } from "../tenant/index.js";
import { staffBriefs } from "../staff/index.js";
import { readAdAssetUsage, hasAssetEditingAd } from "../ad/index.js";
import { readOrderAssetUsage } from "../order/index.js";
import { readEpisodeAssetOrder, hasAssetEditingTicket } from "../delivery/index.js";
import { recordAssetUpload } from "../analytics/index.js";

/** L4 joins owner-exposed facts. No peer-owned table or global runtime binding is used. */
export function createRuntimeMediaAssets(input: {
  assembly: Assembly;
  clock: Clock;
  timers: Timers;
  providers: Providers;
  modelBudget?: MediaAssetsDeps["modelBudget"];
}): MediaAssetsDeps {
  return {
    sla: createSla({ assembly: input.assembly, clock: input.clock }),
    timers: input.timers,
    asr: input.providers.asr,
    llm: input.providers.llm,
    ...(Object.hasOwn(input, "modelBudget") ? { modelBudget: input.modelBudget } : {}),
    readStore: readStoreAssetFacts,
    readUploader: async (tx, actor) => {
      if (actor.actorType === "merchant")
        return {
          displayName: await readAssetMerchantUploader(tx, {
            entityId: actor.entityId,
            merchantUserId: actor.actorId,
          }),
          staff: null,
        };
      if (actor.actorType !== "staff") return { displayName: null, staff: null };
      const staff = (await staffBriefs(tx, [actor.actorId]))[0] ?? null;
      return { displayName: staff?.name ?? null, staff };
    },
    readUsage: async (tx, usage) => {
      if (usage.usedByType === "ad" || usage.usedByType === "ad_version")
        return readAdAssetUsage(tx, usage);
      if (usage.usedByType !== "episode_output") return readOrderAssetUsage(tx, usage);
      const orderId = await readEpisodeAssetOrder(tx, usage);
      return orderId
        ? readOrderAssetUsage(tx, { ...usage, usedByType: "drama_order", usedById: orderId })
        : null;
    },
    canReadEditingAsset: async (tx, actor) =>
      (await hasAssetEditingAd(tx, actor)) || (await hasAssetEditingTicket(tx, actor)),
    recordUpload: (tx, actor, props) =>
      recordAssetUpload(tx, { ...props, actor: actor.identity.actor, now: input.clock.now() }),
    checkDemandText: async (fields) => {
      for (const [field, text] of Object.entries(fields)) {
        if (!text) continue;
        const result = await input.providers.media.auditText({
          bucket: "asset",
          text,
          userData: "asset_demand",
        });
        if (!result.ok || !result.value.processed) throw new AppError("PROVIDER_UNAVAILABLE");
        if (result.value.verdict !== "pass")
          throw new AppError("CONTENT_REJECTED", { details: { fields: [field] } });
      }
    },
  };
}

/** Only this media subscriber and store_asset SLA branch acquire instance dependencies. */
export function createMediaAssetsAssembly(base: Assembly) {
  let media: Pick<Media, "onAssetCalendarImported" | "onAssetSlaBreach"> | undefined;
  let closed = false;
  const current = () => {
    if (closed || !media) throw new TypeError("素材运行时尚未绑定或已经关闭");
    return media;
  };
  const subscribers = base.subscribers.map((item) =>
    item.name === "media.onCalendarImported"
      ? {
          ...item,
          handle: (
            tx: Parameters<typeof item.handle>[0],
            event: Parameters<typeof item.handle>[1],
          ) => current().onAssetCalendarImported(tx, event),
        }
      : item,
  );
  const timerHandlers = base.timerHandlers.map((item) =>
    item.kind === "sla.breach"
      ? {
          ...item,
          handle: (
            tx: Parameters<typeof item.handle>[0],
            timer: Parameters<typeof item.handle>[1],
          ) =>
            timer.subjectType === "store_asset"
              ? current().onAssetSlaBreach(tx, timer)
              : item.handle(tx, timer),
        }
      : item,
  );
  const subscriberIndex = new Map(subscribers.map((item) => [item.name, item]));
  const timerIndex = new Map(timerHandlers.map((item) => [item.kind, item]));
  return {
    assembly: {
      ...base,
      subscribers,
      timerHandlers,
      subscriber: (name: string) => subscriberIndex.get(name),
      timerHandler: (kind: string) => timerIndex.get(kind),
    },
    attach(service: NonNullable<typeof media>) {
      if (closed || media) throw new TypeError("素材运行时只能绑定一次");
      media = service;
    },
    close() {
      closed = true;
    },
  };
}
