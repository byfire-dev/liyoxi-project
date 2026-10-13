import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createAdminApi } from "../../../lib/api";
import type { AccessSnapshot } from "../../../lib/permissions";
import { createFlowOpsApi, type MediaView } from "./api";
import { FlowActionDialog, actionSpec, submitFlowAction } from "./actions";
import { actionAllowed, canReadFlow, flowSearch } from "./model";
import { canReadMedia, canRetryMedia, mediaQuery, mediaSearch } from "./media-model";
const id = "0199e187-e72a-7000-8000-000000000001",
  now = "2030-10-14T04:00:00Z";
const row: MediaView = {
  mediaJobId: id,
  kind: "audit_image",
  provider: "ci",
  mode: "local",
  subject: { type: "file_object", id },
  parent: null,
  state: "failed",
  attemptNo: 3,
  maxAttempts: 3,
  externalJobId: null,
  error: { code: "CI_IMAGE_UNAVAILABLE", message: "虚构内部错误不展示", isRetryable: false },
  nextRunAt: now,
  deadlineAt: now,
  billable: null,
  startedAt: now,
  finishedAt: now,
  createdAt: now,
  actions: ["retry"],
};
const read: AccessSnapshot = {
  staff: { id, name: "测试财务", roleKey: "finance", roleName: "财务" },
  isLead: false,
  moduleLevels: { system: "v" },
  actions: [],
  dataScope: "all",
  releases: {},
};
describe("W308媒体任务增量", () => {
  it("媒体独立system查看不收紧旧flow，CSV/配对日期及父对象遵契约，人工重试不依赖自动重试标志", () => {
    const flowOnly = { ...read, moduleLevels: {}, actions: ["flow.ops.view", "media.job.retry"] };
    expect(canReadFlow(flowOnly)).toBe(true);
    expect(canReadMedia(flowOnly)).toBe(false);
    expect(canRetryMedia(flowOnly, row)).toBe(false);
    expect(canRetryMedia({ ...read, actions: ["media.job.retry"] }, row)).toBe(true);
    expect(canRetryMedia({ ...read, actions: ["media.job.retry"] }, { ...row, actions: [] })).toBe(
      false,
    );
    expect(
      canRetryMedia({ ...read, actions: ["media.job.retry"] }, { ...row, state: "queued" }),
    ).toBe(false);
    expect(actionAllowed(read, { kind: "retry-media", row })).toBe(false);
    expect(
      flowSearch({ tab: "media", state: "failed,queued", kind: "audit_image", page: 2 }),
    ).toEqual(mediaSearch({ state: "failed,queued", kind: "audit_image", page: 2 }));
    expect(
      mediaQuery({
        state: "bad",
        subjectType: "file_object",
        subjectId: "bad",
        parentType: "playable_asset",
        createdFrom: "2030-10-01",
        pageSize: 100,
        input: "secret",
      }),
    ).toEqual({ state: "failed", sort: "-finishedAt", page: 1, pageSize: 20 });
    expect(
      mediaQuery({
        state: "failed,queued",
        subjectType: "file_object",
        subjectId: id,
        createdFrom: "2030-10-01",
        createdTo: "2030-10-14",
      }),
    ).toMatchObject({
      state: "failed,queued",
      subjectType: "file_object",
      subjectId: id,
      createdFrom: "2030-10-01",
      createdTo: "2030-10-14",
    });
  });
  it("中央GET零写、required键只发note；受控queued/deadline无父ready，真实409保留并支持只读无弹窗", async () => {
    const requests: Request[] = [];
    let reject = false;
    const central = createAdminApi({
      baseUrl: "http://admin.test",
      build: "w308",
      fetch: async (input) => {
        if (!(input instanceof Request)) throw new Error("必须使用真实Request");
        requests.push(input.clone());
        return new Response(
          JSON.stringify(
            reject
              ? { code: 40001, error: "MEDIA_JOB_NOT_RETRYABLE", message: "业务对象已不需要它" }
              : {
                  code: 0,
                  data:
                    input.method === "GET"
                      ? { items: [row], page: 1, pageSize: 20, total: 1 }
                      : {
                          ...row,
                          state: "queued",
                          attemptNo: 0,
                          finishedAt: null,
                          deadlineAt: "2030-10-14T05:00:00Z",
                          error: null,
                        },
                },
          ),
          { status: reject ? 409 : 200, headers: { "Content-Type": "application/json" } },
        );
      },
      handlers: {
        redirectToLogin() {},
        stepUp: async () => true,
        refreshAccess() {},
        invalidateQueries() {},
        notify() {},
        showBlocked() {},
        buildMismatch() {},
      },
    });
    const api = createFlowOpsApi({ api: central });
    await api.media(mediaQuery({ state: "failed,queued" }));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
    expect(new URL(requests[0]!.url).searchParams.get("state")).toBe("failed,queued");
    const outcome = await api.retryMedia(id, { note: "核对重试" }, "same-key");
    expect(outcome).toMatchObject({
      state: "queued",
      deadlineAt: "2030-10-14T05:00:00Z",
      parent: null,
    });
    expect(outcome).not.toHaveProperty("input");
    expect(actionSpec({ kind: "retry-media", row }, "").description).toContain("父对象");
    reject = true;
    await expect(
      submitFlowAction(api, { kind: "retry-media", row }, "核对重试", "same-key"),
    ).rejects.toMatchObject({ code: "MEDIA_JOB_NOT_RETRYABLE", status: 409 });
    expect(await Promise.all(requests.slice(1).map((request) => request.json()))).toEqual([
      { note: "核对重试" },
      { note: "核对重试" },
    ]);
    expect(requests.slice(1).map((request) => request.headers.get("Idempotency-Key"))).toEqual([
      "same-key",
      "same-key",
    ]);
    expect(
      renderToStaticMarkup(
        <FlowActionDialog
          action={{ kind: "retry-media", row }}
          access={read}
          api={api}
          refresh={async () => {}}
          onClose={() => {}}
          onDone={() => {}}
        />,
      ),
    ).toBe("");
  });
});
