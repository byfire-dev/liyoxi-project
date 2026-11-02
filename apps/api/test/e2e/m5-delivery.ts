import assert from "node:assert/strict";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import type { M5Support, M5Scope } from "@liyoxi/services/testing";
import type { M1ProductionHookContext } from "./runner.js";
import type { M5Call } from "./m5-http.js";
import { expectM5Failure, readM5Signed } from "./m5-http.js";
import type { M5Actors } from "./m5-ad.js";
import { createM5Publisher } from "./m5-ad.js";

export async function runM5TicketActions(
  call: M5Call,
  support: M5Support,
  context: M1ProductionHookContext,
  actors: M5Actors,
) {
  const { scope, admin, api } = context,
    params = { deliveryTicketId: scope.deliveryTicketId };
  const current = await call("admin.deliveryTicket.get", admin.headers, { params });
  const assigned = await call("admin.deliveryTicket.assignEditor", admin.headers, {
    key: `m5-${support.runId}-ticket-editor`,
    params,
    body: {
      staffId: actors.editor.staffId,
      ...(current.editor ? { reasonCode: "workload" as const } : {}),
      note: "按当前剪辑在办任务进行分派",
    },
  });
  assert.equal(assigned.editor?.staffId, actors.editor.staffId);
  // order.start legitimately picks the original seeded publisher from its pool. When it is
  // already this target, create/activate a different real employee and exercise an actual reassign.
  const publisherTarget =
    current.publisher?.staffId === actors.publisher.staffId
      ? await createM5Publisher(call, support, context)
      : actors.publisher;
  assert.notEqual(current.publisher?.staffId, publisherTarget.staffId);
  const publisher = await call("admin.deliveryTicket.assignPublisher", admin.headers, {
    key: `m5-${support.runId}-ticket-publisher`,
    params,
    body: {
      staffId: publisherTarget.staffId,
      ...(current.publisher ? { reasonCode: "workload" as const } : {}),
      note: "将当前发布工作改派给独立发布员",
    },
  });
  assert.equal(publisher.publisher?.staffId, publisherTarget.staffId);
  const beforeDate = await support.readM5Facts(scope);
  const item = beforeDate.items.find((row) => row.id === scope.orderItemId);
  assert.ok(item?.agreedLaunchDate && item.usageEndDate);
  const newDate = addDays(calendarDate(item.agreedLaunchDate), 1);
  assert.ok(newDate <= calendarDate(item.usageEndDate));
  const changed = await call("admin.orderItem.rescheduleLaunch", admin.headers, {
    key: `m5-${support.runId}-launch-date`,
    params: { orderItemId: scope.orderItemId },
    body: {
      agreedLaunchDate: newDate,
      reason: "本轮与商家核对实际自发布日",
    },
  });
  assert.equal(changed.agreedLaunchDate, newDate);
  const quote = await call("admin.order.cancelQuote", admin.headers, {
    params: { orderId: scope.orderId },
    body: { reasonCode: "platform_fault" },
  });
  assert.deepEqual(quote.blockers, []);
  const pause = await call("admin.order.cancelRequest.create", admin.headers, {
    key: `m5-${support.runId}-pause`,
    params: { orderId: scope.orderId },
    body: {
      reasonCode: "platform_fault",
      note: "暂存取消申请验证真实暂停恢复",
      expect: quote.expect,
    },
  });
  assert.equal(pause.status, "pending_approval");
  const paused = await call("admin.deliveryTicket.get", admin.headers, { params });
  assert.equal(paused.isPaused, true);
  assert.ok(paused.pauseReasons.includes("cancel_review"));
  const evaluated = await call("admin.deliveryTicket.reevaluate", admin.headers, {
    key: `m5-${support.runId}-paused-evaluate`,
    params,
    body: {},
  });
  assert.equal(evaluated.skippedReason, "paused");
  assert.equal(evaluated.ticket.step, paused.step);
  await expectM5Failure(
    api,
    `/api/v1/admin/delivery-tickets/${scope.deliveryTicketId}/rework`,
    admin.headers,
    { reason: "暂停中不允许返工" },
    409,
    "TICKET_ON_HOLD",
    `m5-${support.runId}-paused-rework`,
  );
  await call("admin.cancelRequest.withdraw", admin.headers, {
    key: `m5-${support.runId}-pause-withdraw`,
    params: { cancelRequestId: pause.cancelRequestId },
    body: { note: "核对完成，撤回申请恢复原制作步骤" },
  });
  const resumed = await call("admin.deliveryTicket.get", admin.headers, { params });
  assert.equal(resumed.isPaused, false);
  assert.deepEqual(resumed.pauseReasons, []);
  assert.equal(resumed.step, paused.step);
  const after = await call("admin.deliveryTicket.reevaluate", admin.headers, {
    key: `m5-${support.runId}-evaluate`,
    params,
    body: {},
  });
  assert.equal(after.ticket.isPaused, false);
  assert.deepEqual(after.ticket.pauseReasons, []);
  // A valid production chain has no inconsistent legacy state to manufacture. Exercise the
  // actual correction guard; the fixed-source W5-03 matrix proves successful legacy correction.
  await expectM5Failure(
    api,
    `/api/v1/admin/delivery-tickets/${scope.deliveryTicketId}/force-transition`,
    admin.headers,
    {
      toStep: "in_service",
      note: "不允许人工纠偏越过成片质检与上线事实",
      confirm: { ticketNo: resumed.ticketNo, fromStep: resumed.step },
    },
    409,
    "CORRECTION_NOT_ALLOWED",
    `m5-${support.runId}-force-guard`,
  );
  const history = await call("admin.deliveryTicket.activity.list", admin.headers, { params });
  assert.ok(history.items.some((row) => row.action === "delivery.ticket.assign_editor"));
}

