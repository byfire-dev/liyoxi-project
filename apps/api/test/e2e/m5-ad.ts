import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { M5Support } from "@liyoxi/services/testing";
import { activateM1Staff } from "./m1-auth.js";
import type { M1AuthenticatedStaff } from "./m1-auth.js";
import type { M1Api } from "./in-process.js";
import type { M1ChainContext, M1OrderHookResult } from "./runner.js";
import type { M5Call } from "./m5-http.js";
import { readM5Signed, uploadM5Object } from "./m5-http.js";

export interface M5Actors {
  readonly editor: M1AuthenticatedStaff;
  readonly publisher: M1AuthenticatedStaff;
  readonly finance: M1AuthenticatedStaff;
}
export interface M5AdState {
  readonly adId: string;
  readonly chargePoints: number;
  versionNo: number;
}

export async function activateM5Actors(context: M1ChainContext): Promise<M5Actors> {
  const activate = async (key: "editor" | "publisher" | "finance", phone: string, peer: string) => {
    const row = context.seededStaff?.find((staff) => staff.key === key);
    assert.ok(row?.activation, "M5 actors require this scope's original activation input");
    const api: M1Api = {
      ...context.api,
      request: (path, init) => context.api.request(path, { ...init, peer }),
    };
    return activateM1Staff(api, {
      phone,
      staffId: row.staffId,
      activationCode: row.activation.code,
    });
  };
  return {
    editor: await activate("editor", "19900000003", "198.19.5.13"),
    publisher: await activate("publisher", "19900000004", "198.19.5.14"),
    finance: await activate("finance", "19900000007", "198.19.5.17"),
  };
}

export async function createM5Publisher(call: M5Call, support: M5Support, context: M1ChainContext) {
  const phone = "19900000144";
  const created = await call("admin.staff.create", context.admin.headers, {
    key: `m5-${support.runId}-replacement-publisher`,
    body: {
      name: "M5独立发布员",
      phone,
      roleKey: "publisher",
      isLead: false,
      activateNow: true,
      activationDelivery: "manual",
      inviteWecom: false,
    },
  });
  assert.equal(created.staff.roleKey, "publisher");
  assert.equal(created.staff.status, "active");
  assert.ok(created.activation?.activationCode);
  const api: M1Api = {
    ...context.api,
    request: (path, init) => context.api.request(path, { ...init, peer: "198.19.5.44" }),
  };
  const actor = await activateM1Staff(api, {
    phone,
    staffId: created.staff.staffId,
    activationCode: created.activation.activationCode,
  });
  // The original M1 setup already gives each active group a lead. Read the actual membership
  // after activating M5 actors and this extra assignee; do not bypass staff.I6 in full.
  const listed = await call("admin.staff.list", context.admin.headers, { query: { limit: 100 } });
  for (const groupId of new Set(
    listed.items.flatMap((row) => (row.staffGroup ? [row.staffGroup.staffGroupId] : [])),
  ))
    assert.ok(
      listed.items.some(
        (row) => row.staffGroup?.staffGroupId === groupId && row.status === "active" && row.isLead,
      ),
      "M5 keeps an actual active lead in every nonempty group",
    );
  return actor;
}

