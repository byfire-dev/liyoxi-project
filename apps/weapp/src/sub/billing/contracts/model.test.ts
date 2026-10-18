import { expect, it, vi } from "vitest";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import type { RequestLayer } from "@/lib/request";
import { makeMe } from "../../../../shots/account-fixtures";
import {
  CONTRACT_OLD_ID,
  contractVersion,
  signedContracts,
} from "../../../../shots/contracts-fixtures";
import { createContractsApi } from "./api";
import type { SignedPage, Version } from "./api";
import { contractContext, createContractsModel } from "./model";
import { createContractDocument } from "./document";
import type { ContractDocument } from "./document";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("合同只读消费actual DTO：本店owner含历史签署/旧正文与每次现签，clerk零交易键零summary，游标与身份取当前店", async () => {
  let scene = "contracts-old-version",
    signature = 0;
  const calls: Array<{ path: string; method: string }> = [];
  const send: RequestLayer["request"] = async <T>(
    path: string,
    options?: Parameters<RequestLayer["request"]>[1],
  ) => {
    calls.push({ path, method: options?.method ?? "GET" });
    if (path.startsWith("/m/agreement-consents?")) return signedContracts(scene) as T;
    if (path === "/m/agreement-consents/summary") return { all: 7 } as T;
    if (path === `/m/agreement-versions/${CONTRACT_OLD_ID}`)
      return contractVersion(++signature) as T;
    throw new Error("unexpected readonly request");
  };
  const api = createContractsApi(send),
    opened = vi.fn<ContractDocument["open"]>(async () => {});
  const document = { open: opened, cancel: vi.fn() };
  const model = createContractsModel({
    api,
    document,
    context: () => ({ key: scene, role: scene === "contracts-clerk" ? "clerk" : "owner" }),
    changed: vi.fn(),
    now: () => Date.parse("2026-10-17T00:00:00Z"),
  });
  await model.show();
  expect(model.snapshot().total).toBe(7);
  const page = model.snapshot().page;
  if (!page || page.viewerRole !== "owner") throw new Error("owner DTO expected");
  expect(page.items[0]?.firstConsent.bizTitle).toBe("开通签署时专业版 · 2 个月");
  expect(page.items[0]?.latestConsent.bizNo).toBe("FK202609010000002");
  expect(page.items[0]!.firstConsent.consentNo).toMatch(/^\d+$/);
  expect(page.items[0]!.latestConsent.consentNo).toMatch(/^\d+$/);
  expect(appDateTimeFormat.dateTimeFull(page.items[0]!.firstConsent.consentedAt)).toBe(
    "2026-08-01 10:30",
  );
  expect(appDateTimeFormat.dateTimeFull("2026-12-31T16:00:00.000Z")).toBe("2027-01-01 00:00");
  await model.read(page.items[0]!);
  expect(model.snapshot().body?.agreementVersionId).toBe(CONTRACT_OLD_ID);
  expect(model.snapshot().body).not.toHaveProperty("pdf");
  expect(model.snapshot().body?.contentHtml).toContain("签署时的服务约定");
  await model.openPdf();
  await model.openPdf();
  expect(opened.mock.calls.map((call) => call[0])).toEqual([
    "https://private.invalid/agreements/old.pdf?signature=2",
    "https://private.invalid/agreements/old.pdf?signature=3",
  ]);
  expect(calls.filter((call) => call.path.includes("/agreement-versions/"))).toHaveLength(3);
  await api.list("cursor+/?");
  expect(calls.at(-1)?.path).toBe("/m/agreement-consents?limit=20&cursor=cursor%2B%2F%3F");
  model.hide();
  scene = "contracts-clerk";
  await model.show();
  const clerk = model.snapshot().page;
  if (!clerk || clerk.viewerRole !== "clerk") throw new Error("clerk DTO expected");
  expect(model.snapshot().total).toBeNull();
  for (const record of [clerk.items[0]!.firstConsent, clerk.items[0]!.latestConsent])
    expect(Object.keys(record).sort()).toEqual([
      "consentNo",
      "consentedAt",
      "method",
      "scene",
      "versionLabel",
    ]);
  expect(calls.filter((call) => call.path.endsWith("/summary"))).toHaveLength(1);
  expect(calls.every((call) => call.method === "GET")).toBe(true);
  const me = makeMe(true),
    storeId = me.memberships[0]!.stores[0]!.storeId;
  const input = { token: "local-token", storeId, contextRev: 1, me };
  const own = contractContext(input);
  expect(own.role).toBe("clerk");
  const anotherOwner = {
    ...me.memberships[0]!,
    role: "owner" as const,
    memberId: "other",
    stores: [{ ...me.memberships[0]!.stores[0]!, storeId: "other-store" }],
  };
  expect(
    contractContext({ ...input, me: { ...me, memberships: [...me.memberships, anotherOwner] } })
      .role,
  ).toBe("clerk");
  expect(contractContext({ ...input, storeId: "missing-store" }).role).toBeNull();
  for (const changed of [
    { ...input, token: "new" },
    { ...input, contextRev: 2 },
    { ...input, me: makeMe() },
  ])
    expect(contractContext(changed).key).not.toBe(own.key);
});

