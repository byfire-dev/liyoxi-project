import type { Data } from "../src/lib/account-api";
import type { RequestLayer } from "../src/lib/request";
import { ApiError } from "../src/lib/request";
import { CONTRACT_SCENES } from "./contracts-scenes";

export const CONTRACT_OLD_ID = "00000000-0000-4000-8000-000000000041";
const CURRENT_ID = "00000000-0000-4000-8000-000000000042";
const USER_OLD_ID = "00000000-0000-4000-8000-000000000043";
const USER_CURRENT_ID = "00000000-0000-4000-8000-000000000044";
const AT = "2026-08-01T02:30:00.000Z";
const record = {
  consentNo: "202608010000001",
  consentedAt: AT,
  method: "by_action",
  scene: "plan_purchase",
  versionLabel: "v1.0",
} as const;
export function signedContracts(scene: string): Data<"m.agreementConsent.list"> {
  const base = {
    agreementKey: "member",
    name: "套餐服务协议",
    subjectKind: "entity",
    consentedVersion: {
      agreementVersionId: CONTRACT_OLD_ID,
      effectiveAt: AT,
      versionLabel: "v1.0",
    },
    currentVersionId: CURRENT_ID,
    isCurrentVersionConsented: false,
  } as const;
  if (scene === "contracts-clerk" || scene === "contracts-license-clerk")
    return {
      viewerRole: "clerk",
      hasMore: false,
      nextCursor: null,
      items: [
        {
          ...base,
          agreementKey: "user",
          name: "商家服务协议",
          subjectKind: "user",
          consentedVersion: { ...base.consentedVersion, agreementVersionId: USER_OLD_ID },
          currentVersionId: USER_CURRENT_ID,
          firstConsent: { ...record, method: "checkbox", scene: "login" },
          latestConsent: { ...record, method: "checkbox", scene: "login" },
        },
      ],
    };
  const first = {
    ...record,
    bizType: "billing_order",
    bizNo: "FK202608010000001",
    bizTitle: "开通签署时专业版 · 2 个月",
  };
  return {
    viewerRole: "owner",
    hasMore: false,
    nextCursor: null,
    items: [
      {
        ...base,
        firstConsent: first,
        latestConsent: {
          ...first,
          consentNo: "202609010000002",
          consentedAt: "2026-09-01T02:30:00.000Z",
          bizNo: "FK202609010000002",
          bizTitle: "续费专业版 · 3 个月",
        },
      },
    ],
  };
}
export function contractVersion(signature = 1): Data<"m.agreementVersion.get"> {
  return {
    agreementKey: "member",
    agreementVersionId: CONTRACT_OLD_ID,
    name: "套餐服务协议",
    versionLabel: "v1.0",
    effectiveAt: AT,
    major: 1,
    minor: 0,
    phase: "superseded",
    isReconsentRequired: false,
    summary: "本次只读查看购买时确认的服务条款。",
    contentSha256: "0".repeat(64),
    contentHtml:
      "<h2>签署时的服务约定</h2><p>本协议约定门店短剧定制服务、素材提交与交付范围。</p><h3>一、服务期限</h3><p>具体服务期限以确认时的付款单和套餐内容为准。</p><h3>二、服务交付</h3><p>双方按确认的方案开展制作与交付。</p>",
    pdf: {
      url: `https://private.invalid/agreements/old.pdf?signature=${signature}`,
      expiresAt: "2040-01-01T00:00:00.000Z",
    },
  };
}
/** 与 account-fixtures.makeMe 的当前老板门店一致，全部为离线虚构资料。 */
export const LICENSE_STORE_ID = "00000000-0000-4000-8000-000000000001";
export const LICENSE_ORDER_ID = "00000000-0000-4000-8000-000000000150";
export const LICENSE_IDS = {
  pending: "00000000-0000-4000-8000-000000000151",
  effective: "00000000-0000-4000-8000-000000000152",
  expired: "00000000-0000-4000-8000-000000000153",
  voided: "00000000-0000-4000-8000-000000000154",
  blocked: "00000000-0000-4000-8000-000000000155",
  retry: "00000000-0000-4000-8000-000000000156",
  another: "00000000-0000-4000-8000-000000000157",
} as const;
type LicenseCard = Data<"m.licenseLetter.list">["items"][number];
export function licenseCard(id: string, scene = "contracts-license-list"): LicenseCard {
  const pending =
    id === LICENSE_IDS.pending || id === LICENSE_IDS.blocked || id === LICENSE_IDS.another;
  const voided = id === LICENSE_IDS.voided;
  const expired = id === LICENSE_IDS.expired;
  const blocked = id === LICENSE_IDS.blocked;
  const generating = scene === "contracts-license-generating";
  const ready = !blocked && !generating && !voided;
  return {
    licenseLetterId: id,
    letterNo: `SQ2026103000${id.slice(-2)}`,
    orderId: LICENSE_ORDER_ID,
    orderNo: "DG2026103000001",
    orderItemId: id === LICENSE_IDS.effective ? LICENSE_IDS.pending : id,
    storeId: LICENSE_STORE_ID,
    dramaTitle: id === LICENSE_IDS.retry ? "咖啡街角" : expired ? "昨日的光" : "巷口那家店",
    episodeCount: expired ? 36 : 80,
    platform: id === LICENSE_IDS.effective ? "wechat_channels" : "douyin",
    accountName: id === LICENSE_IDS.effective ? "邻里咖啡视频号" : "邻里咖啡福田店",
    status: voided ? "voided" : pending ? "pending_effective" : "effective",
    displayStatus: voided
      ? "voided"
      : expired
        ? "expired"
        : pending
          ? "pending_effective"
          : "effective",
    periodStartDate: pending ? null : "2026-08-01",
    periodEndDate: expired ? "2026-08-31" : "2027-12-31",
    createdAt: AT,
    currentRevNo: ready ? (scene === "contracts-license-history" && expired ? 3 : 1) : null,
    issuedAt: ready ? AT : null,
    isRendering: !ready && !voided,
    voidReason: voided ? "account_removed" : null,
    voidedAt: voided ? "2026-10-30T02:30:00.000Z" : null,
    canDownload: ready,
    renderIssue: blocked
      ? {
          kind: "missing_glyph",
          missing: [{ character: "𠮷", codePoint: "U+20BB7", fields: ["licensee.name"] }],
          totalMissingCodePoints: 1,
          truncated: false,
        }
      : null,
  };
}
export function licenseCards(scene = "contracts-license-list"): Data<"m.licenseLetter.list"> {
  const ids =
    scene === "contracts-license-history"
      ? [LICENSE_IDS.expired, LICENSE_IDS.voided]
      : scene === "contracts-license-unavailable"
        ? [LICENSE_IDS.blocked, LICENSE_IDS.retry]
        : scene === "contracts-license-generating"
          ? [LICENSE_IDS.pending]
          : scene === "contracts-license-list" || scene === "contracts-license-order"
            ? [LICENSE_IDS.pending, LICENSE_IDS.effective, LICENSE_IDS.expired, LICENSE_IDS.another]
            : [];
  return { items: ids.map((id) => licenseCard(id, scene)), hasMore: false, nextCursor: null };
}
export function licenseDetail(
  id: string,
  scene = "contracts-license-list",
): Data<"m.licenseLetter.get"> {
  const card = licenseCard(id, scene);
  const revNo = card.currentRevNo;
  return {
    ...card,
    preview:
      revNo === null
        ? null
        : {
            licensorName: "示例版权方有限公司",
            licensorCreditCodeMask: "9144**********0001",
            licenseeName: "邻里咖啡管理有限公司",
            licenseeCreditCodeMask: "9144**********0002",
            storeName: "邻里咖啡 · 福田店",
            dramaName: card.dramaTitle,
            episodes: card.episodeCount,
            permits: [{ kind: "approval_no", number: "测试备字0001号", platform: "common" }],
            account: {
              platform: card.platform,
              name: card.accountName,
              accountId: "shot-account-001",
            },
            period: {
              startDate: card.periodStartDate,
              startText: card.periodStartDate ?? "自上线首日起",
              endDate: card.periodEndDate,
              territory: "中国大陆",
            },
            clauses: [
              {
                key: "scope",
                title: "授权范围",
                text: "限下单门店在选定发布账号内使用本剧定制内容。",
              },
            ],
            consent: {
              consentNo: "202608010000001",
              agreementName: "短剧定制服务协议",
              consentedAt: AT,
              operatorMask: "林**",
            },
            revNo,
            issuedAt: AT,
            verifyUrl: `https://portal.invalid/v?code=SHOT-LICENSE-${id.slice(-3)}&rev=${revNo}`,
            contentFp: "a".repeat(64),
            signMode: "platform_cert",
          },
    revisions:
      revNo === null && card.status !== "voided"
        ? []
        : Array.from(
            { length: revNo ?? 1 },
            (_, index): Data<"m.licenseLetter.get">["revisions"][number] => ({
              revNo: (revNo ?? 1) - index,
              reason:
                (revNo ?? 1) - index === 1
                  ? "initial"
                  : (revNo ?? 1) - index === 2
                    ? "period_changed"
                    : "correction",
              issuedAt: AT,
            }),
          ),
  };
}
type Evidence = { path: string; method: string; data?: unknown; idempotencyKey?: string };
let signature = 0;
const licenseSignatures = new Map<string, number>();
export function offlineContractsRequest(scene: string): RequestLayer["request"] {
  if (!CONTRACT_SCENES.some((item) => item.name === scene)) throw new Error("未知合同样张");
  return async <T>(path: string, options?: Parameters<RequestLayer["request"]>[1]) => {
    const target = globalThis as { __LYX_CONTRACT_CALLS__?: Evidence[] };
    target.__LYX_CONTRACT_CALLS__ ??= [];
    target.__LYX_CONTRACT_CALLS__.push({
      path,
      method: options?.method ?? "GET",
      ...(options?.data === undefined ? {} : { data: options.data }),
      ...(options?.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    });
    const clerk = scene === "contracts-clerk" || scene === "contracts-license-clerk";
    const url = new URL(path, "https://request.invalid");
    if (url.pathname.startsWith("/m/license-letters")) {
      if (clerk) throw new Error("店员样张不得查询授权书");
      const rows = licenseCards(scene).items;
      const download = /^\/m\/license-letters\/([^/]+)\/download-urls$/.exec(url.pathname);
      if (download) {
        if (options?.method !== "POST" || options.idempotencyKey !== undefined)
          throw new Error("授权书只能通过无幂等键POST现签");
        const body = options.data as { revNo?: unknown } | undefined;
        if (!body || Object.keys(body).some((key) => key !== "revNo"))
          throw new Error("授权书现签参数不符合契约");
        const row = rows.find((item) => item.licenseLetterId === download[1]);
        const detail = row ? licenseDetail(row.licenseLetterId, scene) : null;
        const revNo = body.revNo === undefined ? row?.currentRevNo : body.revNo;
        if (
          !row ||
          !detail ||
          typeof revNo !== "number" ||
          !detail.revisions.some((item) => item.revNo === revNo)
        )
          throw new ApiError({
            error: "LICENSE_LETTER_NOT_READY",
            status: 409,
            requestId: "shot-license-not-ready",
            message: "PDF尚未生成",
            details: { renderStatus: "failed" },
          });
        const key = `${scene}:${row.licenseLetterId}`;
        const attempt = (licenseSignatures.get(key) ?? 0) + 1;
        licenseSignatures.set(key, attempt);
        if (scene === "contracts-license-unavailable" && attempt === 1)
          throw new ApiError({
            error: "FILE_NOT_AVAILABLE",
            status: 409,
            requestId: "shot-license-file",
            message: "PDF暂不可用",
          });
        return {
          url: `https://private.invalid/licenses/${row.licenseLetterId}/rev-${revNo}.pdf?signature=${attempt}`,
          expiresAt: "2040-01-01T00:00:00.000Z",
          fileName: `定制内容授权书_${row.dramaTitle}_第${revNo}版.pdf`,
          revNo,
        } satisfies Data<"m.licenseLetter.downloadUrls"> as T;
      }
      if (options?.method && options.method !== "GET") throw new Error("授权书样张禁止业务写操作");
      if (url.pathname === "/m/license-letters" || url.pathname === "/m/license-letters/summary") {
        if (url.searchParams.get("storeId") !== LICENSE_STORE_ID)
          throw new Error("授权书列表与计数必须明确当前门店");
        if (
          scene === "contracts-license-order" &&
          url.searchParams.get("orderId") !== LICENSE_ORDER_ID
        )
          throw new Error("订单授权书样张必须保留实际URL的订单范围");
        const filtered = rows.filter(
          (row) =>
            (url.searchParams.get("includeVoided") === "true" || row.status !== "voided") &&
            (!url.searchParams.get("orderId") || row.orderId === url.searchParams.get("orderId")),
        );
        if (url.pathname.endsWith("/summary"))
          return {
            all: filtered.length,
            effective: filtered.filter((item) => item.displayStatus === "effective").length,
          } satisfies Data<"m.licenseLetter.summary"> as T;
        const cursor = url.searchParams.get("cursor");
        if (cursor !== null && cursor !== "license-next+/?")
          throw new Error("授权书游标未正确传回");
        const items = cursor ? filtered.slice(3) : filtered.slice(0, 3);
        const hasMore = !cursor && filtered.length > 3;
        return {
          items,
          hasMore,
          nextCursor: hasMore ? "license-next+/?" : null,
        } satisfies Data<"m.licenseLetter.list"> as T;
      }
      const id = url.pathname.split("/").at(-1)!;
      if (!rows.some((row) => row.licenseLetterId === id))
        throw new Error("授权书样张ID不属当前列表");
      return licenseDetail(id, scene) as T;
    }
    if (options?.method && options.method !== "GET") throw new Error("合同样张禁止协议写操作");
    if (path.startsWith("/m/agreement-consents?")) return signedContracts(scene) as T;
    if (path === "/m/agreement-consents/summary" && !clerk)
      return { all: 1 } satisfies Data<"m.agreementConsent.summary"> as T;
    if (clerk && path === `/m/agreement-versions/${USER_OLD_ID}`) {
      return {
        ...contractVersion(++signature),
        agreementKey: "user",
        agreementVersionId: USER_OLD_ID,
        name: "商家服务协议",
        summary: "本次只读查看本人登录时确认的用户协议。",
        contentSha256: "1".repeat(64),
        contentHtml:
          "<h2>本人确认的用户协议</h2><p>本协议约定商家账号的注册、登录与使用规则。</p><h3>一、账号使用</h3><p>请妥善保管本人账号，只在授权范围内使用门店功能。</p><h3>二、个人信息</h3><p>平台按隐私政策保护个人信息；账号信息发生变化时应及时更新。</p>",
      } satisfies Data<"m.agreementVersion.get"> as T;
    }
    if (!clerk && path === `/m/agreement-versions/${CONTRACT_OLD_ID}`)
      return contractVersion(++signature) as T;
    throw new Error("合同样张不支持该请求");
  };
}