export async function makeM5AdVersion(
  call: M5Call,
  support: M5Support,
  context: M1ChainContext,
  actors: M5Actors,
  adId: string,
  intent: string,
) {
  const file = await call("admin.file.create", actors.editor.headers, {
    key: `${intent}-file`,
    body: {
      category: "ad_video",
      storeId: context.owner.storeId,
      fileName: "m5-real-ad.mp4",
      sizeBytes: String(support.adVideo.sizeBytes),
      clientToken: randomUUID(),
      production: { kind: "ad", adId, aiUsage: { used: false, tools: [] } },
    },
  });
  await uploadM5Object(support, file, support.adVideo.bytes);
  await call("admin.file.complete", actors.editor.headers, {
    params: { fileId: file.fileId },
    body: {},
  });
  await support.finishAdProduction(file.fileId, {
    adId,
    entityId: context.owner.entityId,
    storeId: context.owner.storeId,
    uploaderId: actors.editor.staffId,
  });
  const registered = await call("admin.ad.adVersion.create", actors.editor.headers, {
    key: `${intent}-version`,
    params: { adId },
    body: {
      fileId: file.fileId,
      segments: [{ index: 0, fromMs: 0, toMs: 3000, label: "整条广告" }],
    },
  });
  const version = registered.versions.find((row) => row.fileId === file.fileId);
  assert.ok(version);
  assert.equal(version.width, 1080);
  assert.equal(version.height, 1920);
  assert.ok(Math.abs(version.durationMs - 3000) <= 50);
  await call("admin.adVersion.markSent", context.admin.headers, {
    key: `${intent}-sent`,
    params: { adVersionId: version.adVersionId },
    body: {},
  });
  const pushed = await call("admin.adVersion.push", actors.editor.headers, {
    key: `${intent}-push`,
    params: { adVersionId: version.adVersionId },
    body: { includeWecom: true },
  });
  assert.equal(pushed.status, "pending_confirm");
  const current = await call("m.ad.get", context.owner.headers, { params: { adId } });
  assert.equal(current.currentVersion?.versionNo, version.versionNo);
  let viewedVia: "weapp" | "album";
  if (current.confirmableVia.includes("weapp")) {
    const source = current.playable?.sources[0];
    assert.ok(source, "M5 actual weapp channel must provide the current playable bytes");
    await readM5Signed(support, source.url, support.adVideo);
    viewedVia = "weapp";
  } else {
    assert.ok(current.confirmableVia.includes("album") && current.alternatives.canSaveToAlbum);
    const download = await call("m.ad.downloadUrls", context.owner.headers, {
      params: { adId },
      body: { versionNo: version.versionNo },
    });
    await readM5Signed(support, download.url, support.adVideo);
    viewedVia = "album";
  }
  const confirmed = await call("m.ad.confirm", context.owner.headers, {
    key: `${intent}-confirm`,
    params: { adId },
    body: { versionNo: version.versionNo, viewedVia, hasViewed: true },
  });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.confirmedVersionNo, version.versionNo);
  return version.versionNo;
}

export async function prepareM5Ad(
  call: M5Call,
  support: M5Support,
  context: M1ChainContext,
  actors: M5Actors,
): Promise<{ state: M5AdState; order: M1OrderHookResult }> {
  const quote = await call("m.ad.quote", context.owner.headers, {
    body: { type: "opening", durationSec: 3 },
  });
  assert.deepEqual(quote.blockers, []);
  assert.ok(quote.chargePoints && quote.chargePoints > 0);
  const options = await call("m.dictItem.list", context.owner.headers, {
    query: { typeKey: "ad_promo_point" },
  });
  const promo = options.items.find((row) => row.typeKey === "ad_promo_point")?.items[0];
  assert.ok(promo);
  const body = {
    type: "opening" as const,
    durationSec: 3,
    promoPointCodes: [promo.code],
    copy: "M5真实广告制作需求",
    expectChargePoints: quote.chargePoints,
    agreementVersionId: quote.agreement.agreementVersionId,
    isAgreementChecked: true,
  };
  const intent = `m5-${support.runId}-ad`,
    created = await call("m.ad.create", context.owner.headers, { key: intent, body }),
    repeated = await call("m.ad.create", context.owner.headers, { key: intent, body });
  assert.equal(repeated.adId, created.adId);
  assert.equal(created.chargePoints, quote.chargePoints);
  await call("admin.ad.return", context.admin.headers, {
    key: `${intent}-return`,
    params: { adId: created.adId },
    body: { reason: "补充一次门店广告文案以验证真实退回重提" },
  });
  const resubmitted = await call("m.ad.submit", context.owner.headers, {
    key: `${intent}-submit`,
    params: { adId: created.adId },
    body: { copy: "已补充门店特色的真实广告文案" },
  });
  assert.equal(resubmitted.status, "pending_assign");
  assert.equal(resubmitted.chargePoints, quote.chargePoints);
  await call("admin.ad.assign", context.admin.headers, {
    key: `${intent}-assign`,
    params: { adId: created.adId },
    body: { staffId: actors.editor.staffId },
  });
  const versionNo = await makeM5AdVersion(
    call,
    support,
    context,
    actors,
    created.adId,
    `${intent}-v1`,
  );
  return {
    state: { adId: created.adId, chargePoints: quote.chargePoints, versionNo },
    order: {
      adIds: [created.adId],
      placements: [{ slot: "opening", adId: created.adId }],
      adSlots: [{ slot: "opening", startMs: 0, endMs: 3000, label: "广告" }],
      extraCapturedChargePoints: quote.chargePoints,
    },
  };
}
