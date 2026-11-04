import {
  PortalAdPageSchema,
  PortalDownloadResultSchema,
  PortalOrderItemPageSchema,
  PortalReleaseViewSchema,
  PortalSessionViewSchema,
  PortalTicketCreatedSchema,
  PortalTicketExchangeResultSchema,
  PortalTicketStatusViewSchema,
  PublishListViewSchema,
} from "@liyoxi/contract";

export const ORIGIN = "http://127.0.0.1:5194";
export const ITEM_ID = "019a4500-0000-7000-8000-000000000010";
export const NEXT_ITEM_ID = "019a4500-0000-7000-8000-000000000011";
export const DRAMA_TITLE = "契约冒烟测试剧";
export const NEXT_TITLE = "第二页测试剧";
export const STORE_NAME = "浏览器隔离测试门店";
export const POLL_SECRET = "m".repeat(43);
export const FILE_CONTENT = "MIGRATION_UI_DOWNLOAD_FIXTURE_ONLY\n";

/** Validate every mocked successful DTO with the same schemas that define the real API. */
export function createFixtures(mediaOrigin: string, now = Date.now()) {
  const instant = (offset: number) => new Date(now + offset).toISOString();
  const session = PortalSessionViewSchema.parse({
    portalSessionId: "019a4500-0000-7000-8000-000000000001",
    entityId: "019a4500-0000-7000-8000-000000000002",
    storeId: "019a4500-0000-7000-8000-000000000003",
    storeName: STORE_NAME,
    entityName: "浏览器隔离测试主体",
    authorizerPhoneMask: "138****0000",
    isStoreArchived: false,
    grantScope: "store",
    capabilities: ["delivery.download", "ad.view"],
    authorizedAt: instant(-60_000),
    expiresAt: instant(7_200_000),
    serverTime: instant(0),
  });
  const ticket = PortalTicketCreatedSchema.parse({
    portalTicketId: "019a4500-0000-7000-8000-000000000004",
    qrUrl: `${ORIGIN}/a?t=migration-public-id`,
    shortCode: "ABCDEFGH",
    pairDigits: "42",
    pollSecret: POLL_SECRET,
    expiresAt: instant(120_000),
    pollIntervalMs: 2000,
  });
  const grant = { state: "active", expiresAt: instant(86_400_000), isExpired: false } as const;
  const brief = {
    deliveryReleaseId: "019a4500-0000-7000-8000-000000000020",
    releaseNo: 2,
    kind: "reissue",
    pushedAt: instant(-30_000),
    episodeCount: 2,
    totalBytes: "41943040",
    changedEpisodeNos: [2],
  } as const;
  const card = {
    orderItemId: ITEM_ID,
    orderId: "019a4500-0000-7000-8000-000000000030",
    orderNo: "LYXMIGRATION0001",
    dramaTitle: DRAMA_TITLE,
    poster: null,
    episodeCount: 2,
    phase: "to_launch",
    usageEndDate: instant(30 * 86_400_000).slice(0, 10),
    release: brief,
    grant,
    isDownloadable: true,
    downloadBlocker: null,
    pendingSample: null,
    activityAt: instant(-30_000),
  };
  const release = PortalReleaseViewSchema.parse({
    ...brief,
    orderItemId: ITEM_ID,
    orderNo: card.orderNo,
    dramaTitle: DRAMA_TITLE,
    usageEndDate: card.usageEndDate,
    state: "pushed",
    closeReason: null,
    reissueReason: { code: "content_fix", name: "测试内容修订" },
    episodes: [1, 2].map((episodeNo) => ({
      episodeNo,
      fileName: `migration-episode-${episodeNo}.mp4`,
      sizeBytes: "20971520",
      isChanged: episodeNo === 2,
      lastPortalDownloadAt: null,
    })),
    grant,
    isDownloadable: true,
    downloadBlocker: null,
    zipFileName: "migration-package.zip",
    hasPublishList: true,
  });
  const publishList = PublishListViewSchema.parse({
    orderItemId: ITEM_ID,
    releaseNo: 2,
    collectionName: DRAMA_TITLE,
    cover: null,
    topics: ["测试话题"],
    intro: "仅用于隔离浏览器验证",
    isAiDeclarationRequired: true,
    episodes: [1, 2].map((episodeNo) => ({
      episodeNo,
      title: `测试第${episodeNo}集`,
      topics: ["测试话题"],
      intro: null,
      isUpdated: episodeNo === 2,
    })),
    text: "契约冒烟发布清单\n测试第1集\n测试第2集",
  });
  return {
    session,
    ticket,
    status: (approved: boolean) =>
      PortalTicketStatusViewSchema.parse({
        portalTicketId: ticket.portalTicketId,
        status: approved ? "approved" : "pending",
        expiresAt: ticket.expiresAt,
      }),
    exchange: PortalTicketExchangeResultSchema.parse({
      status: "consumed",
      session,
      rejectReason: null,
    }),
    firstPage: PortalOrderItemPageSchema.parse({
      items: [card],
      nextCursor: "migration-page-2",
      hasMore: true,
    }),
    secondPage: PortalOrderItemPageSchema.parse({
      items: [{ ...card, orderItemId: NEXT_ITEM_ID, dramaTitle: NEXT_TITLE }],
      nextCursor: null,
      hasMore: false,
    }),
    ads: PortalAdPageSchema.parse({ items: [], nextCursor: null, hasMore: false }),
    release,
    publishList,
    download: (
      kind: "episode" | "zip" | "publish_list",
      state: "ready" | "building" | "failed" | "none" = "ready",
    ) =>
      PortalDownloadResultSchema.parse({
        kind,
        state,
        downloadId: state === "ready" ? "019a4500-0000-7000-8000-000000000040" : null,
        episodeNo: kind === "episode" ? 1 : null,
        url: state === "ready" ? `${mediaOrigin}/__migration-files__/${kind}` : null,
        expiresAt: state === "ready" ? instant(900_000) : null,
        fileName:
          state !== "ready"
            ? null
            : kind === "episode"
              ? "migration-episode-1.mp4"
              : kind === "zip"
                ? "migration-package.zip"
                : "migration-publish-list.txt",
        sizeBytes: state === "ready" ? String(Buffer.byteLength(FILE_CONTENT)) : null,
        pollAfterSec: kind === "zip" && state === "building" ? 5 : null,
      }),
  };
}
