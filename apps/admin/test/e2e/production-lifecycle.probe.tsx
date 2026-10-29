// 组件层生命周期探针：API 都是显式 stub；不代替 live 业务链验收。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BatchUploadCredentialsSchema,
  DeliveryTicketDetailSchema,
  UploadBatchCreateBodySchema,
  UploadBatchDetailSchema,
  UploadBatchItemSchema,
  type UploadBatchDetail,
} from "@liyoxi/contract";
import { AccessContext, type AccessSnapshot } from "../../src/lib/permissions";
import type { DetailApi, Grid, Template } from "../../src/features/delivery/ticket-detail/api";
import { QualityModal } from "../../src/features/delivery/ticket-detail/quality";
import type { BatchApi } from "../../src/features/delivery/ticket-detail/batch-api";
import {
  batchFixture,
  batchId,
  batchItem,
} from "../../src/features/delivery/ticket-detail/batch-test.fixture";
import {
  EpisodeRegisterModal,
  SampleUploadModal,
} from "../../src/features/delivery/ticket-detail/uploads";

type Scenario = "sample-qc" | "sample-recovery" | "episode-qc" | "sample-upload" | "episode-upload";
type Change = "preview" | "sample" | "sample-version" | "episode" | "template" | "item" | "ticket";
interface Sent {
  method: string;
  id: string;
  body: unknown;
  key: string;
}
interface Registration {
  body: unknown;
  fileId: string;
  signal?: AbortSignal;
  release(): void;
}
export interface LifecycleProbe {
  change(change: Change): void;
  close(): void;
  open(): void;
  release(index: number): void;
  snapshot(): {
    registrations: { body: unknown; fileId: string; aborted: boolean }[];
    sent: Sent[];
    completed: string[];
  };
}
declare global {
  interface Window {
    productionLifecycle: LifecycleProbe;
  }
}
const scenario = new URLSearchParams(location.search).get("scenario") as Scenario;
const query = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
const access: AccessSnapshot = {
  staff: { id: "probe-reviewer", name: "测试质检员", roleKey: "super_admin", roleName: "管理员" },
  isLead: true,
  moduleLevels: { delivery: "e" },
  actions: [
    "delivery.sample.qc",
    "delivery.sample.push",
    "delivery.episode.qc",
    "delivery.sample.upload",
    "delivery.episode.register",
  ],
  dataScope: "all",
  releases: {},
};
// Samples-only complete DTO: schema validation catches protocol drift before mounting a modal.
const probeAt = "2026-10-09T00:00:00.000Z";
const store = {
  storeId: batchId(905),
  storeName: "测试门店",
  entityId: batchId(906),
  entityName: "组件探针主体",
  city: null,
  district: null,
  qualificationStatus: "verified",
};
const staff = {
  staffId: batchId(907),
  staffNo: 1001,
  name: "测试质检员",
  roleKey: "super_admin",
  isLead: true,
  status: "active",
};
const initialTicket = DeliveryTicketDetailSchema.parse({
  deliveryTicketId: batchId(901),
  ticketNo: "LYT-component-probe",
  orderItemId: batchId(902),
  store,
  dramaTitle: "生命周期探针",
  episodeCount: 2,
  step: "batch_compose",
  stepEnteredAt: probeAt,
  stepDueAt: null,
  waitingOn: "staff",
  urgency: "normal",
  isPaused: false,
  pauseReasons: [],
  isStuck: false,
  productionModel: "standard",
  platforms: [],
  agreedLaunchDate: null,
  usageEndDate: "2027-10-09",
  schedulePriority: "standard",
  deliveryManager: null,
  editor: null,
  publisher: null,
  deliveryTargetAt: probeAt,
  deliveredAt: null,
  createdAt: probeAt,
  actions: ["inspect-episodes", "sample-create", "episode-register"],
  pauses: [],
  pausedAt: null,
  pauseRemainingMin: null,
  sampleRoundNo: 1,
  currentSampleVersionNo: 1,
  milestones: {
    assignedAt: null,
    planConfirmedAt: null,
    adsReadyAt: null,
    sampleFirstPushedAt: null,
    sampleConfirmedAt: null,
    composedAt: null,
    deliveredAt: null,
    linksSubmittedAt: null,
    liveAt: null,
    usageEndedAt: null,
    archivedAt: null,
    terminatedAt: null,
  },
  stages: [],
  lockVersion: 1,
  orderItem: {
    orderItemId: batchId(902),
    itemNo: 1,
    dramaId: batchId(908),
    dramaTitle: "生命周期探针",
    genres: [],
    episodeCount: 2,
    productionModel: "standard",
    listPricePoints: 100,
    discountBp: 0,
    surchargeBp: 0,
    chargePoints: 100,
    phase: "producing",
    phaseChangedAt: probeAt,
    capturedAt: probeAt,
    agreedLaunchDate: null,
    usageStartDate: null,
    usageEndDate: "2027-10-09",
    usageEndSource: "license",
    liveEpisodeCount: 0,
    accounts: [],
    placements: [],
    refundRequestedPoints: 0,
    returnedPoints: 0,
    convertedPoints: 0,
    forfeitedPoints: 0,
    cancelReasonCode: null,
    cancelledAt: null,
    ticket: {
      deliveryTicketId: batchId(901),
      ticketNo: "LYT-component-probe",
      step: "batch_compose",
      isPaused: false,
    },
    pointHold: {
      pointHoldId: batchId(909),
      status: "captured",
      heldAt: probeAt,
      capturedAt: probeAt,
    },
  },
  order: {
    orderId: batchId(910),
    orderNo: "LYO-component-probe",
    submittedAt: probeAt,
    totalChargePoints: 100,
    itemCount: 1,
    status: "processing",
    siblings: [],
  },
  merchant: {
    store,
    province: null,
    industry: null,
    category: null,
    contactName: null,
    contactPhoneMask: null,
    isWecomAdded: false,
  },
  plan: null,
  ads: [],
  currentSample: {
    sampleId: batchId(911),
    deliveryTicketId: batchId(901),
    versionNo: 1,
    status: scenario === "sample-recovery" ? "pushed" : "uploaded",
    fileId: batchId(912),
    durationMs: null,
    adSlots: [],
    adsUsed: [],
    uploadedBy: staff,
    uploadedAt: probeAt,
    production: null,
    qc: null,
    pushedBy: null,
    pushedAt: null,
    previewChannels: scenario === "sample-recovery" ? ["album", "portal"] : [],
    offlineSentAt: null,
    offlineSentBy: null,
    firstViewedAt: null,
    viewedAckAt: null,
    decision: null,
    confirmDueRemindAt: null,
    watermark: null,
    preview: { url: "unused-preview-1", expiresAt: "2027-10-09T00:00:00.000Z", posterUrl: null },
    actions: scenario === "sample-recovery" ? ["recover_legacy"] : ["inspect"],
  },
  samples: [],
  episodeProgress: {
    totalEpisodes: 2,
    currentPassedCount: 0,
    uploadedCount: 0,
    rejectedCount: 0,
    packageQc: null,
  },
  release: null,
  openReissue: null,
  openUploadBatches: [],
  publishList: null,
  launch: {
    taskCount: 0,
    liveCount: 0,
    verifyingCount: 0,
    needFixCount: 0,
    pendingCount: 0,
    tasks: [],
  },
  remindScenes: [],
});
const output = (episodeNo: number, revisionNo: number) => ({
  episodeNo,
  revisionNo,
  episodeOutputId: `output-${episodeNo}-${revisionNo}`,
  fileId: `episode-file-${episodeNo}-${revisionNo}`,
});
const initialGrid = {
  episodes: [1, 2].map((episodeNo) => ({ episodeNo, latest: output(episodeNo, 1), current: null })),
} as Grid;
const initialTemplate = {
  checklistTemplateId: "template-1",
  versionNo: 1,
  items: [{ key: "picture", label: "逐项核对画面", allowNa: false }],
} as Template;
const registrations: Registration[] = [],
  sent: Sent[] = [],
  completed: string[] = [];