it("现签与原生文件边界：hide/切人迟到不显示或打开、旧finally不改新忙态、只清自有临时文件且错误不泄露URL", async () => {
  let key = "first";
  const list = deferred<SignedPage>(),
    oldBody = deferred<Version>(),
    newBody = deferred<Version>();
  const api = {
    list: vi
      .fn()
      .mockReturnValueOnce(list.promise)
      .mockResolvedValue(signedContracts("contracts-old-version")),
    summary: vi.fn(async () => ({ all: 1 })),
    version: vi
      .fn()
      .mockReturnValueOnce(oldBody.promise)
      .mockReturnValueOnce(newBody.promise)
      .mockResolvedValue(contractVersion()),
  };
  const downloaded = deferred<{ statusCode: number; tempFilePath: string }>();
  const ports = {
    download: vi.fn(() => ({ promise: downloaded.promise, abort: vi.fn() })),
    open: vi.fn(async () => {}),
    unlink: vi.fn(async () => {}),
  };
  const document = createContractDocument(ports);
  const model = createContractsModel({
    api,
    document,
    context: () => ({ key, role: "owner" }),
    changed: vi.fn(),
    now: () => Date.parse("2026-10-17T00:00:00Z"),
  });
  const pending = model.show();
  model.hide();
  key = "second";
  list.resolve(signedContracts("contracts-old-version"));
  await pending;
  expect(model.snapshot().page).toBeNull();
  expect(api.summary).not.toHaveBeenCalled();
  await model.show();
  const item = model.snapshot().page!.items[0]!;
  const old = model.read(item);
  model.hide();
  key = "third";
  await model.show();
  const fresh = model.read(model.snapshot().page!.items[0]!);
  oldBody.resolve(contractVersion());
  await old;
  expect(model.snapshot().bodyLoading).toBe(true);
  expect(model.snapshot().body).toBeNull();
  newBody.resolve(contractVersion());
  await fresh;
  const opening = model.openPdf();
  await Promise.resolve();
  expect(ports.download).toHaveBeenCalledOnce();
  model.hide();
  key = "fourth";
  downloaded.resolve({ statusCode: 200, tempFilePath: "/temp/owned-old.pdf" });
  await opening;
  expect(ports.download.mock.results[0]!.value.abort).toHaveBeenCalledOnce();
  expect(ports.open).not.toHaveBeenCalled();
  expect(ports.unlink).toHaveBeenCalledExactlyOnceWith("/temp/owned-old.pdf");
  await model.show();
  api.version.mockRejectedValueOnce(new Error("https://private.invalid/secret?signature=leak"));
  await model.read(model.snapshot().page!.items[0]!);
  expect(model.snapshot().detailError).toBe("暂时无法加载所签版本，请重试");
  expect(JSON.stringify(model.snapshot())).not.toContain("signature");
  const failed = createContractDocument({
    ...ports,
    download: () => ({
      promise: Promise.resolve({ statusCode: 503, tempFilePath: "/temp/owned-error.pdf" }),
      abort() {},
    }),
  });
  await expect(failed.open("https://private.invalid/fail", () => true)).rejects.toThrow(
    "PDF下载失败",
  );
  expect(ports.unlink).toHaveBeenLastCalledWith("/temp/owned-error.pdf");
  expect(ports.open).not.toHaveBeenCalled();
});
