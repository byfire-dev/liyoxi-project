import { expect, it, vi } from "vitest";
import type { RequestLayer } from "@/lib/request";
import { ApiError } from "@/lib/request";
import { makeMe } from "../../../../shots/account-fixtures";
import {
  LICENSE_IDS,
  LICENSE_STORE_ID,
  licenseCards,
  licenseDetail,
} from "../../../../shots/contracts-fixtures";
import { createContractDocument } from "./document";
import type { ContractDocument } from "./document";
import { createLicenseApi } from "./license-api";
import type { LicenseApi, LicenseDetail, LicenseDownload, LicensePage } from "./license-api";
import { createLicenseModel, licenseContext } from "./license-model";
import type { LicenseContext } from "./license-model";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const NOW = Date.parse("2026-10-31T00:00:00Z");
const signed = (revNo = 1, signature = 1): LicenseDownload => ({
  url: `https://private.invalid/document.pdf?signature=${signature}`,
  expiresAt: "2040-01-01T00:00:00Z",
  fileName: "授权书.pdf",
  revNo,
});
function setup(overrides: Partial<LicenseApi> = {}, document?: ContractDocument) {
  let context: LicenseContext = { key: "owner:first", storeId: LICENSE_STORE_ID, role: "owner" };
  const api = {
    list: vi.fn<LicenseApi["list"]>(async () => licenseCards()),
    summary: vi.fn<LicenseApi["summary"]>(async () => ({ all: 9, effective: 2 })),
    get: vi.fn<LicenseApi["get"]>(async (id) => licenseDetail(id)),
    download: vi.fn<LicenseApi["download"]>(async (_id, revNo) => signed(revNo)),
    ...overrides,
  };
  const files = document ?? {
    open: vi.fn<ContractDocument["open"]>(async () => {}),
    cancel: vi.fn(),
  };
  const model = createLicenseModel({
    api,
    document: files,
    context: () => context,
    now: () => NOW,
    changed: vi.fn(),
  });
  return {
    model,
    api,
    document: files,
    context: () => context,
    change: (patch: Partial<LicenseContext>) => {
      context = { ...context, ...patch };
    },
  };
}

it("四typed消费明确同store/filter、独立summary、编码游标和无幂等POST历史现签", async () => {
  const calls: Array<{ path: string; options: Parameters<RequestLayer["request"]>[1] }> = [];
  const request: RequestLayer["request"] = async <T>(
    path: string,
    options?: Parameters<RequestLayer["request"]>[1],
  ) => {
    calls.push({ path, options });
    return {} as T;
  };
  const api = createLicenseApi(request);
  const filter = { storeId: LICENSE_STORE_ID, includeVoided: true };
  await api.list(filter, "next+/?");
  await api.summary(filter);
  await api.get(LICENSE_IDS.expired);
  await api.download(LICENSE_IDS.expired, 2);
  await api.download(LICENSE_IDS.expired);
  expect(calls[0]?.path).toBe(
    `/m/license-letters?storeId=${LICENSE_STORE_ID}&includeVoided=true&limit=20&cursor=next%2B%2F%3F`,
  );
  expect(calls[1]?.path).toBe(
    `/m/license-letters/summary?storeId=${LICENSE_STORE_ID}&includeVoided=true`,
  );
  expect(calls[2]?.path).toBe(`/m/license-letters/${LICENSE_IDS.expired}`);
  expect(calls[3]).toEqual({
    path: `/m/license-letters/${LICENSE_IDS.expired}/download-urls`,
    options: { method: "POST", data: { revNo: 2 } },
  });
  expect(calls[4]?.options).toEqual({ method: "POST", data: {} });
});

