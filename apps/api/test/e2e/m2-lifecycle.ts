import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { M2Support } from "@liyoxi/services/testing";
import { activateM1Staff } from "./m1-auth.js";
import type { M1AuthenticatedStaff } from "./m1-auth.js";
import type { M1Api } from "./in-process.js";
import type { M1ChainContext } from "./runner.js";
import { createM1Caller } from "./runner-api.js";
import { createM2Http } from "./m2-http.js";

export async function loginM2Merchant(
  api: M1Api,
  support: M2Support,
  phone: string,
  openid = `m2_${randomUUID()}`,
) {
  const call = createM1Caller(api);
  const agreements = await call("m.agreement.list", {}, { query: { scene: "login" } });
  const consents = agreements.items
    .filter((row) => row.subjectKind === "user" && row.currentVersion)
    .map((row) => ({
      agreementKey: row.agreementKey,
      agreementVersionId: row.currentVersion!.agreementVersionId,
    }));
  const loginCode = `m2_login_${randomUUID()}`,
    phoneCode = `m2_phone_${randomUUID()}`;
  support.providers.wechat.sessions.set(loginCode, { openid });
  support.providers.wechat.phones.set(phoneCode, phone);
  const login = await call(
    "m.session.phoneLogin",
    {},
    { body: { loginCode, phoneCode, consents } },
  );
  return {
    phone,
    openid,
    merchantUserId: login.me.user.merchantUserId,
    headers: { authorization: `Bearer ${login.token}`, "X-Client-Version": "1.0.0" },
  };
}
export type M2Merchant = Awaited<ReturnType<typeof loginM2Merchant>>;

