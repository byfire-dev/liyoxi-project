import {
  AdCreateBodySchema,
  AdQuoteBodySchema,
  AdListQuerySchema,
  AdSubmitBodySchema,
  AdPageSchema,
  AdDetailSchema,
} from "@liyoxi/contract";
import type { AdCreateBody, AdQuoteBody, AdListQuery, AdSubmitBody } from "@liyoxi/contract";
import type { IdempotencyContext } from "../kernel/index.js";
import { AppError, createThreePhaseRunner } from "../kernel/index.js";
import type { AdActor, AdWriteDeps } from "./context.js";
import { member, owner, merchantAd, noCancel } from "./lifecycle.js";
import { createAdTx } from "./create.js";
import { quoteAd } from "./quote.js";
import { resubmitAdTx } from "./resubmit.js";
import { stateResult, listAds, detailAd, signAdView } from "./read.js";
import { prepareAdDownload, settleAdDownload } from "./download.js";
export function createAdService(deps: AdWriteDeps) {
  const preflight = (actor: AdActor) => {
    owner(actor);
    return deps.tx.run((tx) => member(tx, actor));
  };
  return {
    async quote(actor: AdActor, input: AdQuoteBody) {
      owner(actor);
      return deps.tx.run((tx) => quoteAd(tx, deps, actor, AdQuoteBodySchema.parse(input)));
    },
    async create(actor: AdActor, input: AdCreateBody, options: { idem?: IdempotencyContext } = {}) {
      const b = AdCreateBodySchema.parse(input);
      await preflight(actor);
      return createThreePhaseRunner(deps).run(
        {
          claim: async (tx) => {
            await member(tx, actor);
          },
          external: async () => {
            await deps.moderate(
              actor,
              Object.fromEntries(
                Object.entries({ copy: b.copy, remark: b.remark }).filter(
                  (v): v is [string, string] => typeof v[1] === "string" && v[1].length > 0,
                ),
              ),
            );
          },
          settle: async (tx) => stateResult(tx, deps, actor, await createAdTx(tx, deps, actor, b)),
        },
        options,
      );
    },
    async list(actor: AdActor, input: AdListQuery) {
      owner(actor);
      const view = await deps.tx.run((tx) =>
        listAds(tx, deps, actor, AdListQuerySchema.parse(input)),
      );
      return AdPageSchema.parse({
        ...view,
        items: await Promise.all(view.items.map((v) => signAdView(deps, actor, v))),
      });
    },
    async get(actor: AdActor, adId: string) {
      owner(actor);
      const view = await deps.tx.run((tx) => detailAd(tx, deps, actor, adId));
      if (view._playableId) {
        const playable = await deps.readPlayable(actor, view._playableId);
        if (playable.kind !== "ad")
          throw new AppError("PLAYABLE_UNAVAILABLE", { details: { state: "not_ready" } });
        view.playable = { ...playable, kind: playable.kind };
      } else if (view.playable && view._playablePosterFileId)
        view.playable.posterUrl = (
          await deps.media.signRead({ fileId: view._playablePosterFileId })
        ).url;
      for (const ref of view.references)
        if (ref._thumbFileId) {
          const signed = await deps.media.signRead({ fileId: ref._thumbFileId });
          ref.thumbUrl = signed.url;
          ref.thumbExpiresAt = signed.expiresAt;
        }
      const publicView = await signAdView(deps, actor, view),
        { _playableId, _playablePosterFileId, ...rest } = publicView;
      const revisions = [];
      for (const r of rest.revisions) {
        const { screenshotFileIds, ...fields } = r;
        const screenshots = [];
        for (const fileId of screenshotFileIds)
          screenshots.push({ fileId, ...(await deps.media.signRead({ fileId })) });
        revisions.push({ ...fields, screenshots });
      }
      return AdDetailSchema.parse({
        ...rest,
        revisions,
        references: rest.references.map(({ _thumbFileId, ...ref }) => ref),
      });
    },
    async submit(
      actor: AdActor,
      adId: string,
      input: AdSubmitBody,
      options: { idem?: IdempotencyContext } = {},
    ) {
      const b = AdSubmitBodySchema.parse(input);
      await preflight(actor);
      return createThreePhaseRunner(deps).run(
        {
          claim: async (tx) => {
            await member(tx, actor);
            const ad = await merchantAd(tx, actor, adId);
            noCancel(ad);
            if (ad.status !== "returned") throw new AppError("STATE_NOT_ALLOWED");
          },
          external: () =>
            deps.moderate(
              actor,
              Object.fromEntries(
                Object.entries({ copy: b.copy, remark: b.remark }).filter(
                  (v): v is [string, string] => typeof v[1] === "string" && v[1].length > 0,
                ),
              ),
            ),
          settle: async (tx) =>
            stateResult(tx, deps, actor, await resubmitAdTx(tx, deps, actor, adId, b)),
        },
        options,
      );
    },
    async download(actor: AdActor, adId: string, input: { versionNo: number }) {
      owner(actor);
      const view = await deps.tx.run((tx) =>
        prepareAdDownload(tx, deps, actor, adId, input.versionNo),
      );
      const signed = await deps.media.signDeliveryDownload({
        fileId: view.fileId,
        fileName: view.fileName,
      });
      await deps.tx.run((tx) => settleAdDownload(tx, deps, actor, view));
      return { ...signed, fileName: view.fileName, sizeBytes: view.sizeBytes };
    },
  };
}
export type AdService = ReturnType<typeof createAdService>;
