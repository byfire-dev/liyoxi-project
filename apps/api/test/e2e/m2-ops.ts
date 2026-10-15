import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { staff, uuidv7 } from "@liyoxi/services";
import type { M2Support } from "@liyoxi/services/testing";
import type { M1Api } from "./in-process.js";
import { m1Data } from "./in-process.js";
import type { M1AuthenticatedStaff } from "./m1-auth.js";
import { createM1Caller } from "./runner-api.js";
import { createM2Http } from "./m2-http.js";
import { loginM2Merchant } from "./m2-lifecycle.js";
import type { M2Merchant } from "./m2-lifecycle.js";

export async function verifyM2Messages(
  api: M1Api,
  support: M2Support,
  headers: Readonly<Record<string, string>>,
) {
  const call = createM1Caller(api),
    http = createM2Http(api);
  await support.drainEvents();
  const list = await call("m.message.list", headers);
  const first = list.items.find((row) => !row.isRead);
  assert.ok(first, "主链真实业务事件必须产生未读消息");
  const before = await call("m.message.summary", headers);
  const read = { params: { messageId: first.messageId }, key: randomUUID() };
  const result = await http.call("m.message.read", headers, read);
  assert.deepEqual(await http.call("m.message.read", headers, read), result);
  const newest = list.items[0]!;
  const batch = { body: { upToMessageId: newest.messageId }, key: randomUUID() };
  const marked = await http.call("m.message.batchRead", headers, batch);
  assert.deepEqual(await http.call("m.message.batchRead", headers, batch), marked);
  assert.ok((await call("m.message.summary", headers)).total < before.total);
  const reportId = randomUUID(),
    subscription = {
      body: {
        reportId,
        point: "profile_submit" as const,
        results: [{ tmplId: "m2-unconfigured-template", result: "accept" as const }],
      },
      key: `subscribeReport:${reportId}`,
    };
  const ignored = await http.call("m.subscribeResult.create", headers, subscription);
  assert.deepEqual(ignored, { appliedCount: 0, ignoredCount: 1 });
  assert.deepEqual(await http.call("m.subscribeResult.create", headers, subscription), ignored);
  const input = {
    sentAt: support.clock.now().toISOString(),
    anonymousId: randomUUID(),
    sessionId: randomUUID(),
    clientVersion: "1.0.0",
    platform: "devtools" as const,
    events: [
      {
        eventId: randomUUID(),
        name: "app_launch" as const,
        occurredAt: support.clock.now().toISOString(),
        props: { hasInvitation: false },
      },
    ],
  };
  const initial = await call("m.analyticsEvent.batchCreate", headers, { body: input });
  const replay = await call("m.analyticsEvent.batchCreate", headers, { body: input });
  assert.equal(initial.accepted, 1);
  assert.equal(replay.duplicated, 1);
  return {
    unreadBefore: before.total,
    marked: marked.markedCount,
    subscription: ignored,
    analytics: { accepted: initial.accepted, duplicated: replay.duplicated },
  };
}

async function refreshAdmin(api: M1Api, support: M2Support, admin: M1AuthenticatedStaff) {
  const peer = "198.19.3.1";
  const login = await m1Data<{ ticket: string }>(
    await api.request("/api/v1/admin/auth/login", {
      method: "POST",
      peer,
      headers: admin.headers,
      json: { phone: admin.phone, password: admin.password },
    }),
  );
  const response = await api.request("/api/v1/admin/auth/verify-mfa", {
    method: "POST",
    peer,
    headers: admin.headers,
    json: {
      ticket: login.ticket,
      method: "totp",
      code: staff.hotp(staff.base32Decode(admin.secret), staff.totpStep(support.clock.now())),
    },
  });
  await m1Data(response);
  const cookie = response.headers
    .getSetCookie()
    .map((one) => one.split(";")[0]!)
    .join("; ");
  assert.ok(cookie);
  Object.assign(admin.headers, { cookie });
}