export async function prepareM2Lifecycle(context: M1ChainContext, support: M2Support) {
  const { api, admin, owner } = context,
    call = createM1Caller(api),
    http = createM2Http(api);
  await support.configureSms(admin.staffId);
  const entity = await call("admin.entity.get", admin.headers, {
    params: { entityId: owner.entityId },
  });
  await call("admin.entity.quota.update", admin.headers, {
    params: { entityId: owner.entityId },
    body: {
      storeLimitOverride: 2,
      memberLimitOverride: 4,
      lockVersion: entity.lockVersion,
      confirm: {
        storeLimitOverride: entity.usage.storeLimitOverride,
        memberLimitOverride: entity.usage.memberLimitOverride,
      },
      reasonText: "隔离主链演示多门店与邀请额度",
    },
  });
  const store = await call("m.store.create", owner.headers, {
    body: {
      name: "M2演示分店",
      addressDetail: "演示路二号",
      industryCode: support.profileDefaults.industryCode,
      categoryCode: support.profileDefaults.categoryCode,
    },
  });
  assert.equal(store.isPrimary, false);
  assert.equal(store.qualificationStatus, "unsubmitted");
  const clerk = await loginM2Merchant(api, support, "13700000231");
  const invitationBody = { clientRequestId: randomUUID(), targetPhone: clerk.phone };
  const card = await call("m.invitation.create", owner.headers, { body: invitationBody });
  assert.equal(
    (await call("m.invitation.lookup", {}, { query: { token: card.token } })).status,
    "pending",
  );
  const key = randomUUID(),
    accept = {
      params: { invitationId: card.invitationId },
      body: { token: card.token, displayName: "M2店员" },
      key,
    };
  const joined = await http.call("m.invitation.accept", clerk.headers, accept);
  assert.equal(joined.role, "clerk");
  assert.deepEqual(await http.call("m.invitation.accept", clerk.headers, accept), joined);
  const members = await call("m.member.list", owner.headers);
  assert.ok(members.items.some((row) => row.memberId === joined.memberId));
  const clerkHome = await call("m.home.get", { ...clerk.headers, "X-Store-Id": owner.storeId });
  assert.ok(!JSON.stringify(clerkHome).includes("spendablePoints"), "店员首页不能含积分字段");

  const reasons = await call("admin.dictItem.list", admin.headers, {
    query: { typeKey: "reject_reason" },
  });
  const reason = reasons.items.find((row) => row.isEnabled);
  assert.ok(reason);
  const submitChange = async (storeName: string) => {
    const basic = await call("m.storeProfile.basic.get", owner.headers);
    assert.ok(basic.viewerRole === "owner");
    const changed = await call("m.storeProfile.basic.update", owner.headers, {
      body: { draft: true, lockVersion: basic.lockVersion, storeName, confirmReview: true },
    });
    assert.ok(changed.pendingChange);
    const id = changed.pendingChange.qualificationSubmissionId;
    const view = await call("m.storeProfile.qualification.get", owner.headers);
    assert.equal(view.viewerRole, "owner");
    assert.ok(view.viewerRole === "owner");
    await call("m.storeProfile.qualification.submit", owner.headers, {
      body: {
        qualificationSubmissionId: id,
        declarationConfirmed: true,
        declarationVersion: view.declaration.currentVersion,
      },
    });
    return call("admin.qualificationSubmission.get", admin.headers, {
      params: { qualificationSubmissionId: id },
    });
  };
  const rejected = await submitChange("M2待补正门店");
  await call("admin.qualificationSubmission.reject", admin.headers, {
    params: { qualificationSubmissionId: rejected.qualificationSubmissionId },
    body: {
      reasonCodes: [reason.code],
      note: "门店名称需补正后重提",
      isFinal: false,
      confirm: { roundNo: rejected.roundNo! },
    },
  });
  const approved = await submitChange("M2补正后门店");
  await call("admin.qualificationSubmission.approve", admin.headers, {
    params: { qualificationSubmissionId: approved.qualificationSubmissionId },
    body: {
      lockVersion: approved.approval.lockVersion,
      mode: "normal",
      confirm: { roundNo: approved.roundNo! },
      confirmChecks: approved.confirmChecks,
    },
  });
  const history = await call("m.qualificationSubmission.list", owner.headers);
  assert.ok(
    history.items.some(
      (row) =>
        row.qualificationSubmissionId === rejected.qualificationSubmissionId &&
        row.outcome === "rejected",
    ),
  );
  assert.ok(
    history.items.some(
      (row) =>
        row.qualificationSubmissionId === approved.qualificationSubmissionId &&
        row.outcome === "approved",
    ),
  );
  assert.equal((await call("m.storeProfile.basic.get", owner.headers)).storeName, "M2补正后门店");

  const flags = await call("admin.featureFlag.list", admin.headers);
  const flag = flags.items.find((row) => row.flagKey === "weapp.trailer.autoplay");
  assert.ok(flag && typeof flag.defaultValue === "boolean");
  const changed = await call("admin.featureFlag.update", admin.headers, {
    params: { flagKey: flag.flagKey },
    body: { lockVersion: flag.lockVersion, defaultValue: !flag.defaultValue },
  });
  assert.equal(
    (await call("m.bootstrap.get", owner.headers)).flags["weapp.trailer.autoplay"],
    !flag.defaultValue,
  );
  await call("admin.featureFlag.update", admin.headers, {
    params: { flagKey: flag.flagKey },
    body: { lockVersion: changed.lockVersion, defaultValue: flag.defaultValue },
  });
  await support.drainEvents();
  const facts = await support.facts({
    entityId: owner.entityId,
    userIds: [owner.merchantUserId, clerk.merchantUserId],
  });
  assert.equal(facts.stores.length, 2);
  assert.ok(
    facts.invitations.some((row) => row.id === card.invitationId && row.status === "accepted"),
  );
  return {
    clerk,
    storeId: store.storeId,
    invitation: card,
    invitationBody,
    acceptInput: accept,
    joined,
  };
}
export type M2Lifecycle = Awaited<ReturnType<typeof prepareM2Lifecycle>>;

