import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { M5Support } from "@liyoxi/services/testing";
import type { M1SampleHookContext, M1SampleTarget } from "./runner.js";
import type { M5Call } from "./m5-http.js";
import { expectM5Failure, uploadM5Object } from "./m5-http.js";
import { makeM5AdVersion } from "./m5-ad.js";
import type { M5Actors, M5AdState } from "./m5-ad.js";

const image = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4o8AAAAASUVORK5CYII=",
    "base64",
  ),
);
async function screenshot(
  call: M5Call,
  support: M5Support,
  context: M1SampleHookContext,
  client: "merchant" | "staff",
) {
  const file =
    client === "merchant"
      ? (
          await call("m.file.create", context.owner.headers, {
            body: {
              category: "ticket_attachment",
              files: [
                {
                  fileName: "m5-feedback.png",
                  sizeBytes: String(image.length),
                  clientToken: randomUUID(),
                },
              ],
            },
          })
        ).items[0]!
      : await call("admin.file.create", context.admin.headers, {
          body: {
            category: "ticket_attachment",
            storeId: context.owner.storeId,
            fileName: "m5-staff-feedback.png",
            sizeBytes: String(image.length),
            clientToken: randomUUID(),
          },
        });
  await uploadM5Object(support, file, image);
  if (client === "merchant")
    await call("m.file.complete", context.owner.headers, {
      params: { fileId: file.fileId },
      body: {},
    });
  else
    await call("admin.file.complete", context.admin.headers, {
      params: { fileId: file.fileId },
      body: {},
    });
  await support.promote(file.fileId);
  return file.fileId;
}

