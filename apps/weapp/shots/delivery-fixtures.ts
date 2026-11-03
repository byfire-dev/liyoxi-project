import { ApiError } from "../src/lib/request";
import { useSessionStore } from "../src/stores/session";
import { useBootstrapStore } from "../src/stores/bootstrap";
import type { Data } from "../src/lib/account-api";
import type { RequestLayer } from "../src/lib/request";
import feedbackCover from "../src/sub/gallery/assets/sample-cover.png";
export const feedbackScreenshot = {
  fileId: "00000000-0000-4000-8000-000000000091",
  src: feedbackCover,
};
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
  previewChannels: ["weapp"],
  adSlots: [{ slot: "opening", startMs: 0, endMs: 5000, label: "品牌露出" }],
  adsUsed: [],
  qcSummary: [
    { key: "video", label: "画面与声音", result: "pass", note: "完整可查看" },
    { key: "brand", label: "门店资料", result: "pass", note: null },
  ],
  firstViewedAt: null,
  viewEvidence: { albumSavedAt: null, portalViewedAt: null },
  offlineSentAt: null,
  confirmableVia: ["weapp"],
  viewedAckAt: null,
  decision: null,
  playable: {
    playableId: DELIVERY_ID,
    kind: "sample",
    durationMs: 120000,
    width: 720,
    height: 1280,
    posterUrl: null,
    sources: [
      {
        quality: "source",
        url: "/sample-preview.mp4",
        width: 720,
        height: 1280,
        bitrateKbps: null,
      },
    ],
    expiresAt: "2099-10-07T03:00:00Z",
    autoplay: false,
    muted: false,
  },
  ticketStep: "sample_confirm",
  isPaused: false,
  sampleRoundNo: 1,
  agreedLaunchDate: "2026-10-20",
  actions: ["confirm"],
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
export const takedown: Data<"m.takedownTask.list">["items"][number] = {
  takedownTaskId: "00000000-0000-4000-8000-000000000071",
  status: "pending_merchant",
  triggerKind: "expiry",
  basis: "live",
  orderNo: "LYX202610070001",
  orderItemId: DELIVERY_ID,
  orderId: DELIVERY_ID,
  dramaTitle: "烟火里的重逢",
  episodeCount: 60,
  usageEndDate: "2026-10-06",
  dueDate: "2026-10-06",
  isOverdue: true,
  merchantMethod: null,
  merchantConfirmedAt: null,
  checkedAt: null,
  stillOnlineCount: 1,
  escalatedAt: null,
  posterUrl: null,
  channelAccount: account,
  allowedMethods: ["delete", "private"],
  actions: ["confirm"],
};
export function offlineDeliveryRequest(scene: string): RequestLayer["request"] {
  const p = structuredClone(plan),
    s = structuredClone(sample),
    r = structuredClone(release),
    t = structuredClone(task),
    list = structuredClone(tasks),
    offline = structuredClone(takedown);
  if (scene === "record-patrol-recovered")
    t.patrols = [
      {
        patrolTaskId: DELIVERY_ID,
        status: "recovered",
        checkedAt: now,
        checkedByName: "林经理",
        results: [
          { key: "visibility", label: "作品可正常访问", result: "pass", note: "已重新公开" },
        ],
        abnormalKind: { code: "private", name: "作品不可见" },
        note: "复查作品已公开",
        foundAt: "2026-10-06T02:00:00Z",
        recoveredAt: now,
      },
    ];
  if (scene.startsWith("sample-")) {
    const bootstrap = useBootstrapStore.getState();
    bootstrap.apply(
      {
        flags: {
          ...bootstrap.data.flags,
          "weapp.video.sample.enabled": scene !== "sample-disabled",
        },
      },
      Date.now(),
    );
  }
  if (scene === "sample-legacy") {
    s.previewChannels = ["album", "portal", "wecom"];
    s.confirmableVia = [];
    s.playable!.sources = [];
    s.playable!.expiresAt = null;
  }
  if (scene === "sample-change" || scene === "sample-change-stale")
    s.actions = ["confirm", "request-change"];
  if (scene === "sample-paused") {
    s.isPaused = true;
    s.actions = [];
    s.confirmableVia = [];
  }
  if (scene === "sample-disabled") {
    s.confirmableVia = [];
    s.playable!.sources = [];
    s.playable!.expiresAt = null;
  }
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
      viewedVia: "weapp",
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
      s.decision = null;
      s.viewedAckAt = null;
      s.confirmableVia = ["weapp"];
      s.actions = scene === "sample-change-stale" ? ["confirm", "request-change"] : ["confirm"];
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
    if (path.includes("/m/samples/") && path.endsWith("/request-change")) {
      const body = options.data as { note: string; imageFileIds?: string[] };
      s.status = "change_requested";
      s.actions = [];
      s.confirmableVia = [];
      s.decision = {
        decidedAt: now,
        viewedVia: null,
        feedbackKind: "compose",
        feedbackNote: body.note,
        feedbackImages: (body.imageFileIds ?? []).map((fileId) => ({
          fileId,
          url: feedbackScreenshot.src,
          expiresAt: "2099-10-07T03:00:00Z",
        })),
        isOnBehalf: false,
      };
      return { ...s, replayed: true };
    }
    if (path.endsWith("/request-change")) {
      p.status = "revising";
      p.openChange = { kinds: ["launch_date"], notes: ["调整至月底上线"] };
      return { ...p, replayed: true };
    }
    if (path.startsWith("/m/delivery-plans/")) return structuredClone(p);
    if (path.endsWith("/sample")) return scene === "sample-empty" ? null : structuredClone(s);
    if (path.includes("/samples/") && path.endsWith("/confirm")) {
      s.status = "confirmed";
      s.actions = [];
      return { ...s, replayed: true };
    }
    if (path.endsWith("/release")) return structuredClone(r);
    if (path.endsWith("/publish-list"))
      return {
        orderItemId: DELIVERY_ID,
        releaseNo: 1,
        collectionName: "烟火里的重逢",
        cover: null,
        topics: ["邻里咖啡"],
        intro: "街角咖啡店的故事",
        isAiDeclarationRequired: false,
        episodes: [
          {
            episodeNo: 1,
            title: "第 1 集：再次相遇",
            topics: ["邻里咖啡"],
            intro: null,
            isUpdated: false,
          },
        ],
        text:
          scene === "tasks-copy-unavailable" ? null : "烟火里的重逢\n第 1 集：再次相遇\n#邻里咖啡",
      } satisfies Data<"m.orderItem.publishList.get">;
    if (path.startsWith("/m/takedown-tasks/summary"))
      return {
        pending:
          scene.startsWith("tasks-takedown") &&
          scene !== "tasks-takedown-empty" &&
          offline.status === "pending_merchant"
            ? 1
            : 0,
        done: offline.status === "merchant_confirmed" ? 1 : 0,
        overdue:
          scene.startsWith("tasks-takedown") &&
          scene !== "tasks-takedown-empty" &&
          offline.status === "pending_merchant"
            ? 1
            : 0,
        nextTakedown:
          scene === "tasks-takedown-empty"
            ? {
                orderItemId: DELIVERY_ID,
                dramaTitle: "烟火里的重逢",
                usageEndDate: "2027-03-31",
                createDate: "2027-03-01",
              }
            : null,
      } satisfies Data<"m.takedownTask.summary">;
    if (path.startsWith("/m/takedown-tasks?")) {
      const tab = new URLSearchParams(path.split("?")[1]).get("tab");
      return {
        items:
          scene.startsWith("tasks-takedown") &&
          scene !== "tasks-takedown-empty" &&
          (tab === "pending"
            ? offline.status === "pending_merchant"
            : offline.status !== "pending_merchant")
            ? [structuredClone(offline)]
            : [],
        hasMore: false,
        nextCursor: null,
      } satisfies Data<"m.takedownTask.list">;
    }
    if (path.startsWith("/m/takedown-tasks/") && path.endsWith("/confirm")) {
      const body = options.data as { method: "delete" | "private" | "not_published" };
      if (!options.idempotencyKey || Object.keys(body).join() !== "method")
        throw new Error("下架确认必须仅提交 method 和幂等键");
      offline.status = "merchant_confirmed";
      offline.merchantMethod = body.method;
      offline.merchantConfirmedAt = now;
      offline.actions = [];
      offline.allowedMethods = [];
      return {
        ...offline,
        posterUrl: null,
        replayed: true,
      } satisfies Data<"m.takedownTask.confirm">;
    }
    if (path.includes("order-items") && path.endsWith("/download-urls"))
      return {
        url: "https://example.test/episode.mp4",
        downloadId: DELIVERY_ID,
        fileName: "烟火里的重逢_第1集.mp4",
        sizeBytes: "150000000",
        expiresAt: "2026-10-07T02:15:00Z",
      };
    if (path.startsWith("/m/launch-tasks/summary"))
      return { todo: 1, done: 0, needFix: scene === "record-returned" ? 1 : 0 };
    if (path.startsWith("/m/launch-tasks?")) {
      if (
        scene.startsWith("tasks-takedown") &&
        new URLSearchParams(path.split("?")[1]).get("tab") === "done"
      )
        return { items: [], nextCursor: null, hasMore: false } satisfies Data<"m.launchTask.list">;
      return structuredClone(list);
    }
    if (path.endsWith("/submit")) return { ...t, replayed: true };
    if (path.startsWith("/m/launch-tasks/")) {
      if (scene === "record-patrol-error") throw new Error("巡检与上线记录读取失败，请重试");
      return structuredClone(t);
    }
    throw new Error(`未登记离线交付请求 ${path}`);
  }) as RequestLayer["request"];
}