async function addStaff(
  api: M1Api,
  admin: M1AuthenticatedStaff,
  roleKey: "cs" | "delivery_manager",
  phone: string,
  isLead = false,
) {
  const call = createM1Caller(api);
  const created = await call("admin.staff.create", admin.headers, {
    body: {
      name: isLead ? "M2审批主管" : "M2演示员工",
      phone,
      roleKey,
      isLead,
      activateNow: true,
      activationDelivery: "manual",
      inviteWecom: false,
    },
  });
  assert.ok(created.activation?.activationCode);
  const actorApi: M1Api = {
    ...api,
    request: (path, init = {}) =>
      api.request(path, { ...init, peer: `198.19.2.${Number(phone.slice(-2))}` }),
  };
  return activateM1Staff(actorApi, {
    phone,
    activationCode: created.activation.activationCode,
    staffId: created.staff.staffId,
  });
}

export async function finishM2Lifecycle(
  context: M1ChainContext,
  support: M2Support,
  lifecycle: M2Lifecycle,
) {
  const { api, admin, owner, reviewer } = context,
    call = createM1Caller(api),
    http = createM2Http(api);
  const device = await loginM2Merchant(api, support, lifecycle.clerk.phone);
  await call("m.smsCode.create", lifecycle.clerk.headers, { body: { purpose: "phone_change" } });
  const sms = support.providers.sms
    .callsOf("sendSubscribeFallback")
    .filter((row) => (row.input as { phone: string }).phone === lifecycle.clerk.phone)
    .at(-1);
  assert.ok(sms);
  const oldSmsCode = (sms.input as { params: { code: string } }).params.code;
  const newPhoneCode = `m2_change_${randomUUID()}`,
    phone = "13700000232";
  support.providers.wechat.phones.set(newPhoneCode, phone);
  const key = randomUUID(),
    change = { body: { oldSmsCode, newPhoneCode }, key };
  const changed = await http.call("m.me.changePhone", lifecycle.clerk.headers, change);
  assert.deepEqual(await http.call("m.me.changePhone", lifecycle.clerk.headers, change), changed);
  await http.denied("m.me.get", device.headers, {}, 401, "SESSION_INVALID");
  const identities = await call("m.me.wechatIdentity.list", lifecycle.clerk.headers);
  const current = identities.items.find((row) => row.isCurrent);
  assert.ok(current);
  const removed = await call("m.me.wechatIdentity.delete", lifecycle.clerk.headers, {
    params: { wechatIdentityId: current.wechatIdentityId },
  });
  assert.equal(removed.isCurrentSessionRevoked, true);
  await http.denied("m.me.get", lifecycle.clerk.headers, {}, 401, "SESSION_INVALID");
  const clerk = await loginM2Merchant(api, support, phone, lifecycle.clerk.openid);
  assert.equal(clerk.merchantUserId, lifecycle.clerk.merchantUserId);

  const requester = await addStaff(api, admin, "cs", "19900000231");
  const decider = await addStaff(api, admin, "cs", "19900000232", true);
  const receiver = await addStaff(api, admin, "delivery_manager", "19900000233", true);
  const reasons = await call("admin.dictItem.list", admin.headers, {
    query: { typeKey: "account_change_reason" },
  });
  let reason = reasons.items.find((row) => row.isEnabled);
  if (!reason)
    reason = await call("admin.dictItem.create", admin.headers, {
      body: { typeKey: "account_change_reason", name: "隔离演示账号核实" },
    });
  const png = new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4o8AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const registration = await call("admin.file.create", requester.headers, {
    body: {
      category: "account_proof",
      entityId: owner.entityId,
      fileName: "m2-proof.png",
      sizeBytes: String(png.length),
      clientToken: randomUUID(),
    },
  });
  assert.ok(registration?.post);
  assert.equal(
    support.providers.storage.upload(
      { ...registration.post, key: registration.key, expiresAt: new Date(registration.expiresAt) },
      png,
    ),
    204,
  );
  await call("admin.file.complete", requester.headers, {
    params: { fileId: registration.fileId },
    body: {},
  });
  await support.promote(registration.fileId);
  const target = await call("admin.entity.get", requester.headers, {
    params: { entityId: owner.entityId },
  });
  assert.ok(target.owner?.phoneMask);
  const changeRequest = await call("admin.accountChangeRequest.create", requester.headers, {
    body: {
      kind: "owner_transfer",
      entityId: owner.entityId,
      newPhone: phone,
      proofFileIds: [registration.fileId],
      reasonCode: reason.code,
      reasonText: "已线下核对虚构老板交接凭据",
      confirm: { targetPhoneMask: target.owner.phoneMask },
    },
  });
  const detail = await call("admin.accountChangeRequest.get", decider.headers, {
    params: { accountChangeRequestId: changeRequest.accountChangeRequestId },
  });
  const approval = await call("admin.accountChangeRequest.approve", decider.headers, {
    params: { accountChangeRequestId: detail.accountChangeRequestId },
    body: {
      lockVersion: detail.approval.lockVersion,
      confirm: { requestNo: detail.requestNo, newPhoneMask: detail.newPhoneMask },
      confirmChecks: ["proof_checked"],
    },
  });
  assert.ok(approval.result && "newOwnerUserId" in approval.result);
  assert.equal(approval.result.newOwnerUserId, clerk.merchantUserId);
  await http.denied("m.storeProfile.basic.get", owner.headers, {}, 403, "NOT_A_MEMBER");
  const newOwner = { ...clerk.headers, "X-Store-Id": owner.storeId };
  assert.equal((await call("m.storeProfile.basic.get", newOwner)).viewerRole, "owner");
  const employee = await call("admin.staff.get", admin.headers, {
    params: { staffId: reviewer.staffId },
  });
  const work = await call("admin.staff.openWork.get", admin.headers, {
    params: { staffId: reviewer.staffId },
  });
  assert.ok(work.total > 0);
  const disabled = await call("admin.staff.disable", admin.headers, {
    params: { staffId: reviewer.staffId },
    body: {
      reason: "reassigned",
      handoverToStaffId: receiver.staffId,
      confirm: { staffNo: employee.staffNo, openWorkCount: work.total },
    },
  });
  assert.ok(disabled);
  await http.denied("admin.auth.me.get", reviewer.headers, {}, 401, "SESSION_INVALID");
  const blocked = await http.denied(
    "m.me.deletion.create",
    clerk.headers,
    { body: { hasConfirmed: true } },
    409,
    "ACCOUNT_DELETION_BLOCKED",
  );
  assert.ok(blocked.details?.blockers?.length);
  const empty = await loginM2Merchant(api, support, "13700000239");
  await call("m.me.deletion.create", empty.headers, { body: { hasConfirmed: true } });
  await http.denied("m.me.get", empty.headers, {}, 401, "SESSION_INVALID");
  await support.drainEvents();
  const facts = await support.facts({
    entityId: owner.entityId,
    userIds: [owner.merchantUserId, clerk.merchantUserId, empty.merchantUserId],
    staffIds: [reviewer.staffId, receiver.staffId, decider.staffId],
  });
  assert.deepEqual(
    facts.members
      .filter((row) => row.status === "active" && row.role === "owner")
      .map((row) => row.merchantUserId),
    [clerk.merchantUserId],
  );
  assert.equal(facts.staff.find((row) => row.id === reviewer.staffId)?.status, "disabled");
  assert.ok(
    facts.staffSessions
      .filter((row) => row.staffId === reviewer.staffId)
      .every((row) => row.revokedAt),
  );
  assert.equal(
    facts.stores.find((row) => row.id === owner.storeId)?.deliveryManagerId,
    receiver.staffId,
  );
  assert.equal(facts.users.find((row) => row.id === empty.merchantUserId)?.status, "deleted");
  assert.ok(!facts.sessions.some((row) => row.merchantUserId === empty.merchantUserId));
  assert.ok(facts.audits.length > 0 && facts.history.length > 0);
  return { clerk, newOwner, receiver, requester, decider, blocked: blocked.details!.blockers! };
}