it("真实summary不取分页长度，同剧多账号与服务端失效三态保留，历史/作废不丢失", async () => {
  const page = licenseCards(),
    first = { ...page, items: page.items.slice(0, 3), hasMore: true, nextCursor: "next" };
  const list = vi
    .fn<LicenseApi["list"]>()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce({
      items: [page.items[2]!, page.items[3]!],
      nextCursor: null,
      hasMore: false,
    });
  const f = setup({ list });
  await f.model.show();
  expect(f.model.snapshot().summary).toEqual({ all: 9, effective: 2 });
  expect(f.model.snapshot().page?.items).toHaveLength(3);
  expect(f.model.snapshot().page?.items.map((item) => item.displayStatus)).toEqual([
    "pending_effective",
    "effective",
    "expired",
  ]);
  expect(
    f.model
      .snapshot()
      .page?.items.slice(0, 2)
      .map((item) => item.dramaTitle),
  ).toEqual(["巷口那家店", "巷口那家店"]);
  await f.model.load(true);
  expect(f.model.snapshot().page?.items).toHaveLength(4);
  expect(list).toHaveBeenLastCalledWith(
    { storeId: LICENSE_STORE_ID, orderId: undefined, includeVoided: true },
    "next",
  );
  expect(f.api.summary).toHaveBeenCalledOnce();
  const history = setup({
    list: async () => licenseCards("contracts-license-history"),
    get: async (id) => licenseDetail(id, "contracts-license-history"),
  });
  await history.model.show();
  expect(history.model.snapshot().page?.items.map((item) => item.displayStatus)).toEqual([
    "expired",
    "voided",
  ]);
  await history.model.read(history.model.snapshot().page!.items[0]!);
  expect(history.model.snapshot().detail?.revisions.map((row) => row.reason)).toEqual([
    "correction",
    "period_changed",
    "initial",
  ]);
  await history.model.openPdf(1);
  expect(history.api.download).toHaveBeenCalledWith(LICENSE_IDS.expired, 1);
  await history.model.read(history.model.snapshot().page!.items[1]!);
  expect(history.model.snapshot().detail).toMatchObject({
    currentRevNo: null,
    preview: null,
    canDownload: false,
  });
  await history.model.openPdf();
  expect(history.api.download).toHaveBeenCalledOnce();
  await history.model.openPdf(1);
  expect(history.api.download).toHaveBeenLastCalledWith(LICENSE_IDS.voided, 1);
});

it("当前店老板/店员与停用店证据：不借其他店owner身份，角色/用户/token/修订变更废弃scope", async () => {
  const me = makeMe(),
    input = { token: "fictional-token", storeId: LICENSE_STORE_ID, contextRev: 1, me };
  expect(licenseContext(input).role).toBe("owner");
  const member = me.memberships[0]!;
  const archived = {
    ...me,
    memberships: [
      {
        ...member,
        stores: member.stores.map((store) => ({ ...store, lifecycle: "archived" as const })),
      },
    ],
  };
  expect(licenseContext({ ...input, me: archived }).role).toBe("owner");
  expect(licenseContext({ ...input, me: makeMe(true) }).role).toBe("clerk");
  expect(licenseContext({ ...input, storeId: "unknown" }).role).toBeNull();
  for (const change of [
    { ...input, token: null },
    { ...input, contextRev: 2 },
    { ...input, me: makeMe(true) },
  ])
    expect(licenseContext(change).key).not.toBe(licenseContext(input).key);
  const f = setup();
  f.change({ role: "clerk", key: "clerk" });
  await f.model.show();
  expect(f.model.snapshot().restricted).toBe(true);
  expect(f.api.list).not.toHaveBeenCalled();
  expect(f.api.summary).not.toHaveBeenCalled();
  expect(f.api.get).not.toHaveBeenCalled();
  expect(f.api.download).not.toHaveBeenCalled();
});

it("换店/隐藏的迟到列表不落新scope，不追加旧summary，跨店列表和详情不伪装空数据", async () => {
  const pending = deferred<LicensePage>();
  const f = setup({ list: () => pending.promise });
  const showing = f.model.show();
  f.model.hide();
  f.change({ key: "owner:next", storeId: "another-store" });
  pending.resolve(licenseCards());
  await showing;
  expect(f.model.snapshot().page).toBeNull();
  expect(f.api.summary).not.toHaveBeenCalled();
  const cross = setup({
    list: async () => ({
      ...licenseCards(),
      items: [{ ...licenseCards().items[0]!, storeId: "another-store" }],
    }),
  });
  await cross.model.show();
  expect(cross.model.snapshot()).toMatchObject({ page: null, error: "暂时无法加载授权书，请重试" });
  const detail = setup({
    get: vi.fn<LicenseApi["get"]>(async (id) => ({
      ...licenseDetail(id),
      storeId: "another-store",
    })),
  });
  await detail.model.show();
  await detail.model.read(detail.model.snapshot().page!.items[0]!);
  expect(detail.model.snapshot().detail).toBeNull();
  await detail.model.openPdf();
  expect(detail.api.download).not.toHaveBeenCalled();
  detail.change({ key: "same-store:new-token" });
  await detail.model.read(detail.model.snapshot().page!.items[1]!);
  expect(detail.api.get).toHaveBeenCalledOnce();
});

