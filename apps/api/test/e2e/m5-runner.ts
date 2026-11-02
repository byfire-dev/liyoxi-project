// One M5 HTTP chain for both the isolated e2e and same-intent demo. No database access here.
import assert from "node:assert/strict";
import type { M5Support, M5Scope } from "@liyoxi/services/testing";
import type { M1Api } from "./in-process.js";
import { runM1Chain } from "./runner.js";
import type { M1ChainReport } from "./runner.js";
import { createM5Http } from "./m5-http.js";
import { activateM5Actors, prepareM5Ad } from "./m5-ad.js";
import type { M5Actors, M5AdState } from "./m5-ad.js";
import { runM5Sample } from "./m5-sample.js";
import { runM5TicketActions, runM5Reissue, verifyM5Letters } from "./m5-delivery.js";
import { runM5Cancellation } from "./m5-cancel.js";

export interface M5ChainReport extends M1ChainReport {
  readonly m5: {
    readonly adVersionNo: number;
    readonly sampleVersionNo: number;
    readonly sampleVersions: readonly number[];
    readonly licenseRevNo: number;
    readonly cancelStatus: "done";
    readonly cancelRefundPoints: number;
    readonly reissueStatus: "published";
    readonly reissueCount: number;
    readonly recordedWriteCount: number;
    readonly replayedWriteCount: number;
    readonly docsSubscriber: {
      readonly name: "docs.onRevisionQueued";
      readonly done: number;
      readonly ready: number;
    };
  };
}
export interface M5AfterCore {
  readonly scope: M5Scope;
  readonly replaySameIntent: () => Promise<void>;
}
export async function runM5Chain(input: {
  readonly api: M1Api;
  readonly support: M5Support;
  readonly say?: (message: string) => void;
  readonly afterCore?: (context: M5AfterCore) => Promise<void>;
}): Promise<M5ChainReport> {
  assert.equal(input.api.support, input.support);
  const { support, say = () => {} } = input;
  const http = createM5Http(input.api);
  const call = http.call;
  let actors: M5Actors | undefined;
  let ad: M5AdState | undefined;
  let sampleVersions: number[] = [];
  let finalScope: M5Scope | undefined;
  let licenseRevNo = 0;
  let cancellation: Awaited<ReturnType<typeof runM5Cancellation>> | undefined;
  let reissue: Awaited<ReturnType<typeof runM5Reissue>> | undefined;
  const base = await runM1Chain({
    api: http.api,
    support,
    say,
    beforeOrder: async (context) => {
      say("M5真实广告报价、冻结、退回重提、本人制作与确认");
      actors = await activateM5Actors(context);
      const prepared = await prepareM5Ad(call, support, context, actors);
      ad = prepared.state;
      return prepared.order;
    },
    beforeSampleConfirm: async (context) => {
      assert.ok(actors && ad);
      say("M5商家与经理真实样片修改、免费广告重开及新版本确认");
      const result = await runM5Sample(call, support, context, actors, ad);
      sampleVersions = result.versions;
      return result.target;
    },
    beforeEpisodes: async (context) => {
      assert.ok(actors && ad);
      say("M5真实指派、改期、取消暂停与撤回恢复");
      await runM5TicketActions(call, support, context, actors);
    },
    afterChain: async (context) => {
      assert.ok(actors && ad);
      const scope = { ...context.scope, adIds: [ad.adId] };
      say("M5授权当前版、无变化更正校验与现签PDF文件证明");
      licenseRevNo = await verifyM5Letters(call, support, context, scope);
      say("M5补发取消重建、替换件实际质检与发布");
      reissue = await runM5Reissue(call, support, context, scope);
      say("M5独立订购异人审批执行及积分账本实际读回");
      cancellation = await runM5Cancellation(call, support, context, actors);
      finalScope = { ...scope, cancelRequestId: cancellation.id };
      await support.drainEvents();
      await input.afterCore?.({ scope: finalScope, replaySameIntent: http.replaySameIntent });
      const final = await support.readState(context.scope);
      assert.equal(final.order?.status, "live");
      assert.equal(final.item?.phase, "live");
      assert.equal(final.ticket?.step, "in_service");
      assert.equal(final.wallet?.heldTotalQty, 0);
      assert.equal(final.items.filter((item) => item.phase === "live").length, 1);
    },
  });
  assert.ok(finalScope && ad && cancellation && reissue);
  const actual = await support.readState(finalScope);
  assert.equal(actual.order?.status, "live");
  assert.equal(actual.item?.phase, "live");
  assert.equal(actual.ticket?.step, "in_service");
  const proof = await support.readM5Facts(finalScope);
  const consumed = proof.docsDeliveries.filter(
    (row) => row.status === "done" && row.consumedAt !== null && row.dispatchNo > 0,
  );
  const ready = consumed.filter((row) => {
    const file = proof.files.find((candidate) => candidate.id === row.revisionFileId);
    return (
      row.revisionRenderStatus === "ready" &&
      row.revisionReadyAt !== null &&
      row.revisionPdfSha256 !== null &&
      file?.status === "stored" &&
      file.category === "legal_doc" &&
      file.sha256 === row.revisionPdfSha256
    );
  });
  assert.ok(consumed.length > 0, "M5 scope must consume actual queued revision events");
  assert.ok(ready.length > 0, "Consumed revision events must link to actual ready PDF files");
  assert.ok(consumed.every((row) => row.subscriber === "docs.onRevisionQueued"));
  const counts = http.counts();
  assert.ok(counts.replayedWrites > 0 && counts.recordedWrites > 0);
  return {
    ...base,
    final: {
      order: actual.order.status,
      item: actual.item.phase,
      ticket: actual.ticket.step,
      isLive: true,
    },
    spendablePoints: actual.wallet!.planAvailableQty + actual.wallet!.addonAvailableQty,
    m5: {
      adVersionNo: ad.versionNo,
      sampleVersionNo: sampleVersions.at(-1)!,
      sampleVersions,
      licenseRevNo,
      cancelStatus: cancellation.status,
      cancelRefundPoints: cancellation.refundPoints,
      reissueStatus: reissue.status,
      reissueCount: reissue.ids.length,
      recordedWriteCount: counts.recordedWrites,
      replayedWriteCount: counts.replayedWrites,
      docsSubscriber: { name: "docs.onRevisionQueued", done: consumed.length, ready: ready.length },
    },
  };
}