export async function verifyM5Letters(
  call: M5Call,
  support: M5Support,
  context: M1ProductionHookContext,
  scope: M5Scope,
) {
  const { owner, admin, api } = context;
  await support.drainEvents();
  const listed = await call("m.licenseLetter.list", owner.headers, {
    query: { orderId: scope.orderId },
  });
  assert.equal(listed.items.length, 1);
  const first = listed.items[0]!;
  assert.equal(first.status, "effective");
  assert.equal(first.canDownload, true);
  const initial = await call("m.licenseLetter.get", owner.headers, {
    params: { licenseLetterId: first.licenseLetterId },
  });
  assert.ok(initial.preview && initial.currentRevNo);
  const before = await support.readM5Facts(scope);
  // Correction creates a revision only when legal content changes. This chain retains its
  // actual legal facts; the dedicated W5-07/W5-13 matrices cover positive corrections.
  await expectM5Failure(
    api,
    `/api/v1/admin/license-letters/${first.licenseLetterId}/correct`,
    admin.headers,
    { correctionKinds: ["other"], note: "本轮复核授权内容，未变更原有法律事实" },
    409,
    "LICENSE_LETTER_UNCHANGED",
    `m5-${support.runId}-license-unchanged`,
  );
  await support.drainEvents();
  const current = await call("m.licenseLetter.get", owner.headers, {
    params: { licenseLetterId: first.licenseLetterId },
  });
  assert.ok(current.currentRevNo);
  assert.equal(current.currentRevNo, initial.currentRevNo);
  assert.equal(current.preview?.signMode, "platform_cert");
  const adminView = await call("admin.orderItem.licenseLetter.list", admin.headers, {
    params: { orderItemId: scope.orderItemId },
  });
  const actual = adminView.items.find((row) => row.licenseLetterId === first.licenseLetterId);
  assert.equal(actual?.currentRevision?.renderStatus, "ready");
  const facts = await support.readM5Facts(scope);
  assert.deepEqual(facts.letters, before.letters);
  assert.deepEqual(facts.revisions, before.revisions);
  const letter = facts.letters.find((row) => row.id === first.licenseLetterId);
  assert.ok(letter?.currentRevisionId);
  const revision = facts.revisions.find((row) => row.id === letter.currentRevisionId);
  assert.ok(revision?.pdfSha256 && revision.fileId);
  assert.equal(revision.renderStatus, "ready");
  assert.equal(revision.revNo, initial.currentRevNo);
  assert.equal(revision.signMode, "platform_cert");
  assert.ok(revision.certIssuer && revision.certSerial && revision.platformSignedAt);
  const file = facts.files.find((row) => row.id === revision.fileId);
  assert.ok(file?.sha256 && file.sizeBytes);
  assert.equal(file.category, "legal_doc");
  assert.equal(file.status, "stored");
  assert.equal(file.sha256, revision.pdfSha256);
  const signed = await call("m.licenseLetter.downloadUrls", owner.headers, {
    params: { licenseLetterId: first.licenseLetterId },
    body: { revNo: current.currentRevNo },
  });
  assert.equal(new Date(signed.expiresAt).getTime() - support.clock.now().getTime(), 300_000);
  const bytes = await readM5Signed(support, signed.url, {
    sha256: revision.pdfSha256,
    sizeBytes: Number(file.sizeBytes),
  });
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 5)), "%PDF-");
  assert.ok(
    facts.revisions.some(
      (row) => row.revNo === initial.currentRevNo && row.renderStatus === "ready",
    ),
  );
  return current.currentRevNo;
}

