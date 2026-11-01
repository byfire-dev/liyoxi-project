import { AdminAdListQuerySchema } from "@liyoxi/contract";
import { newIdempotencyKey } from "../../../lib/idempotency";
import { readQueueSearch } from "../../../lib/queue";
import type { AdApi, AdDetail, Command, CreateVersionBody } from "./api";
export const ADS_KEY = ["delivery", "ad-tasks"] as const;
export const tabs = [
  "todo",
  "pending_confirm",
  "confirmed",
  "returned",
  "cancelled",
  "all",
] as const;
export function adSearch(raw: Readonly<Record<string, unknown>>) {
  const search = readQueueSearch(raw);
  const parsed = AdminAdListQuerySchema.safeParse({
    tab: search.tab,
    q: search.q,
    overdueOnly: raw.overdueOnly,
    type: raw.type,
  });
  return {
    ...search,
    q: search.q?.slice(0, 40),
    tab: parsed.success ? parsed.data.tab : "todo",
    overdueOnly: parsed.success ? parsed.data.overdueOnly : undefined,
    type: parsed.success ? parsed.data.type : undefined,
  };
}
export function segmentsInput(text: string): CreateVersionBody["segments"] {
  if (!text.trim()) return [];
  return text
    .split("\n")
    .filter((v) => v.trim())
    .map((line, index) => {
      const match = /^(\d+)\s*[,，]\s*(\d+)\s*[,，]\s*(.{1,20})$/.exec(line.trim());
      if (!match || Number(match[1]) >= Number(match[2]))
        throw new Error("每行填写开始毫秒,结束毫秒,广告标签");
      return { index, fromMs: Number(match[1]), toMs: Number(match[2]), label: match[3]! };
    });
}
/** A single panel owns its intent; unknown results are reread before retrying the same key. */
export function createAdWorkspace(
  api: Pick<AdApi, "get" | "write">,
  adId: string,
  newKey = () => newIdempotencyKey("ad-task"),
) {
  let busy = false,
    closed = false,
    fingerprint = "",
    key = "",
    uncertain = false;
  const controller = new AbortController();
  return {
    async submit(command: Command): Promise<AdDetail | null> {
      if (closed || busy) return null;
      busy = true;
      try {
        const next = JSON.stringify(command);
        if (next !== fingerprint) {
          fingerprint = next;
          key = newKey();
          uncertain = false;
        }
        if (uncertain) {
          const fresh = await api.get(adId, controller.signal);
          if (closed || fresh.adId !== adId) return null;
          const available =
            "versionId" in command
              ? fresh.versions
                  .find((v) => v.adVersionId === command.versionId)
                  ?.actions.includes(command.kind)
              : fresh.actions.includes(command.kind);
          // An unknown write may already have committed, or somebody changed the task.
          // Show the actual read result without claiming success or sending a now-unavailable action.
          if (
            !available ||
            (command.kind === "request-change" && command.body.versionNo !== fresh.latestVersionNo)
          ) {
            uncertain = false;
            return fresh;
          }
        }
        uncertain = true;
        const result = await api.write(adId, command, key, controller.signal);
        uncertain = false;
        return closed || result.adId !== adId ? null : result;
      } finally {
        busy = false;
      }
    },
    close() {
      closed = true;
      controller.abort();
    },
  };
}