it("换选中行的旧详情/旧签发与finally不覆盖新详情或打开旧PDF", async () => {
  const oldDetail = deferred<LicenseDetail>(),
    oldSigned = deferred<LicenseDownload>();
  const get = vi
    .fn<LicenseApi["get"]>()
    .mockReturnValueOnce(oldDetail.promise)
    .mockImplementation(async (id) => licenseDetail(id));
  const download = vi
    .fn<LicenseApi["download"]>()
    .mockReturnValueOnce(oldSigned.promise)
    .mockResolvedValue(signed());
  const f = setup({ get, download });
  await f.model.show();
  const items = f.model.snapshot().page!.items;
  const old = f.model.read(items[0]!);
  await f.model.read(items[1]!);
  oldDetail.resolve(licenseDetail(items[0]!.licenseLetterId));
  await old;
  expect(f.model.snapshot().detail?.licenseLetterId).toBe(items[1]!.licenseLetterId);
  const opening = f.model.openPdf();
  await f.model.read(items[2]!);
  oldSigned.resolve(signed());
  await opening;
  expect(f.document.open).not.toHaveBeenCalled();
  expect(f.model.snapshot().detail?.licenseLetterId).toBe(items[2]!.licenseLetterId);
  expect(f.model.snapshot().documentBusy).toBe(false);
  f.change({ key: "changed-before-sign" });
  await f.model.openPdf();
  expect(download).toHaveBeenCalledOnce();
});

it("null文件/缺字不现签；过期、错版及服务端未ready真实失败可重取，URL不保存或泄漏", async () => {
  const blocked = setup({
    list: async () => licenseCards("contracts-license-unavailable"),
    get: async (id) => licenseDetail(id, "contracts-license-unavailable"),
  });
  await blocked.model.show();
  await blocked.model.read(blocked.model.snapshot().page!.items[0]!);
  expect(blocked.model.snapshot().detail).toMatchObject({
    preview: null,
    currentRevNo: null,
    renderIssue: { kind: "missing_glyph" },
  });
  await blocked.model.openPdf();
  expect(blocked.api.download).not.toHaveBeenCalled();
  const download = vi
    .fn<LicenseApi["download"]>()
    .mockResolvedValueOnce({ ...signed(), expiresAt: "2020-01-01T00:00:00Z" })
    .mockResolvedValueOnce(signed(7))
    .mockRejectedValueOnce(
      new ApiError({
        error: "LICENSE_LETTER_NOT_READY",
        status: 409,
        requestId: "fictional",
        message: "secret URL",
        details: { renderStatus: "failed" },
      }),
    )
    .mockResolvedValue(signed(1, 4));
  const f = setup({ download });
  await f.model.show();
  await f.model.read(f.model.snapshot().page!.items[0]!);
  await f.model.openPdf();
  await f.model.openPdf();
  expect(f.document.open).not.toHaveBeenCalled();
  await f.model.openPdf();
  expect(f.model.snapshot().detailError).toContain("PDF生成失败");
  await f.model.openPdf();
  expect(f.document.open).toHaveBeenCalledExactlyOnceWith(signed(1, 4).url, expect.any(Function));
  expect(JSON.stringify(f.model.snapshot())).not.toMatch(/signature=|secret URL|https:\/\/private/);
  expect(download).toHaveBeenCalledTimes(4);
});

it("签发后换店/退出的迟到原生下载被abort，不打开旧文件并清理仅本次临时路径", async () => {
  const downloaded = deferred<{ statusCode: number; tempFilePath: string }>();
  const abort = vi.fn(),
    open = vi.fn(async () => {}),
    unlink = vi.fn(async () => {});
  const document = createContractDocument({
    download: () => ({ promise: downloaded.promise, abort }),
    open,
    unlink,
  });
  const f = setup({}, document);
  await f.model.show();
  await f.model.read(f.model.snapshot().page!.items[0]!);
  const opening = f.model.openPdf();
  await Promise.resolve();
  f.model.hide();
  f.change({ key: "logout", role: null });
  downloaded.resolve({ statusCode: 200, tempFilePath: "/temp/owned-license.pdf" });
  await opening;
  expect(abort).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
  expect(unlink).toHaveBeenCalledExactlyOnceWith("/temp/owned-license.pdf");
});
