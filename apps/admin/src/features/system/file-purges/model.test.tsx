import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createAdminApi } from "../../../lib/api";
import type { AccessSnapshot } from "../../../lib/permissions";
import { PurgeActionDialog, purgeConfirmSpec, submitPurgeAction } from "./actions";
import { createPurgeApi, type FileView, type RunView } from "./api";
import {
  byteCount,
  fileQuery,
  purgeActionAllowed,
  purgeBody,
  purgeSearch,
  referenceSummaries,
  runQuery,
  textLabel,
  runLabels,
} from "./model";
const id = "0199e187-e72a-7000-8000-000000000001",
  now = "2030-10-14T04:00:00.000Z",
  bytes = "9007199254740993123";
const run: RunView = {
  purgeRunId: id,
  mode: "list_only",
  state: "held",
  candidateCount: 2,
  candidateBytes: bytes,
  byCategory: { poster: { count: 2, bytes } },
  heldReason: "max_bytes",
  decidedBy: null,
  decidedAt: null,
  deletedCount: null,
  guardTrips: null,
  startedAt: null,
  finishedAt: null,
  createdAt: now,
  actions: ["approve", "reject"],
};
const file: FileView = {
  fileId: id,
  category: "poster",
  status: "deleted",
  rejectReason: null,
  declaredSizeBytes: "8",
  sizeBytes: "8",
  mime: "image/jpeg",
  moderationState: "none",
  storedAt: now,
  scopeType: "platform",
  entityId: null,
  storeId: null,
  originalName: "虚构海报.jpg",
  ext: "jpg",
  uploader: { actorType: "system", actorId: null, client: null, label: "系统" },
  onBehalfStoreId: null,
  purgeAfter: now,
  deletedAt: now,
  erasedAt: null,
  restorableUntil: "2030-11-13T04:00:00.000Z",
  liveRefCount: 0,
  production: null,
  check: null,
  actions: ["restore", "erase"],
};
const read: AccessSnapshot = {
  staff: { id, name: "测试", roleKey: "finance", roleName: "财务" },
  isLead: false,
  moduleLevels: { system: "v" },
  actions: [],
  dataScope: "all",
  releases: {},
};
const write: AccessSnapshot = {
  ...read,
  actions: ["files.purge.approve", "files.restore", "files.erase"],
};
function transport(reply: (request: Request, index: number) => Response, stepped = () => {}) {
  const requests: Request[] = [];
  const api = createAdminApi({
    baseUrl: "http://admin.test",
    build: "w308",
    fetch: async (input) => {
      if (!(input instanceof Request)) throw new Error("必须使用真实Request");
      requests.push(input.clone());
      return reply(input, requests.length);
    },
    handlers: {
      redirectToLogin() {},
      stepUp: async () => {
        stepped();
        return true;
      },
      refreshAccess() {},
      invalidateQueries() {},
      notify() {},
      showBlocked() {},
      buildMismatch() {},
    },
  });
  return { api: createPurgeApi({ api }), requests };
}
const ok = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, message: "ok", data }), {
    headers: { "Content-Type": "application/json" },
  });
