// 组件层生命周期探针：API 都是显式 stub；不代替 live 业务链验收。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AccessContext, type AccessSnapshot } from "../../src/lib/permissions";
import type {
  DetailApi,
  Grid,
  Template,
  Ticket,
} from "../../src/features/delivery/ticket-detail/api";
import { QualityModal } from "../../src/features/delivery/ticket-detail/quality";
import {
  EpisodeRegisterModal,
  SampleUploadModal,
} from "../../src/features/delivery/ticket-detail/uploads";

type Scenario = "sample-qc" | "episode-qc" | "sample-upload" | "episode-upload";
type Change = "preview" | "sample" | "sample-version" | "episode" | "template" | "item" | "ticket";
interface Sent {
  method: string;
  id: string;
  body: unknown;
  key: string;
}
interface Registration {
  body: unknown;
  signal?: AbortSignal;
  release(): void;
}
export interface LifecycleProbe {
  change(change: Change): void;
  close(): void;
  open(): void;
  release(index: number): void;
  snapshot(): {
    registrations: { body: unknown; aborted: boolean }[];
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
    "delivery.episode.qc",
    "delivery.sample.upload",
    "delivery.episode.register",
  ],
  dataScope: "all",
  releases: {},
};
// 只提供这些实际组件读取的 props；不把最小 stub 冒充完整契约响应。
const initialTicket = {
  deliveryTicketId: "ticket-1",
  orderItemId: "item-1",
  store: { storeId: "store-1", storeName: "测试门店" },
  dramaTitle: "生命周期探针",
  episodeCount: 2,
  currentSample: {
    sampleId: "sample-1",
    versionNo: 1,
    actions: ["inspect"],
    preview: { url: "unused-preview-1" },
  },
  actions: ["inspect-episodes", "sample-create", "episode-register"],
} as Ticket;
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
const api = {
  template: async () => initialTemplate,
  inspectSample: record("inspectSample"),
  inspectEpisodes: record("inspectEpisodes"),
  file: (body: unknown, _key: string, signal?: AbortSignal) =>
    new Promise((resolve) => {
      const fileId = `uploaded-file-${registrations.length + 1}`;
      registrations.push({
        body,
        signal,
        release: () =>
          resolve({
            fileId,
            mode: "post",
            status: "pending",
            post: { url: "/__production_post", fields: { policy: "public-component-probe" } },
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
        aborted: r.signal?.aborted ?? false,
      })),
      sent: [...sent],
      completed: [...completed],
    }),
    change: (change) => {
      if (change === "template") {
        const code = scenario === "sample-qc" ? "qc.sample" : "qc.episode";
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
          ...(change === "item" ? { orderItemId: "item-2" } : {}),
          ...(change === "ticket" ? { deliveryTicketId: "ticket-2" } : {}),
          currentSample: {
            ...old.currentSample!,
            ...(change === "sample" ? { sampleId: "sample-2" } : {}),
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
          scenario === "sample-qc" || scenario === "episode-qc" ? (
            <QualityModal
              {...props}
              mode={scenario === "sample-qc" ? "sample" : "episodes"}
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
