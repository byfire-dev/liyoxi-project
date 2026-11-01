import { expect, it } from "vitest";
import { createAdminApi, type ApiHandlers } from "../../../lib/api";
import { aftercareError, createOrderAftercareApi, type LicenseCommand } from "./aftercare-api";
import { createOrderIntent } from "./aftercare-intent";
import {
  currentPdfReady,
  licenseIdentity,
  latestLicenseRevision,
  canRerenderRevision,
} from "./license-section";
import { fixtureId as id, licenseFixture, orderFixture } from "./test-data.fixture";

const ok = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, data }), {
    headers: { "Content-Type": "application/json" },
  });
function transport(reply: (request: Request) => Promise<Response> | Response) {
  const handlers: ApiHandlers = {
    redirectToLogin() {},
    stepUp: async () => false,
    refreshAccess() {},
    invalidateQueries() {},
    notify() {},
    showBlocked() {},
    buildMismatch() {},
  };
  return createOrderAftercareApi({
    api: createAdminApi({
      baseUrl: "https://order.example.test",
      build: "w513p2",
      handlers,
      fetch: async (request) => reply(request),
    }),
  });
}
it("逐项授权带includeVoided保历史；三写口真实ID/strict body/原key，不追加order lockVersion或法律正文", async () => {
  const requests: Request[] = [],
    list = licenseFixture(),
    signal = new AbortController().signal;
  list.items[0]!.revisions[0]!.renderStatus = "failed";
  list.items[0]!.revisions[0]!.actions = ["rerender"];
  const api = transport((request) => {
    requests.push(request.clone());
    return ok(
      request.method === "POST"
        ? {}
        : request.url.includes("license-letters")
          ? list
          : orderFixture(),
    );
  });
  const commands: LicenseCommand[] = [
    {
      kind: "correct",
      letterId: id(11),
      revisionId: id(13),
      body: { correctionKinds: ["account_name"], note: "核对账号笔误" },
    },
    { kind: "void", letterId: id(11), revisionId: id(13), body: { note: "按当前业务资料重出" } },
    { kind: "rerender", letterId: id(11), revisionId: id(15), body: {} },
  ];
  for (const command of commands)
    await api.writeLicense(id(1), id(2), command, `original-${command.kind}`, signal);
  const reads = requests.filter(
    (request) => request.url.includes("license-letters?") && request.method === "GET",
  );
  expect(
    reads.every((request) => new URL(request.url).searchParams.get("includeVoided") === "true"),
  ).toBe(true);
  const posts = requests.filter((request) => request.method === "POST");
  expect(posts.map((request) => new URL(request.url).pathname)).toEqual([
    `/api/v1/admin/license-letters/${id(11)}/correct`,
    `/api/v1/admin/license-letters/${id(11)}/void`,
    `/api/v1/admin/license-letter-revisions/${id(15)}/rerender`,
  ]);
  expect(await Promise.all(posts.map((request) => request.json()))).toEqual(
    commands.map((command) => command.body),
  );
  expect(posts.map((request) => request.headers.get("Idempotency-Key"))).toEqual([
    "original-correct",
    "original-void",
    "original-rerender",
  ]);
  expect(requests[0]!.method).toBe("GET");
  expect(latestLicenseRevision(list.items[0]!)?.licenseLetterRevisionId).toBe(id(15));
  expect(currentPdfReady(list.items[0]!)).toBe(true);
  const confirmation = licenseIdentity(list.items[0]);
  list.items[0]!.revisions[0]!.actions = [];
  expect(licenseIdentity(list.items[0])).not.toBe(confirmation);
  list.items[0]!.revisions[0]!.actions = ["rerender"];
  list.items[0]!.currentRevision = null;
  await api.writeLicense(id(1), id(2), commands[2]!, "original-without-current", signal);
  expect(new URL(requests.at(-1)!.url).pathname).toBe(
    `/api/v1/admin/license-letter-revisions/${id(15)}/rerender`,
  );
});
it("旧current仍可用且新版排队不冒充current；无current不捡历史PDF，错项/目标/失效重生动作零写", async () => {
  const list = licenseFixture();
  let posts = 0,
    signed = 0;
  const api = transport((request) => {
    if (request.method === "POST") {
      if (request.url.includes("/download-urls")) {
        signed++;
        return ok({
          url: "https://private.example.test/current",
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      }
      posts++;
    }
    return ok(request.url.includes("license-letters") ? list : orderFixture());
  });
  const signal = new AbortController().signal;
  expect(latestLicenseRevision(list.items[0]!)?.renderStatus).toBe("queued");
  expect(currentPdfReady(list.items[0]!)).toBe(true);
  expect(await api.pdf(id(1), id(2), id(11), signal)).toBe("https://private.example.test/current");
  expect(signed).toBe(1);
  list.items[0]!.currentRevision = null;
  await expect(
    api.writeLicense(
      id(1),
      id(2),
      {
        kind: "correct",
        letterId: id(11),
        revisionId: id(13),
        body: { correctionKinds: ["other"], note: "已失效版次" },
      },
      "key",
      signal,
    ),
  ).rejects.toMatchObject({ code: "PRECONDITION_CHANGED" });
  await expect(api.licenses(id(1), id(99), signal)).rejects.toMatchObject({
    code: "RESPONSE_MISMATCH",
  });
  await expect(api.pdf(id(1), id(2), id(11), signal)).rejects.toMatchObject({
    code: "FILE_NOT_READY",
  });
  expect(canRerenderRevision(list.items[0]!, id(15))).toBe(false);
  await expect(
    api.writeLicense(
      id(1),
      id(2),
      { kind: "rerender", letterId: id(11), revisionId: id(15), body: {} },
      "queued",
      signal,
    ),
  ).rejects.toMatchObject({ code: "PRECONDITION_CHANGED" });
  list.items[0]!.revisions[0]!.renderStatus = "failed";
  await expect(
    api.writeLicense(
      id(1),
      id(2),
      { kind: "rerender", letterId: id(11), revisionId: id(15), body: {} },
      "no-action",
      signal,
    ),
  ).rejects.toMatchObject({ code: "PRECONDITION_CHANGED" });
  list.items[0]!.revisions[0]!.actions = ["rerender"];
  await expect(
    api.writeLicense(
      id(1),
      id(2),
      { kind: "rerender", letterId: id(11), revisionId: id(99), body: {} },
      "wrong-target",
      signal,
    ),
  ).rejects.toMatchObject({ code: "PRECONDITION_CHANGED" });
  expect(signed).toBe(1);
  expect(posts).toBe(0);
});
it("当前PDF事件现签前后核当前版次；过期/换版/abort阻断开窗地址，私有错误不外显", async () => {
  let list = licenseFixture(),
    expired = false,
    swap = false;
  const posts: Request[] = [];
  const api = transport((request) => {
    if (request.method === "POST") {
      posts.push(request.clone());
      if (swap) {
        const ready = {
          ...list.items[0]!.revisions[0]!,
          renderStatus: "ready" as const,
          fileId: id(21),
          readyAt: list.items[0]!.currentRevision!.readyAt,
          renderAttemptNo: 1,
        };
        list = {
          items: [
            {
              ...list.items[0]!,
              currentRevision: ready,
              revisions: [
                ready,
                ...list.items[0]!.revisions.filter(
                  (row) => row.licenseLetterRevisionId !== ready.licenseLetterRevisionId,
                ),
              ],
            },
          ],
        };
      }
      return ok({
        url: "https://private.example.test/download",
        expiresAt: expired ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z",
      });
    }
    return ok(request.url.includes("license-letters") ? list : orderFixture());
  });
  const signal = new AbortController().signal;
  expect(await api.pdf(id(1), id(2), id(11), signal)).toBe("https://private.example.test/download");
  expect(new URL(posts[0]!.url).pathname).toBe(`/api/v1/admin/files/${id(14)}/download-urls`);
  expect(await posts[0]!.json()).toEqual({ disposition: "attachment", purpose: "下载当前授权书" });
  expired = true;
  await expect(api.pdf(id(1), id(2), id(11), signal)).rejects.toMatchObject({
    code: "FILE_NOT_READY",
  });
  expired = false;
  swap = true;
  await expect(api.pdf(id(1), id(2), id(11), signal)).rejects.toMatchObject({
    code: "PRECONDITION_CHANGED",
  });
  const controller = new AbortController();
  controller.abort();
  const count = posts.length;
  await expect(api.pdf(id(1), id(2), id(11), controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(posts).toHaveLength(count);
  expect(aftercareError(new Error("private-signature"))).not.toContain("signature");
});
it("授权写受理不冒充新版PDF ready；未知后最新生成版次变化只读并保当前可用版，scope关闭丢迟到", async () => {
  const initial = licenseFixture();
  let current = initial,
    writes = 0;
  const intent = createOrderIntent(
    async () => current,
    () => "original-key",
  );
  const unchanged = (fresh: typeof initial) =>
    licenseIdentity(fresh.items[0]) === licenseIdentity(initial.items[0]);
  await expect(
    intent.submit("correct", unchanged, async () => {
      writes++;
      throw new Error("unknown");
    }),
  ).rejects.toThrow();
  current = {
    items: [
      {
        ...initial.items[0]!,
        revisions: [
          {
            ...initial.items[0]!.revisions[0]!,
            licenseLetterRevisionId: id(25),
            revNo: 3,
            renderStatus: "queued",
            fileId: null,
            readyAt: null,
          },
          ...initial.items[0]!.revisions,
        ],
      },
    ],
  };
  expect(
    await intent.submit("correct", unchanged, async () => {
      writes++;
    }),
  ).toEqual(current);
  expect(writes).toBe(1);
  expect(currentPdfReady(current.items[0]!)).toBe(true);
  expect(latestLicenseRevision(current.items[0]!)?.renderStatus).toBe("queued");
  let finish!: () => void;
  const gate = new Promise<void>((done) => {
    finish = done;
  });
  const late = createOrderIntent(async () => {
    await gate;
    return current;
  });
  const pending = late.submit("late", unchanged, async () => {
    writes++;
  });
  late.close();
  finish();
  expect(await pending).toBeNull();
  expect(writes).toBe(1);
});