const failed = (status: number, error: string, details?: unknown) =>
  new Response(JSON.stringify({ code: 40001, error, message: "虚构受控拒绝", details }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
describe("W308真实DTO与中央运输风险", () => {
  it("运行与候选分页隔离、CSV/单边日期保持；非法URL按契约恢复且GET参数不含UI键", () => {
    const search = purgeSearch({
      page: 3,
      filePage: 2,
      pageSize: 10,
      filePageSize: 50,
      purgeRunId: id,
      state: "held,approved",
      status: "stored,deleted",
      category: "poster",
      deletedFrom: "2030-10-01",
      uiKey: "secret",
    });
    expect(runQuery(search)).toEqual({ state: "held,approved", page: 3, pageSize: 10 });
    expect(fileQuery(search)).toEqual({
      status: "stored,deleted",
      category: "poster",
      purgeRunId: id,
      deletedFrom: "2030-10-01",
      sort: "-deletedAt",
      page: 2,
      pageSize: 50,
    });
    expect(
      purgeSearch({
        tab: "files",
        status: "bad",
        category: "bad",
        purgeRunId: "bad",
        fileIds: "bad",
        pageSize: 100,
        deletedFrom: "2030-10-02",
        deletedTo: "2030-10-01",
      }),
    ).toEqual({ tab: "files", status: "deleted", page: "1", pageSize: "20", sort: "-deletedAt" });
    expect(
      fileQuery(purgeSearch({ tab: "files", fileIds: id, deletedTo: "2030-10-14" })),
    ).toMatchObject({ fileIds: id, deletedTo: "2030-10-14" });
  });
  it("权限与真实actions/窗口缺一拒绝，BigInt确认原串、approved未完成，引用摘要不含内部键", () => {
    for (const action of [
      { kind: "approve", row: run },
      { kind: "reject", row: run },
      { kind: "restore", row: file },
      { kind: "erase", row: file },
    ] as const) {
      expect(purgeActionAllowed(read, action)).toBe(false);
      expect(purgeActionAllowed(write, action)).toBe(true);
    }
    expect(
      purgeActionAllowed(write, { kind: "restore", row: { ...file, restorableUntil: null } }),
    ).toBe(false);
    expect(purgeActionAllowed(write, { kind: "restore", row: { ...file, erasedAt: now } })).toBe(
      false,
    );
    expect(purgeActionAllowed(write, { kind: "erase", row: { ...file, actions: [] } })).toBe(false);
    const action = { kind: "approve" as const, row: run };
    expect(purgeBody(action, " 注释 ")).toEqual({
      confirm: { candidateCount: 2, candidateBytes: bytes },
      note: "注释",
    });
    expect(purgeConfirmSpec(action, "").echo).toContainEqual({
      label: "候选字节数",
      value: byteCount(bytes),
      emphasis: true,
    });
    expect(purgeConfirmSpec(action, "").description).toContain("放行不代表");
    expect(textLabel(runLabels, "approved")).toContain("待执行");
    expect(
      purgeConfirmSpec({ kind: "erase", row: file }, "虚构合法删除原因说明").sensitive?.expected,
    ).toBe(id);
    expect(() => purgeBody({ kind: "erase", row: file }, "太短")).toThrow();
    const refs = referenceSummaries({
      refs: Array.from({ length: 21 }, () => ({
        refType: "drama",
        refId: id,
        objectKey: "private-key",
        signedUrl: "https://secret.invalid",
      })),
    });
    expect(refs).toHaveLength(20);
    expect(JSON.stringify(refs)).not.toMatch(/private-key|signedUrl|secret/);
    expect(referenceSummaries({ refs: [{ refType: "https://bad.invalid", refId: id }] })).toEqual(
      [],
    );
    expect(
      renderToStaticMarkup(
        <PurgeActionDialog
          action={action}
          access={read}
          api={transport(() => ok(run)).api}
          refresh={async () => {}}
          onClose={() => {}}
          onDone={() => {}}
        />,
      ),
    ).toBe("");
  });
  it("两GET零写、四动作正式body/required键，明确受控响应分别保留approved/stored/erased事实", async () => {
    const client = transport((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET") return ok({ items: [], page: 1, pageSize: 20, total: 0 });
      return ok(
        path.endsWith("approve")
          ? { ...run, state: "approved" }
          : path.endsWith("reject")
            ? { ...run, state: "rejected" }
            : path.endsWith("restore")
              ? { ...file, status: "stored", deletedAt: null, restorableUntil: null }
              : { ...file, erasedAt: now, originalName: null, restorableUntil: null },
      );
    });
    await client.api.runs(runQuery(purgeSearch({ state: "held,approved" })));
    await client.api.files(
      fileQuery(purgeSearch({ tab: "files", status: "deleted,deleting", fileIds: id })),
    );
    expect(client.requests.every((request) => request.method === "GET")).toBe(true);
    expect(new URL(client.requests[1]!.url).searchParams.get("status")).toBe("deleted,deleting");
    expect(
      await submitPurgeAction(client.api, { kind: "approve", row: run }, "核对完毕", "approve-key"),
    ).toMatchObject({ state: "approved" });
    expect(
      await submitPurgeAction(
        client.api,
        { kind: "reject", row: run },
        "虚构驳回原因",
        "reject-key",
      ),
    ).toMatchObject({ state: "rejected" });
    expect(
      await submitPurgeAction(
        client.api,
        { kind: "restore", row: file },
        "虚构恢复原因",
        "restore-key",
      ),
    ).toMatchObject({ status: "stored", deletedAt: null });
    expect(
      await submitPurgeAction(
        client.api,
        { kind: "erase", row: file },
        "虚构合法删除原因说明",
        "erase-key",
      ),
    ).toMatchObject({ status: "deleted", erasedAt: now, originalName: null });
    const posts = client.requests.slice(2);
    expect(posts.map((request) => request.headers.get("Idempotency-Key"))).toEqual([
      "approve-key",
      "reject-key",
      "restore-key",
      "erase-key",
    ]);
    expect(await Promise.all(posts.map((request) => request.json()))).toEqual([
      { confirm: { candidateCount: 2, candidateBytes: bytes }, note: "核对完毕" },
      { reason: "虚构驳回原因" },
      { reason: "虚构恢复原因" },
      { reason: "虚构合法删除原因说明", confirm: { fileId: id, category: "poster" } },
    ]);
    expect(posts.every((request) => request.headers.get("X-LYX-Admin") === "1")).toBe(true);
    const future = transport(() =>
      ok({
        items: [
          {
            ...file,
            category: "future_category",
            status: "future_status",
            scopeType: "future_scope",
            actions: ["future_action"],
            uploader: { ...file.uploader, actorType: "future_actor", client: "future_client" },
          },
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      }),
    );
    expect((await future.api.files({})).items[0]).toMatchObject({
      category: "future_category",
      status: "future_status",
      scopeType: "future_scope",
      actions: ["future_action"],
      uploader: { actorType: "future_actor", client: "future_client" },
    });
    const futureStaff = transport(() =>
      ok({
        items: [
          {
            ...run,
            decidedBy: {
              staffId: id,
              staffNo: 1001,
              name: "虚构员工",
              roleKey: "future_role",
              isLead: false,
              status: "future_staff_status",
            },
          },
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      }),
    );
    expect((await futureStaff.api.runs({})).items[0]?.decidedBy).toMatchObject({
      roleKey: "future_role",
      status: "future_staff_status",
    });
    const invalid = transport((request) =>
      ok({
        items: [
          new URL(request.url).pathname.endsWith("purge-runs")
            ? { ...run, candidateBytes: 8 }
            : { ...file, category: { internalKey: "never-render" } },
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      }),
    );
    await expect(invalid.api.files({})).rejects.toThrow("文件列表响应不符合契约");
    await expect(invalid.api.runs({})).rejects.toThrow("清除运行响应不符合契约");
    expect(invalid.requests.every((request) => request.method === "GET")).toBe(true);
  });
  it("中央stepup重放与503手动续作同key；409/FILE_IN_USE保真不伪成功", async () => {
    let steps = 0,
      approves = 0,
      restores = 0;
    const client = transport(
      (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("approve"))
          return ++approves === 1
            ? failed(403, "STEP_UP_REQUIRED")
            : ok({ ...run, state: "approved" });
        if (path.endsWith("restore"))
          return ++restores === 1
            ? failed(503, "PROVIDER_UNAVAILABLE", { reason: "unsupported" })
            : ok({ ...file, status: "stored" });
        if (path.endsWith("erase"))
          return failed(409, "FILE_IN_USE", {
            refs: [{ refType: "drama", refId: id, objectKey: "never-render" }],
          });
        return failed(409, "CONFIRM_MISMATCH");
      },
      () => steps++,
    );
    await submitPurgeAction(client.api, { kind: "approve", row: run }, "", "step-key");
    expect(steps).toBe(1);
    expect(
      client.requests.slice(0, 2).map((request) => request.headers.get("Idempotency-Key")),
    ).toEqual(["step-key", "step-key"]);
    await expect(
      submitPurgeAction(client.api, { kind: "restore", row: file }, "虚构恢复原因", "same-key"),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", status: 503 });
    await submitPurgeAction(client.api, { kind: "restore", row: file }, "虚构恢复原因", "same-key");
    expect(
      client.requests.slice(2, 4).map((request) => request.headers.get("Idempotency-Key")),
    ).toEqual(["same-key", "same-key"]);
    await expect(
      submitPurgeAction(
        client.api,
        { kind: "erase", row: file },
        "虚构合法删除原因说明",
        "erase-key",
      ),
    ).rejects.toMatchObject({
      code: "FILE_IN_USE",
      status: 409,
      details: { refs: [{ refType: "drama", refId: id }] },
    });
    await expect(
      client.api.reject(id, { reason: "虚构拒绝原因" }, "stale-key"),
    ).rejects.toMatchObject({ code: "CONFIRM_MISMATCH", status: 409 });
  });
});
