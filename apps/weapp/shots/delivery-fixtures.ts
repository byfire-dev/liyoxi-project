import { ApiError } from "../src/lib/request";
import { useSessionStore } from "../src/stores/session";
import type { Data } from "../src/lib/account-api";
import type { RequestLayer } from "../src/lib/request";
export const DELIVERY_ID = "00000000-0000-4000-8000-000000000020";
const now = "2026-10-07T02:00:00Z";
const account = {
  channelAccountId: DELIVERY_ID,
  platform: "douyin" as const,
  accountName: "邻里咖啡",
  accountUid: "neighbor",
  status: "available" as const,
};
export const plan: Data<"m.deliveryPlan.get"> = {
  deliveryPlanId: DELIVERY_ID,
  orderId: DELIVERY_ID,
  orderNo: "LYX202610070001",
  planCode: "PL202610070001",
  status: "pending_confirm",
  currentVersionNo: 2,
  confirmedVersionNo: null,
  confirmedAt: null,
  staffDueAt: null,
  isOrderInAfterSale: false,
  deliveryManagerName: "林经理",
  version: {
    versionNo: 2,
    pushedAt: now,
    pushedByName: "林经理",
    changeSummary: "更新上线安排",
    decision: null,
    decidedAt: null,
  },
  content: {
    focusTags: ["门店环境", "主推咖啡"],
    referenceAssets: [],
    profileMedia: [],
    note: "突出街角小店的日常氛围",
    launchMode: "merchant_self",
    items: [
      {
        orderItemId: DELIVERY_ID,
        dramaTitle: "烟火里的重逢",
        genres: [{ code: "life", name: "都市生活" }],
        posterUrl: null,
        episodeCount: 60,
        usageEndDate: "2027-03-31",
        productionModel: "advanced",
        accounts: [account],
        placements: [],
        agreedLaunchDate: "2026-10-20",
        expectedDeliveryDate: "2026-10-17",
      },
    ],
  },
  itemCount: 1,
  totalEpisodes: 60,
  openChange: null,
  changeRequests: [],
  actions: ["confirm", "request-change"],
};
export const sample: NonNullable<Data<"m.orderItem.sample.get">> = {
  sampleId: DELIVERY_ID,
  orderItemId: DELIVERY_ID,
  dramaTitle: "烟火里的重逢",
  versionNo: 2,
  status: "pushed",
  durationMs: 120000,
  pushedAt: now,
  previewChannels: ["album"],
  adSlots: [],
  adsUsed: [],
  qcSummary: [
    { key: "video", label: "画面与声音", result: "pass", note: "完整可查看" },
    { key: "brand", label: "门店资料", result: "pass", note: null },
  ],
  firstViewedAt: null,
  viewEvidence: { albumSavedAt: null, portalViewedAt: null },
  offlineSentAt: null,
  confirmableVia: [],
  viewedAckAt: null,
  decision: null,
  playable: null,
  ticketStep: "sample_confirm",
  isPaused: false,
  sampleRoundNo: 1,
  agreedLaunchDate: "2026-10-20",
  actions: ["download", "confirm"],
};
export const release: NonNullable<Data<"m.orderItem.release.get">> = {
  deliveryReleaseId: DELIVERY_ID,
  orderItemId: DELIVERY_ID,
  releaseNo: 1,
  kind: "initial",
  state: "pushed",
  closeReason: null,
  pushedAt: now,
  episodeCount: 60,
  totalBytes: "9000000000",
  changedEpisodeNos: [],
  episodes: Array.from({ length: 60 }, (_, i) => i + 1).map((n) => ({
    episodeNo: n,
    fileName: `烟火里的重逢_第${n}集.mp4`,
    sizeBytes: "150000000",
    isChanged: false,
    lastSavedAt: null,
  })),
  savedEpisodeCount: 0,
  grant: {
    downloadGrantId: DELIVERY_ID,
    state: "active",
    expiresAt: "2026-10-21T16:00:00Z",
    validDays: 14,
    isExpired: false,
    createdAt: now,
  },
  regrantRemainingToday: 1,
  isDownloadable: true,
  canRegenerate: false,
};
export const task: Data<"m.launchTask.get"> = {
  task: {
    launchTaskId: DELIVERY_ID,
    orderItemId: DELIVERY_ID,
    platform: "douyin",
    channelAccount: account,
    reviewStatus: "pending",
    isLive: false,
    wentLiveAt: null,
    verifiedEpisodeCount: 0,
    firstLaunchDate: null,
    completedAt: null,
    voidReason: null,
    latestSubmission: null,
    reviewDueAt: null,
    returnInfo: null,
    actions: ["submit"],
  },
  accountType: null,
  launch: null,
  verifyChecks: [],
  timeline: [
    {
      kind: "created",
      at: now,
      roundNo: 0,
      linkKind: null,
      reportedEpisodeCount: null,
      verifiedEpisodeCount: null,
      reasons: [],
      note: null,
    },
  ],
  patrols: [],
};
export const tasks: Data<"m.launchTask.list"> = {
  items: [
    {
      orderId: DELIVERY_ID,
      orderNo: "LYX202610070001",
      agreedLaunchDate: "2026-10-20",
      daysUntilLaunch: 13,
      items: [
        {
          orderItemId: DELIVERY_ID,
          dramaTitle: "烟火里的重逢",
          posterUrl: null,
          episodeCount: 60,
          phase: "to_launch",
          liveEpisodeCount: 0,
          agreedLaunchDate: "2026-10-20",
          usageEndDate: "2027-03-31",
          ticketStep: "awaiting_launch",
          isPaused: false,
          release: {
            deliveryReleaseId: DELIVERY_ID,
            releaseNo: 1,
            episodeCount: 60,
            totalBytes: "9000000000",
            grantExpiresAt: release.grant!.expiresAt,
            isGrantValid: true,
            savedEpisodeCount: 0,
            hasChangedEpisodes: false,
          },
          tasks: [task.task],
        },
      ],
    },
  ],
  nextCursor: null,
  hasMore: false,
};
export function offlineDeliveryRequest(scene: string): RequestLayer["request"] {
  const p = structuredClone(plan),
    s = structuredClone(sample),
    r = structuredClone(release),
    t = structuredClone(task),
    list = structuredClone(tasks);
  if (scene === "plan-revising") {
    p.status = "revising";
    p.actions = ["request-change"];
    p.openChange = { kinds: ["launch_date"], notes: ["调整至月底上线"] };
  }
  if (scene === "plan-confirmed") {
    p.status = "confirmed";
    p.confirmedAt = now;
    p.confirmedVersionNo = 2;
    p.actions = [];
  }
  if (scene === "sample-confirmed") {
    s.status = "confirmed";
    s.actions = [];
    s.decision = {
      decidedAt: now,
      viewedVia: "album",
      feedbackKind: null,
      feedbackNote: null,
      feedbackImages: [],
      isOnBehalf: false,
    };
  }
  if (scene === "downloads-expired") {
    r.grant!.isExpired = true;
    r.isDownloadable = false;
  }
  if (scene === "tasks-verifying") {
    t.task.reviewStatus = "verifying";
    t.task.actions = [];
  }
  if (scene === "tasks-live") {
    t.task.reviewStatus = "passed";
    t.task.isLive = true;
    t.task.verifiedEpisodeCount = 60;
    t.task.firstLaunchDate = "2026-10-07";
    t.task.actions = [];
  }
  if (scene === "record-returned") {
    t.task.reviewStatus = "need_fix";
    t.task.returnInfo = {
      reasons: [{ code: "missing", name: "链接不完整" }],
      note: "请补充其余集数",
      decidedAt: now,
    };
    t.timeline.push({
      kind: "returned",
      at: now,
      roundNo: 1,
      linkKind: "collection",
      reportedEpisodeCount: 30,
      verifiedEpisodeCount: 0,
      reasons: [{ code: "missing", name: "链接不完整" }],
      note: "请补充其余集数",
    });
  }
  if (scene.startsWith("record") || scene === "tasks-verifying" || scene === "tasks-live") {
    t.launch = {
      linkKind: "collection",
      collectionUrl: "https://example.test/collection",
      episodeUrls: [],
      reportedEpisodeCount: 30,
      verifiedEpisodeCount: t.task.verifiedEpisodeCount,
      actualLaunchDate: "2026-10-07",
      verifiedAt: null,
      verifiedByName: null,
    };
    t.task.latestSubmission = {
      roundNo: 1,
      linkKind: "collection",
      collectionUrl: "https://example.test/collection",
      episodeUrlCount: 0,
      reportedEpisodeCount: 30,
      actualLaunchDate: "2026-10-07",
      submittedAt: now,
      result: "pending",
    };
  }
  list.items[0]!.items[0]!.tasks = [t.task];
  const state = globalThis as {
    __LYX_DELIVERY_CALLS__?: { path: string; data: unknown; key?: string; method: string }[];
  };
  state.__LYX_DELIVERY_CALLS__ = [];
  let held: string | null = null,
    releaseHeld: ((value: boolean) => void) | null = null;
  const failures = new Set<string>();
  const controls = {
    nextSample() {
      s.versionNo++;
      s.sampleId = "00000000-0000-4000-8000-000000000021";
      s.status = "pushed";
      s.confirmableVia = [];
      s.actions = ["confirm"];
    },
    fail(path: string) {
      failures.add(path);
    },
    hold(path: string) {
      held = path;
    },
    release(fail = false) {
      releaseHeld?.(fail);
      releaseHeld = null;
    },
    clerk() {
      const me = useSessionStore.getState().me as Data<"m.me.get">;
      useSessionStore.setState({
        me: { ...me, memberships: me.memberships.map((m) => ({ ...m, role: "clerk" })) },
      });
    },
  };
  (globalThis as { __LYX_DELIVERY_CONTROL__?: typeof controls }).__LYX_DELIVERY_CONTROL__ =
    controls;
  return (async (path, options = {}) => {
    state.__LYX_DELIVERY_CALLS__!.push({
      path,
      data: options.data,
      key: options.idempotencyKey,
      method: options.method ?? "GET",
    });
    if (held === path) {
      held = null;
      const fail = await new Promise<boolean>((resolve) => {
        releaseHeld = resolve;
      });
      if (fail) throw new Error("迟到保存失败");
    }
    if (failures.delete(path))
      throw new ApiError({
        error: "NETWORK_ERROR",
        status: 0,
        requestId: "offline",
        message: "网络暂时中断，请重试",
      });
    if (path.endsWith("/confirm") && path.includes("delivery-plans")) {
      p.status = "confirmed";
      p.actions = [];
      return { ...p, replayed: true };
    }
    if (path.endsWith("/request-change")) {
      p.status = "revising";
      p.openChange = { kinds: ["launch_date"], notes: ["调整至月底上线"] };
      return { ...p, replayed: true };
    }
    if (path.startsWith("/m/delivery-plans/")) return structuredClone(p);
    if (path.endsWith("/sample")) return structuredClone(s);
    if (path.includes("/samples/") && path.endsWith("/download-urls")) {
      s.confirmableVia = ["album"];
      s.viewEvidence.albumSavedAt = now;
      return {
        url: "https://example.test/sample.mp4",
        fileName: "烟火里的重逢_样片_第2版.mp4",
        sizeBytes: "12000000",
        expiresAt: "2026-10-07T02:15:00Z",
      };
    }
    if (path.includes("/samples/") && path.endsWith("/confirm")) {
      s.status = "confirmed";
      s.actions = [];
      return { ...s, replayed: true };
    }
    if (path.endsWith("/release")) return structuredClone(r);
    if (path.includes("order-items") && path.endsWith("/download-urls"))
      return {
        url: "https://example.test/episode.mp4",
        downloadId: DELIVERY_ID,
        fileName: "烟火里的重逢_第1集.mp4",
        sizeBytes: "150000000",
        expiresAt: "2026-10-07T02:15:00Z",
      };
    if (path === "/m/launch-tasks/summary")
      return { todo: 1, done: 0, needFix: scene === "record-returned" ? 1 : 0 };
    if (path.startsWith("/m/launch-tasks?")) return structuredClone(list);
    if (path.endsWith("/submit")) return { ...t, replayed: true };
    if (path.startsWith("/m/launch-tasks/")) return structuredClone(t);
    throw new Error(`未登记离线交付请求 ${path}`);
  }) as RequestLayer["request"];
}