export async function runM5Reissue(
  call: M5Call,
  support: M5Support,
  context: M1ProductionHookContext,
  scope: M5Scope,
) {
  const { admin, helpers } = context;
  const dict = await call("admin.dictItem.list", admin.headers, {
    query: { typeKey: "reissue_reason" },
  });
  const reason = dict.items.find((row) => row.isEnabled);
  assert.ok(reason, "M5 reissue needs a current dictionary reason");
  const before = await support.readM5Facts(scope);
  const original = before.releases.find((row) => row.state === "pushed");
  assert.ok(original);
  const body = { episodeNos: [1], reasonCode: reason.code, note: "第一集门店文案修正后重新交付" };
  const open = async (suffix: string) =>
    call("admin.deliveryTicket.reissue.create", admin.headers, {
      key: `m5-${support.runId}-reissue-${suffix}`,
      params: { deliveryTicketId: scope.deliveryTicketId },
      body,
    });
  const cancelled = await open("cancelled");
  const ended = await call("admin.reissue.cancel", admin.headers, {
    key: `m5-${support.runId}-reissue-cancel`,
    params: { reissueId: cancelled.reissueId },
    body: { note: "保留取消事实，重新发起正确补发" },
  });
  assert.equal(ended.status, "cancelled");
  const opened = await open("published");
  // Single-file upload's actual descriptor has no reissueId; its owner guard resolves the
  // current open request and episode. Registration must still name this exact reissue.
  const fileId = await helpers.productionFile("final_episode", 1);
  const registered = await call("admin.deliveryTicket.episodeOutput.create", admin.headers, {
    key: `m5-${support.runId}-replacement`,
    params: { deliveryTicketId: scope.deliveryTicketId },
    body: { reissueId: opened.reissueId, items: [{ episodeNo: 1, fileId }] },
  });
  const output = registered.items[0];
  assert.ok(output);
  assert.equal(output.deliveryReissueId, opened.reissueId);
  assert.equal(output.isCurrent, false);
  const qc = await helpers.checks("qc.episode");
  await call("admin.deliveryTicket.inspectEpisodes", context.reviewer.headers, {
    params: { deliveryTicketId: scope.deliveryTicketId },
    body: {
      episodeOutputIds: [output.episodeOutputId],
      checklistVersionNo: qc.checklistVersionNo,
      defaultResults: qc.results,
    },
  });
  const precheck = await helpers.checks("delivery.precheck");
  const published = await call("admin.reissue.publish", admin.headers, {
    key: `m5-${support.runId}-reissue-publish`,
    params: { reissueId: opened.reissueId },
    body: {
      precheck: {
        checklistVersionNo: precheck.checklistVersionNo,
        results: precheck.results.map(({ key, result, note }) => ({
          key,
          result,
          ...(note == null ? {} : { note }),
        })),
      },
      note: "替换集实际制作与双人质检通过",
    },
  });
  assert.equal(published.reissue.status, "published");
  const after = await support.readM5Facts(scope);
  assert.equal(after.reissues.find((row) => row.id === cancelled.reissueId)?.status, "cancelled");
  assert.equal(after.reissues.find((row) => row.id === opened.reissueId)?.status, "published");
  assert.equal(after.releases.find((row) => row.id === original.id)?.state, "superseded");
  assert.equal(
    after.releases.find((row) => row.id === published.release.deliveryReleaseId)?.state,
    "pushed",
  );
  assert.equal(after.outputs.find((row) => row.id === output.episodeOutputId)?.isCurrent, true);
  assert.equal(after.outputs.filter((row) => row.episodeNo === 1 && row.isCurrent).length, 1);
  assert.equal(
    after.downloadGrants.filter(
      (row) => row.deliveryReleaseId === original.id && row.state === "active",
    ).length,
    0,
  );
  assert.equal(
    after.downloadGrants.filter(
      (row) =>
        row.deliveryReleaseId === published.release.deliveryReleaseId && row.state === "active",
    ).length,
    1,
  );
  await call("admin.orderItem.download.list", admin.headers, {
    params: { orderItemId: scope.orderItemId },
  });
  return { ids: [cancelled.reissueId, opened.reissueId], status: "published" as const };
}