const record = (method: string) => async (id: string, body: unknown, key: string) => {
  sent.push({ method, id, body, key });
  return {};
};
// Samples-only protocol substitutes. The production multipart adapter still performs local HTTP;
// these in-memory DTOs are not evidence that a worker checked a real video or reached ready.
const batches = new Map<string, UploadBatchDetail>();
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.origin === "https://test-media-1250000000.cos.ap-beijing.myqcloud.com") {
    const local = new URL("/__production_cos", location.origin);
    local.search = url.search;
    return nativeFetch(local, init);
  }
  return nativeFetch(input, init);
};
const readBatch = (id: string) => {
  const batch = batches.get(id);
  if (!batch) throw new Error("Unknown component-probe batch");
  return batch;
};
const batchApi: BatchApi = {
  create: async (input) => {
    const body = UploadBatchCreateBodySchema.parse(input);
    if (body.files.length !== 1 || body.scope !== "partial")
      throw new Error("The lifecycle probe requires one partial-batch file");
    const index = registrations.length + 1;
    const id = batchId(index + 1000);
    const fileId = batchId(index + 2000);
    const prefix = `incoming/b${id}/`;
    const batch = UploadBatchDetailSchema.parse(
      batchFixture({
        uploadBatchId: id,
        targetId: body.targetId,
        expectedCount: 2,
        scope: body.scope,
        prefix,
        items: [
          {
            ...batchItem(),
            uploadBatchItemId: batchId(index + 3000),
            fileId,
            originalName: body.files[0]!.originalName,
            sizeBytes: body.files[0]!.sizeBytes,
            uploadKey: `${prefix}${fileId}.mp4`,
          },
        ],
        coverage: {
          missingEpisodeNos: [2],
          duplicateEpisodeNos: [],
          unmatchedItemIds: [],
          needsSequenceConfirm: false,
        },
      }),
    );
    batches.set(id, batch);
    return batch;
  },
  get: async (id) => UploadBatchDetailSchema.parse(readBatch(id)),
  start: async (id) => {
    const batch = UploadBatchDetailSchema.parse({ ...readBatch(id), state: "uploading" });
    batches.set(id, batch);
    return batch;
  },
  refresh: (id, signal) =>
    new Promise((resolve) => {
      const batch = readBatch(id);
      registrations.push({
        body: { uploadBatchId: id, targetId: batch.targetId },
        fileId: batch.items[0]!.fileId,
        signal,
        release: () =>
          resolve(
            BatchUploadCredentialsSchema.parse({
              bucket: batch.bucket,
              region: batch.region,
              prefix: batch.prefix,
              sts: {
                tmpSecretId: "fictional-public",
                tmpSecretKey: "fictional-key",
                sessionToken: "fictional-token",
                startTime: new Date().toISOString(),
                expiredTime: new Date(Date.now() + 1800_000).toISOString(),
              },
              chunkSize: 8 * 1024 * 1024,
              fileParallel: 3,
              chunkParallel: 4,
              expiresAt: new Date(Date.now() + 1800_000).toISOString(),
            }),
          ),
      });
    }),
  complete: async (id) => {
    const batch = [...batches.values()].find((row) => row.items[0]!.uploadBatchItemId === id);
    if (!batch) throw new Error("Unknown component-probe item");
    const item = UploadBatchItemSchema.parse({
      ...batch.items[0]!,
      state: "checked",
      fileStatus: "stored",
      check: { gate: "pass", failedHard: [], warnings: [] },
    });
    completed.push(item.fileId);
    batches.set(
      batch.uploadBatchId,
      UploadBatchDetailSchema.parse({
        ...batch,
        state: "ready",
        items: [item],
        counts: { ...batch.counts, pending: 0, uploaded: 0, checked: 1 },
      }),
    );
    return item;
  },
  update: async () => {
    throw new Error("The lifecycle probe does not edit a batch");
  },
  cancel: async () => {
    throw new Error("The lifecycle probe closes its local scope");
  },
  commit: async () => {
    throw new Error("Final masters are outside the component probe");
  },
};
const api = {
  batches: batchApi,
  template: async () => initialTemplate,
  inspectSample: record("inspectSample"),
  recoverLegacySample: record("recoverLegacySample"),
  inspectEpisodes: record("inspectEpisodes"),
  file: (body: unknown, _key: string, signal?: AbortSignal) =>
    new Promise((resolve) => {
      const fileId = `uploaded-file-${registrations.length + 1}`;
      registrations.push({
        body,
        fileId,
        signal,
        release: () =>
          resolve({
            fileId,
            mode: "post",
            status: "pending",
            expiresAt: "2099-01-01T00:00:00Z",
            uploadExpiresAt: "2099-01-01T00:00:00Z",
            post: {
              url: new URL("/__production_post", location.origin).href,
              fields: { policy: "public-component-probe" },
            },
          }),
      });
    }),
  complete: async (fileId: string) => {
    completed.push(fileId);
    return { status: "stored" };
  },
  fileStatus: async () => {
    throw new Error("组件探针不应轮询：complete stub 已返回 stored");
  },
  sample: record("sample"),
  registerEpisodes: record("registerEpisodes"),
} as unknown as DetailApi;
function Probe() {
  const [ticket, setTicket] = useState(initialTicket),
    [grid, setGrid] = useState(initialGrid),
    [open, setOpen] = useState(true);
  window.productionLifecycle = {
    close: () => setOpen(false),
    open: () => setOpen(true),
    release: (index) => registrations[index]!.release(),
    snapshot: () => ({
      registrations: registrations.map((r) => ({
        body: r.body,
        fileId: r.fileId,
        aborted: r.signal?.aborted ?? false,
      })),
      sent: [...sent],
      completed: [...completed],
    }),
    change: (change) => {
      if (change === "template") {
        const code =
          scenario === "sample-qc" || scenario === "sample-recovery" ? "qc.sample" : "qc.episode";
        query.setQueryData(["delivery", "ticket-detail", "checklist", code], {
          ...initialTemplate,
          versionNo: 2,
          items: [{ ...initialTemplate.items[0], label: "新版画面规则须重新核对" }],
        });
      } else if (change === "episode") {
        setGrid({
          ...initialGrid,
          episodes: initialGrid.episodes.map((e) => ({
            ...e,
            latest: output(e.episodeNo, 2),
          })),
        } as Grid);
      } else {
        setTicket((old) => ({
          ...old,
          ...(change === "item" ? { orderItemId: batchId(903) } : {}),
          ...(change === "ticket" ? { deliveryTicketId: batchId(904) } : {}),
          currentSample: {
            ...old.currentSample!,
            ...(change === "sample" ? { sampleId: batchId(913) } : {}),
            ...(change === "sample-version" ? { versionNo: 2 } : {}),
            preview: { ...old.currentSample!.preview!, url: "unused-preview-refreshed" },
          },
        }));
      }
    },
  };
  const props = { ticket, api, onClose: () => setOpen(false), onRefresh: () => {} };
  return (
    <QueryClientProvider client={query}>
      <AccessContext.Provider value={access}>
        {open ? (
          scenario === "sample-qc" ||
          scenario === "sample-recovery" ||
          scenario === "episode-qc" ? (
            <QualityModal
              {...props}
              mode={
                scenario === "sample-recovery"
                  ? "recover"
                  : scenario === "sample-qc"
                    ? "sample"
                    : "episodes"
              }
              grid={grid}
            />
          ) : scenario === "sample-upload" ? (
            <SampleUploadModal {...props} />
          ) : (
            <EpisodeRegisterModal {...props} />
          )
        ) : null}
      </AccessContext.Provider>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Probe />);