export async function verifyM2Ops(
  api: M1Api,
  support: M2Support,
  admin: M1AuthenticatedStaff,
  owner: M2Merchant,
  entityId: string,
  storeId: string,
) {
  const call = createM1Caller(api),
    http = createM2Http(api);
  const background = [await support.drainBackground()];
  let ownerHeaders = { ...owner.headers, "X-Store-Id": storeId };
  const transportClerk = await loginM2Merchant(api, support, "13700000234");
  const invite = await call("m.invitation.create", ownerHeaders, {
    body: { clientRequestId: randomUUID(), targetPhone: transportClerk.phone },
  });
  const joined = await call("m.invitation.accept", transportClerk.headers, {
    params: { invitationId: invite.invitationId },
    body: { token: invite.token, displayName: "M2运输店员" },
  });
  const delivery = await support.joinedDelivery(entityId, joined.memberId);
  for (let attempt = 1; attempt <= 10; attempt++) {
    const result = await support.runJoinedDelivery(
      entityId,
      joined.memberId,
      delivery.outboxEventId,
      true,
    );
    assert.equal(result.delivery.attempts, attempt);
    assert.equal(result.outcome, attempt === 10 ? "dead" : "retry");
  }
  await refreshAdmin(api, support, admin);
  const failed = await call("admin.outboxDelivery.list", admin.headers, {
    query: { entityId, status: "dead" },
  });
  assert.ok(
    failed.items.some(
      (row) => row.outboxEventId === delivery.outboxEventId && row.actions.includes("retry"),
    ),
  );
  const retry = {
    params: { outboxEventId: delivery.outboxEventId },
    body: { subscriber: delivery.subscriber },
    key: randomUUID(),
  };
  const recovered = await http.call("admin.outboxEvent.retry", admin.headers, retry);
  assert.deepEqual(await http.call("admin.outboxEvent.retry", admin.headers, retry), recovered);
  assert.equal(
    (await support.runJoinedDelivery(entityId, joined.memberId, delivery.outboxEventId)).outcome,
    "done",
  );
  await http.denied(
    "admin.outboxEvent.retry",
    admin.headers,
    { params: retry.params, body: retry.body },
    409,
    "STATE_NOT_ALLOWED",
  );
  await support.drainEvents();

  const cards = [];
  for (let index = 0; index < 2; index++) {
    const card = await call("m.invitation.create", ownerHeaders, {
      body: { clientRequestId: randomUUID() },
    });
    await call("m.invitation.markShared", ownerHeaders, {
      params: { invitationId: card.invitationId },
    });
    cards.push(card);
  }
  await assert.rejects(support.invitationTimer(uuidv7(), cards[0]!.invitationId));
  background.push(await support.drainBackground());
  const timerIds: string[] = [];
  for (const card of cards) {
    let last;
    for (let attempt = 1; attempt <= 6; attempt++) {
      last = await support.runInvitationTimer(entityId, card.invitationId, true);
      assert.equal(last.timer.attempts, attempt);
      assert.equal(last.outcome, attempt === 6 ? "failed" : "retry");
    }
    assert.ok(last);
    timerIds.push(last.timer.id);
  }
  await refreshAdmin(api, support, admin);
  const timers = await call("admin.timer.list", admin.headers, {
    query: { entityId, status: "failed" },
  });
  for (const id of timerIds)
    assert.ok(timers.items.some((row) => row.timerId === id && row.actions.includes("reschedule")));
  const original = await support.invitationTimer(entityId, cards[0]!.invitationId);
  const reschedule = { params: { timerId: timerIds[0]! }, body: {}, key: randomUUID() };
  const scheduled = await http.call("admin.timer.reschedule", admin.headers, reschedule);
  assert.deepEqual(await http.call("admin.timer.reschedule", admin.headers, reschedule), scheduled);
  assert.equal(scheduled.fireAt, original.fireAt.toISOString());
  assert.equal(
    (await support.runInvitationTimer(entityId, cards[0]!.invitationId)).outcome,
    "fired",
  );
  await call("admin.timer.cancel", admin.headers, {
    params: { timerId: timerIds[1]! },
    body: { reason: "已核对不再等待此邀请任务" },
  });
  const freshOwner = await loginM2Merchant(api, support, owner.phone, owner.openid);
  ownerHeaders = { ...freshOwner.headers, "X-Store-Id": storeId };
  await call("m.invitation.revoke", ownerHeaders, {
    params: { invitationId: cards[1]!.invitationId },
    body: { reason: "by_owner" },
  });
  assert.equal(
    (await call("m.invitation.lookup", {}, { query: { token: cards[0]!.token } })).status,
    "expired",
  );
  await call("admin.webhookEvent.list", admin.headers);
  await http.denied(
    "admin.webhookEvent.retry",
    admin.headers,
    { params: { webhookEventId: uuidv7() }, body: {} },
    404,
    "NOT_FOUND",
  );
  const facts = await support.transportFacts(timerIds, delivery);
  assert.ok(facts.alerts.some((row) => row.rule === "timer.failed"));
  assert.ok(facts.alerts.some((row) => row.rule === "outbox.exhausted"));
  for (const action of ["flow.timer.reschedule", "flow.timer.cancel", "flow.outbox.retry"])
    assert.ok(
      facts.audits.some((row) => row.action === action),
      action,
    );
  await support.drainEvents();
  background.push(await support.drainBackground());
  return {
    timerFailures: 12,
    deliveryFailures: 10,
    timerRescheduled: true,
    deliveryRetried: true,
    alertRules: facts.alerts.map((row) => row.rule),
    webhookScope: "list_and_guard_upstream_retry_retained" as const,
    background,
  };
}