export async function runM5Sample(
  call: M5Call,
  support: M5Support,
  context: M1SampleHookContext,
  actors: M5Actors,
  ad: M5AdState,
): Promise<{ target: M1SampleTarget; versions: number[] }> {
  const { api, admin, owner, scope, helpers } = context;
  const sampleParams = { orderItemId: scope.orderItemId };
  const versions = [context.sample.versionNo];
  const first = await call("m.orderItem.sample.get", owner.headers, { params: sampleParams });
  assert.equal(first.sampleId, context.sample.sampleId);
  assert.deepEqual(first.adsUsed, [{ slot: "opening", adId: ad.adId, versionNo: ad.versionNo }]);
  await expectM5Failure(
    api,
    `/api/v1/m/samples/${first.sampleId}/confirm`,
    owner.headers,
    { versionNo: first.versionNo, viewedVia: "weapp", hasViewed: false },
    400,
    "VALIDATION_FAILED",
    `m5-${support.runId}-unviewed`,
  );
  const merchantImage = await screenshot(call, support, context, "merchant");
  const staffImage = await screenshot(call, support, context, "staff");
  const nextSample = async () => {
    const fileId = await helpers.productionFile("sample_video", 1);
    const created = await call("admin.deliveryTicket.sample.create", admin.headers, {
      params: { deliveryTicketId: scope.deliveryTicketId },
      body: { fileId, adSlots: [{ slot: "opening", startMs: 0, endMs: 3000, label: "广告" }] },
    });
    await call("admin.sample.inspect", context.reviewer.headers, {
      params: { sampleId: created.sampleId },
      body: await helpers.checks("qc.sample"),
    });
    await call("admin.sample.push", admin.headers, {
      params: { sampleId: created.sampleId },
      body: {},
    });
    versions.push(created.versionNo);
    return created;
  };
  const walletBefore = await call("m.wallet.get", owner.headers);
  const merchantChanged = await call("m.sample.requestChange", owner.headers, {
    key: `m5-${support.runId}-merchant-compose`,
    params: { sampleId: first.sampleId },
    body: {
      feedbackKind: "compose",
      note: "片尾字幕请上移，保留门店信息",
      imageFileIds: [merchantImage],
    },
  });
  assert.equal(merchantChanged.ticketStep, "sample_making");
  assert.equal(merchantChanged.decision?.isOnBehalf, false);
  const second = await nextSample();
  await expectM5Failure(
    api,
    `/api/v1/m/samples/${first.sampleId}/confirm`,
    owner.headers,
    { versionNo: first.versionNo, viewedVia: "weapp", hasViewed: true },
    409,
    "SAMPLE_VERSION_STALE",
    `m5-${support.runId}-stale`,
  );
  const staffChanged = await call("admin.sample.requestChange", admin.headers, {
    key: `m5-${support.runId}-staff-compose`,
    params: { sampleId: second.sampleId },
    body: {
      versionNo: second.versionNo,
      feedbackKind: "compose",
      note: "商家电话确认字幕需要再上移",
      feedbackTimeMs: 1000,
      feedbackFileIds: [staffImage],
    },
  });
  assert.equal(staffChanged.status, "change_requested");
  assert.equal(staffChanged.decision?.feedbackTimeMs, 1000);
  const third = await nextSample();
  const beforeAd = await call("m.ad.get", owner.headers, { params: { adId: ad.adId } });
  const changedAd = await call("admin.sample.requestChange", admin.headers, {
    key: `m5-${support.runId}-ad-feedback`,
    params: { sampleId: third.sampleId },
    body: {
      versionNo: third.versionNo,
      feedbackKind: "ad_content",
      adId: ad.adId,
      note: "修正片头广告的门店文案",
      feedbackTimeMs: 500,
      feedbackFileIds: [staffImage],
    },
  });
  // a05 sample feedback: ad_content invalidates this sample while retaining its decision.
  assert.equal(changedAd.status, "superseded");
  assert.equal(changedAd.decision?.feedbackKind, "ad_content");
  assert.equal(changedAd.decision?.feedbackTimeMs, 500);
  assert.equal(changedAd.decision?.onBehalfBy?.staffId, admin.staffId);
  const invalidated = await support.readM5Facts({ ...scope, adIds: [ad.adId] });
  const oldSample = invalidated.samples.find((row) => row.id === third.sampleId);
  assert.ok(oldSample);
  assert.equal(oldSample.status, "superseded");
  assert.equal(oldSample.feedbackKind, "ad_content");
  assert.equal(
    invalidated.tickets.find((row) => row.id === scope.deliveryTicketId)?.step,
    "ad_prep",
  );
  assert.ok(
    invalidated.history.some(
      (row) =>
        row.subjectId === third.sampleId &&
        row.event === "sample.change_requested" &&
        row.toState === "superseded",
    ),
  );
  const reopened = await call("m.ad.get", owner.headers, { params: { adId: ad.adId } });
  assert.equal(reopened.status, "revising");
  const revision = reopened.revisions[0];
  assert.ok(revision);
  assert.equal(revision.source, "sample_feedback");
  assert.equal(revision.chargePoints, 0);
  assert.equal(reopened.revisionCount, beforeAd.revisionCount + 1);
  assert.equal(reopened.freeRevisionsRemaining, Math.max(0, beforeAd.freeRevisionsRemaining - 1));
  ad.versionNo = await makeM5AdVersion(
    call,
    support,
    context,
    actors,
    ad.adId,
    `m5-${support.runId}-ad-v2`,
  );
  assert.ok(ad.versionNo >= 2);
  const fourth = await nextSample();
  const current = await call("m.orderItem.sample.get", owner.headers, { params: sampleParams });
  assert.equal(current.sampleId, fourth.sampleId);
  assert.deepEqual(current.adsUsed, [{ slot: "opening", adId: ad.adId, versionNo: ad.versionNo }]);
  const walletAfter = await call("m.wallet.get", owner.headers);
  assert.equal(walletAfter.points.spendablePoints, walletBefore.points.spendablePoints);
  assert.equal(walletAfter.points.heldPoints, walletBefore.points.heldPoints);
  return { target: { sampleId: fourth.sampleId, versionNo: fourth.versionNo }, versions };
}
