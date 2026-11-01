import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { AdminFileCreateBodySchema } from "@liyoxi/contract";
import type { UploadFieldProps } from "../../../components/UploadField";
import { createAdminApi, type ApiHandlers } from "../../../lib/api";
import { createTicketDetailApi, type DetailApi } from "./api";
import { M5FeedbackUpload } from "./m5-feedback-upload";

// Keep the real component, upload adapter and typed HTTP client. Only the existing
// UploadField UI boundary and React mount scheduling are driven by this test.
const boundary = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  cleanups: [] as Array<() => void>,
  uploads: [] as UploadFieldProps[],
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactModule>()),
  useEffect(effect: () => void | (() => void)) {
    boundary.effects.push(effect);
  },
  useState(initial: unknown) {
    return [typeof initial === "function" ? initial() : initial, () => {}];
  },
}));
vi.mock("../../../components/UploadField", () => ({
  UploadField(props: UploadFieldProps) {
    boundary.uploads.push(props);
    return null;
  },
}));

class Xhr {
  static calls: Xhr[] = [];
  upload = {};
  status = 204;
  withCredentials = true;
  timeout = 0;
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  ontimeout?: () => void;
  open() {}
  send() {
    Xhr.calls.push(this);
  }
  abort() {
    this.onabort?.();
  }
}
afterEach(() => {
  for (const close of boundary.cleanups.splice(0)) close();
  boundary.effects.length = 0;
  boundary.uploads.length = 0;
  Xhr.calls = [];
  vi.unstubAllGlobals();
});

it("真实反馈组件只以当前员工登记ticket_attachment，typed请求无代商户或生产字段且stored后回传截图", async () => {
  const storeId = "019aa000-0000-7000-8000-000000000001";
  const fileId = "019aa000-0000-7000-8000-000000000002";
  const requests: Request[] = [];
  const registration: Awaited<ReturnType<DetailApi["file"]>> = {
    fileId,
    mode: "post",
    status: "pending",
    bucket: "asset",
    key: "incoming/feedback",
    region: "us-east-1",
    clientToken: "pending",
    credentialsLeft: 30,
    expiresAt: "2099-10-01T00:00:00Z",
    uploadExpiresAt: "2099-10-01T00:00:00Z",
    sts: null,
    chunkSize: null,
    chunkParallel: null,
    post: {
      url: "http://storage.test/feedback",
      fields: { policy: "fixture", key: "incoming/feedback" },
    },
  };
  const handlers: ApiHandlers = {
    redirectToLogin: vi.fn(),
    stepUp: vi.fn(async () => false),
    refreshAccess: vi.fn(),
    invalidateQueries: vi.fn(),
    notify: vi.fn(),
    showBlocked: vi.fn(),
    buildMismatch: vi.fn(),
  };
  const json = (data: unknown) =>
    new Response(JSON.stringify({ code: 0, message: "ok", data }), {
      headers: { "Content-Type": "application/json" },
    });
  const api = createTicketDetailApi({
    api: createAdminApi({
      baseUrl: "https://fictional-admin.test",
      build: "w513",
      handlers,
      fetch: async (request) => {
        requests.push(request.clone());
        if (request.method === "POST" && new URL(request.url).pathname === "/api/v1/admin/files") {
          const body = AdminFileCreateBodySchema.parse(await request.clone().json());
          return json({ ...registration, clientToken: body.clientToken });
        }
        if (
          request.method === "POST" &&
          new URL(request.url).pathname === `/api/v1/admin/files/${fileId}/complete`
        )
          return json({ status: "stored" });
        throw new Error("Unexpected feedback fixture request");
      },
    }),
  });
  vi.stubGlobal("XMLHttpRequest", Xhr);
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  const changed = vi.fn(),
    busy = vi.fn();
  renderToStaticMarkup(
    <M5FeedbackUpload
      api={api}
      storeId={storeId}
      disabled={false}
      onChange={changed}
      onBusy={busy}
    />,
  );
  expect(boundary.uploads).toHaveLength(3);
  for (const mount of boundary.effects) {
    const close = mount();
    if (close) boundary.cleanups.push(close);
  }
  const file = new File(
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    "反馈.png",
    { type: "image/png" },
  );
  const pending = boundary.uploads[0]!.upload(file, { onProgress: vi.fn() });
  await vi.waitFor(() => expect(Xhr.calls).toHaveLength(1));
  expect(requests).toHaveLength(1);
  expect(changed).not.toHaveBeenCalled();
  Xhr.calls[0]!.onload?.();
  const result = await pending;
  expect(result).toEqual({ fileId });
  const body = AdminFileCreateBodySchema.parse(await requests[0]!.json());
  expect(body).toMatchObject({
    category: "ticket_attachment",
    storeId,
    fileName: file.name,
    sizeBytes: String(file.size),
  });
  expect(body.clientToken).toMatch(/^[a-f0-9-]{36}$/);
  for (const field of ["onBehalfStore", "production", "licenseKind"])
    expect(body).not.toHaveProperty(field);
  expect(requests[0]!.headers.get("Idempotency-Key")).toBe(body.clientToken);
  expect(requests[0]!.headers.get("X-LYX-Admin")).toBe("1");
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ["POST", "/api/v1/admin/files"],
    ["POST", `/api/v1/admin/files/${fileId}/complete`],
  ]);
  // Drive the shared UploadField's successful-completion callback after real adapter settlement.
  boundary.uploads[0]!.onChange(result.fileId);
  expect(changed).toHaveBeenCalledWith([fileId]);
  expect(busy.mock.calls.map(([value]) => value)).toEqual([true, false]);
});
