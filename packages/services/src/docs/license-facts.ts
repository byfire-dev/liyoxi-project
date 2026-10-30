import type { Clock, DeliveredEvent, Tx } from "../kernel/index.js";
import type { Flow } from "../flow/index.js";
import type { Events } from "../events/index.js";
import { z } from "zod";
import { AppError } from "../kernel/index.js";

/** Internal facts only: no L3 imports, HTTP DTOs or provider calls. */
export interface LicenseAccountFact {
  readonly channelAccountId: string;
  readonly platform: string;
  readonly name: string;
  readonly accountNo: string;
}
export interface LicenseFacts {
  readonly orderItemId: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly itemNo: number;
  readonly entityId: string;
  readonly storeId: string;
  readonly dramaId: string;
  readonly phase: string;
  readonly usageStartDate: string | null;
  readonly usageEndDate: string;
  readonly consentId: string;
  readonly accounts: readonly LicenseAccountFact[];
}
export interface LicenseScopeFact {
  readonly name: string;
  readonly episodes: number;
  readonly territory: string;
  readonly permits: readonly {
    readonly kind: string;
    readonly number: string;
    readonly platform: string;
  }[];
}
export interface LicenseFactPort {
  /** Locks the whole item set before returning any current facts. */
  getLicenseFacts(tx: Tx, ids: readonly string[]): Promise<readonly LicenseFacts[]>;
  /** Nonlocking owner read for reference checks; never synthesizes a missing row. */
  readLicenseFacts(tx: Tx, ids: readonly string[]): Promise<readonly LicenseFacts[]>;
  listCandidateIds(
    tx: Tx,
    input: { cursor?: string; limit: number; entityIds?: readonly string[] },
  ): Promise<readonly string[]>;
  orderItemIds(tx: Tx, orderId: string): Promise<readonly string[]>;
  eventItemIds(tx: Tx, event: DeliveredEvent): Promise<readonly string[]>;
  readReferences(
    tx: Tx,
    input: { itemIds: readonly string[]; accountIds: readonly string[] },
  ): Promise<{
    items: readonly Omit<LicenseFacts, "accounts">[];
    accounts: readonly { id: string; entityId: string; storeId: string; platform: string }[];
  }>;
}
export interface LicenseSnapshotPort {
  licensor(tx: Tx, at: Date): Promise<{ name: string; creditCode: string }>;
  licensee(
    tx: Tx,
    input: { entityId: string; storeId: string },
  ): Promise<{ name: string; creditCode: string; store: string }>;
  scope(tx: Tx, dramaId: string, platform: string): Promise<LicenseScopeFact>;
  readonly portalOrigin?: string;
}
export interface LicenseConvergenceDeps {
  readonly clock: Clock;
  readonly flow: Flow;
  readonly events: Pick<Events, "emit">;
  readonly facts: LicenseFactPort;
  readonly snapshot: LicenseSnapshotPort;
  readonly readFiles: (
    tx: Tx,
    ids: readonly string[],
  ) => Promise<readonly { id: string; sha256: string | null }[]>;
  /** Instance lifetime check; also checked after every awaited owner operation. */
  readonly assertOpen?: () => void;
}
export interface LicenseLetterSnapshot {
  licensor: { name: string; creditCode: string };
  licensee: { name: string; creditCode: string; store: string };
  drama: {
    name: string;
    episodes: number;
    permits: { kind: string; number: string; platform: string }[];
  };
  account: { platform: string; name: string; accountId: string };
  period: { start: string | null; startText: string; end: string; territory: string };
  rightsClauseKey: string;
  exclusiveClauseKey: string;
  obligationClauseKey: string;
  consent: { consentNo: string; agreement: string; at: string; by: string };
  orderNo: string;
  letterNo: string;
  revNo: number;
  issuedAt: string;
  verifyUrl: string;
}

const text = z.string().min(1);
const party = z.strictObject({ name: text, creditCode: z.string().regex(/^[0-9A-Z]{18}$/) });
/** The immutable queued snapshot boundary, shared with the future renderer; JSON alone is not evidence of this shape. */
export const LicenseLetterSnapshotSchema = z
  .strictObject({
    licensor: party,
    licensee: party.extend({ store: text }),
    drama: z.strictObject({
      name: text,
      episodes: z.number().int().positive(),
      permits: z.array(z.strictObject({ kind: text, number: text, platform: text })).min(1),
    }),
    account: z.strictObject({
      platform: z.enum(["douyin", "wechat_channels"]),
      name: text,
      accountId: text,
    }),
    period: z.strictObject({
      start: z.iso.date().nullable(),
      startText: text,
      end: z.iso.date(),
      territory: text,
    }),
    rightsClauseKey: z.literal("v1.rights"),
    exclusiveClauseKey: z.literal("v1.exclusive"),
    obligationClauseKey: z.literal("v1.offline"),
    consent: z.strictObject({
      consentNo: z.string().regex(/^[1-9][0-9]*$/),
      agreement: text,
      at: z.iso.datetime({ offset: true }),
      by: text,
    }),
    orderNo: z.string().regex(/^T?LYX[0-9]+$/),
    letterNo: z
      .string()
      .max(40)
      .regex(/^T?SQ[0-9]+-[1-9][0-9]*-(?:DY|SPH)(?:-[1-9][0-9]*)?$/),
    revNo: z.number().int().positive(),
    issuedAt: z.iso.datetime({ offset: true }),
    verifyUrl: z.url(),
  })
  .superRefine((value, ctx) => {
    if (value.period.start && value.period.start > value.period.end)
      ctx.addIssue({ code: "custom", path: ["period"], message: "授权起止日期无效" });
    if (value.period.start === null && value.period.startText !== "自上线首日起")
      ctx.addIssue({
        code: "custom",
        path: ["period", "startText"],
        message: "待上线起日文字无效",
      });
    let url: URL;
    try {
      url = new URL(value.verifyUrl);
    } catch {
      ctx.addIssue({ code: "custom", path: ["verifyUrl"], message: "授权验真地址无效" });
      return;
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/v" ||
      url.hash ||
      !/^[0-9A-Za-z]{16}$/.test(url.searchParams.get("code") ?? "") ||
      url.searchParams.get("rev") !== String(value.revNo) ||
      [...url.searchParams.keys()].sort().join(",") !== "code,rev"
    )
      ctx.addIssue({ code: "custom", path: ["verifyUrl"], message: "授权验真地址无效" });
  });

export function parseLicenseLetterSnapshot(value: unknown): LicenseLetterSnapshot {
  const parsed = LicenseLetterSnapshotSchema.safeParse(value);
  if (!parsed.success)
    throw new AppError("PRECONDITION_CHANGED", { message: "授权版次快照结构无效" });
  return parsed.data;
}
