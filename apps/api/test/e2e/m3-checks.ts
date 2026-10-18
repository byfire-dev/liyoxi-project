// M3 合流附加链：只经 HTTP 写业务，虚拟时钟与 Provider 回包是外部边界输入。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { staff } from "@liyoxi/services";
import type { M3Support } from "@liyoxi/services/testing";
import type { M1AuthenticatedStaff } from "./m1-auth.js";
import type { M1Api } from "./in-process.js";
import { m1Data } from "./in-process.js";
import { createM1Caller } from "./runner-api.js";
import type { M1ChainContext } from "./runner.js";

const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4o8AAAAASUVORK5CYII=",
    "base64",
  ),
);

async function denied(response: Response, error: string) {
  assert.ok(response.status >= 400 && response.status < 500);
  const body: unknown = await response.json();
  assert.ok(body && typeof body === "object" && "error" in body);
  assert.equal(body.error, error);
}

/** 拨钟跨日后重新走真实口令/MFA；凭据和 Cookie 仅保留于原有内存对象。 */
async function refreshAdmin(api: M1Api, admin: M1AuthenticatedStaff) {
  // 独立运维客户端；Redis 限流用真实时间，不能因拨业务钟而清桶/放宽原登录限额。
  const peer = "198.19.0.2";
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
      code: staff.hotp(staff.base32Decode(admin.secret), staff.totpStep(api.support.clock.now())),
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

export async function verifyM3Retention(
  api: M1Api,
  support: M3Support,
  admin: M1AuthenticatedStaff,
) {
  const call = createM1Caller(api);
  async function upload(bytes: Uint8Array) {
    const file = await call("admin.file.create", admin.headers, {
      body: {
        category: "poster",
        fileName: "m3-retention.png",
        mime: "image/png",
        sizeBytes: String(bytes.length),
        clientToken: randomUUID(),
      },
    });
    assert.equal(file.mode, "post");
    assert.ok(file.post);
    assert.equal(
      support.providers.storage.upload(
        { ...file.post, key: file.key, expiresAt: new Date(file.expiresAt) },
        bytes,
      ),
      204,
    );
    return file;
  }
  const malformed = await upload(new Uint8Array(8));
  await denied(
    await api.request(`/api/v1/admin/files/${malformed.fileId}/complete`, {
      method: "POST",
      headers: { ...admin.headers, "Idempotency-Key": randomUUID() },
      json: {},
    }),
    "UPLOAD_REJECTED",
  );
  assert.equal(
    (await call("admin.file.get", admin.headers, { params: { fileId: malformed.fileId } })).status,
    "rejected",
  );

  const orphan = await upload(png);
  await call("admin.file.complete", admin.headers, { params: { fileId: orphan.fileId }, body: {} });
  await support.promote(orphan.fileId);
  await support.drainMedia({ fileIds: [orphan.fileId] });
  // 放在演示员工/商家/账本创建前，避免通过倒拨时间或改行模拟过期。
  support.clock.advance(25 * 3_600_000);
  await refreshAdmin(api, admin);
  const sweep = async () => {
    const result = await support.runtime.media.retention.sweep({
      scheduledFor: support.clock.now(),
      signal: new AbortController().signal,
      runTx: support.runtime.tx.run,
    });
    assert.deepEqual(result.failed, [], "正式清扫任何分段失败均不可记绿");
  };
  await sweep();
  const proposed = (await call("admin.purgeRun.list", admin.headers)).items;
  assert.equal(proposed.length, 1);
  const run = proposed[0]!;
  assert.equal(run.state, "proposed");
  assert.equal(run.mode, "list_only");
  assert.equal(run.candidateCount, 1);
  assert.equal(run.candidateBytes, String(png.length));
  assert.equal(run.deletedCount, null);
  await sweep();
  assert.equal(
    (await call("admin.file.get", admin.headers, { params: { fileId: orphan.fileId } })).status,
    "stored",
    "未批准清单不能删除",
  );
  await denied(
    await api.request(`/api/v1/admin/purge-runs/${run.purgeRunId}/approve`, {
      method: "POST",
      headers: { ...admin.headers, "Idempotency-Key": randomUUID() },
      json: { confirm: { candidateCount: 0, candidateBytes: "0" } },
    }),
    "CONFIRM_MISMATCH",
  );
  const approved = await call("admin.purgeRun.approve", admin.headers, {
    params: { purgeRunId: run.purgeRunId },
    body: { confirm: { candidateCount: run.candidateCount, candidateBytes: run.candidateBytes } },
  });
  assert.equal(approved.state, "approved");
  await sweep();
  const deleted = await call("admin.file.get", admin.headers, {
    params: { fileId: orphan.fileId },
  });
  assert.equal(deleted.status, "deleted");
  // 清除不可逆端口只作用于本轮无业务引用的对象；当前业务引用拒绝在后续链验证。
  const erased = await call("admin.file.erase", admin.headers, {
    params: { fileId: orphan.fileId },
    body: {
      reason: "仅清除本轮虚构演示无引用对象",
      confirm: { fileId: orphan.fileId, category: "poster" },
    },
  });
  assert.ok(erased.erasedAt);
  await support.drainEvents();
  return {
    rejectedHeader: true,
    unapprovedPreserved: true,
    approvedDeleted: 1,
    erased: 1,
  } as const;
}

export async function verifyM3ProfileBlock(context: M1ChainContext, support: M3Support) {
  const { api, admin, owner } = context,
    call = createM1Caller(api);
  const before = await call("m.storeProfile.basic.get", owner.headers);
  const media = await call("m.storeProfile.media.get", owner.headers);
  assert.equal(media.groups.door.length, 1, "本轮只有一张必填门头图");
  const fileId = media.groups.door[0]!.file.fileId;
  await denied(
    await api.request(`/api/v1/admin/files/${fileId}/erase`, {
      method: "POST",
      headers: { ...admin.headers, "Idempotency-Key": randomUUID() },
      json: {
        reason: "核实仍在使用的档案文件不能清除",
        confirm: { fileId, category: "profile_image" },
      },
    }),
    "FILE_IN_USE",
  );
  // 上游明确 block 的外部响应，经正式审核任务和 file.moderated 订阅落事实。
  const previous = support.providers.media.audit;
  support.providers.media.audit = async () => ({
    ok: true,
    value: { verdict: "block", processed: true },
  });
  try {
    await support.drainMedia({ fileIds: [fileId] });
    await support.drainEvents();
  } finally {
    support.providers.media.audit = previous;
  }
  const file = await call("m.file.get", owner.headers, { params: { fileId } });
  assert.equal(file.moderationState, "block");
  const after = await call("m.storeProfile.basic.get", owner.headers);
  assert.equal(
    after.completeness.requiredFilled,
    before.completeness.requiredFilled - 1,
    "唯一必填门头图 block 后完整度应减少一项",
  );
  assert.equal(after.completeness.requiredTotal, before.completeness.requiredTotal);
  assert.ok(
    after.completeness.steps
      .find((step) => step.step === 2)
      ?.missing.some((item) => item.item === "door_photos" && item.permitType === null),
  );
  return {
    fileId,
    before: before.completeness.requiredFilled,
    after: after.completeness.requiredFilled,
  };
}
