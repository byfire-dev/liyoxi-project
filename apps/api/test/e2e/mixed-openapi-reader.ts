// Old phase exports its committed GET projection; HEAD replays that same private old spec.
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "@liyoxi/contract";
import type { M1Api } from "./in-process.js";
import { loginM1Staff } from "./m1-auth.js";
import { createM1Caller } from "./runner-api.js";
import { m1HttpIdentity } from "./http-bridge.js";
import { MixedFailure, MixedReadFailure, MixedSource } from "./mixed-http-driver.protocol.js";
import type { MixedPrivateAccess } from "./mixed-http-driver.protocol.js";

const Parameter = z.object({ in: z.string(), name: z.string(), required: z.boolean().optional() });
const Get = z.object({
  operationId: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,127}$/),
  parameters: z.array(Parameter).optional(),
});
const Document = z.object({
  paths: z.record(
    z.string(),
    z.object({
      parameters: z.array(Parameter).optional(),
      get: Get.optional(),
    }),
  ),
});
type Operation = { operationId: string; path: string; required: readonly string[] };
export type MixedRead = { operationId: string; path: string };
export const MixedReadSpec = z
  .strictObject({
    source: MixedSource,
    operations: z
      .array(
        z.strictObject({
          operationId: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,127}$/),
          path: z.string().regex(/^\/api\/v1\/(m|admin|portal)\/[^?#\\\s]*$/),
          required: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/)).max(32),
        }),
      )
      .min(1)
      .max(2048),
  })
  .refine(
    (spec) =>
      new Set(spec.operations.map((row) => row.operationId)).size === spec.operations.length,
  );
export function replayMixedReadSpec(source: string, previousSource: string, raw: unknown) {
  const spec = MixedReadSpec.parse(raw);
  if (MixedSource.parse(previousSource) === source || spec.source !== previousSource)
    throw new MixedFailure("read_failed");
  return spec;
}
export function mixedReadOperations(rawDocuments: readonly unknown[]): Operation[] {
  const result: Operation[] = [];
  for (const raw of rawDocuments) {
    for (const [path, item] of Object.entries(Document.parse(raw).paths)) {
      if (!item.get) continue;
      if (!/^\/api\/v1\/(m|admin|portal)\//.test(path)) throw new MixedFailure("read_failed");
      result.push({
        operationId: item.get.operationId,
        path,
        required: [...(item.parameters ?? []), ...(item.get.parameters ?? [])]
          .filter((p) => p.in === "query" && p.required)
          .map((p) => p.name),
      });
    }
  }
  if (!result.length || new Set(result.map((r) => r.operationId)).size !== result.length)
    throw new MixedFailure("read_failed");
  return result;
}
const details: Readonly<Record<string, keyof MixedPrivateAccess["ids"]>> = {
  "admin.entity.get": "entityId",
  "admin.entity.member.list": "entityId",
  "admin.store.get": "storeId",
  "admin.store.activity.list": "storeId",
  "admin.store.profile.get": "storeId",
  "admin.store.qualification.get": "storeId",
  "m.order.get": "orderId",
  "admin.order.get": "orderId",
  "m.orderItem.get": "orderItemId",
  "m.orderItem.release.get": "orderItemId",
  "m.orderItem.sample.get": "orderItemId",
  "admin.deliveryTicket.get": "deliveryTicketId",
  "admin.deliveryTicket.episodeOutput.list": "deliveryTicketId",
};
const escapeRegex = (value: string) => value.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
function matches(template: string, path: string): boolean {
  return new RegExp(
    "^" +
      template
        .split(/\{[^}]+\}/g)
        .map(escapeRegex)
        .join("[^/]+") +
      "$",
  ).test(path);
}
export function mixedReadPlan(
  operations: readonly Operation[],
  input: {
    access: MixedPrivateAccess;
    observedReads: readonly string[];
    token: string;
    year: number;
  },
) {
  const all: MixedRead[] = [],
    objects: MixedRead[] = [];
  const values: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    "m.dictItem.list": { typeKey: "industry" },
    "admin.dictItem.list": { typeKey: "industry" },
    "m.drama.search": { q: "修车" },
    "m.invitation.lookup": { token: input.token },
    "admin.assetDemand.list": { storeId: input.access.ids.storeId },
    "admin.calendarDay.list": { year: String(input.year) },
    "admin.followUp.list": { entityId: input.access.ids.entityId },
    "admin.storeAsset.list": { storeId: input.access.ids.storeId },
    "admin.subscriptionTerm.list": { tab: "expiring" },
  };
  for (const row of operations) {
    if (row.path.includes("{")) continue;
    // Some canonical queries require a combination although OpenAPI marks each field optional.
    const query = new URLSearchParams(values[row.operationId]);
    for (const key of row.required) {
      if (!query.get(key)) throw new MixedFailure("read_failed");
    }
    all.push({ operationId: row.operationId, path: row.path + (query.size ? "?" + query : "") });
  }
  for (const [operationId, id] of Object.entries(details)) {
    const row = operations.find((one) => one.operationId === operationId);
    if (!row) throw new MixedFailure("read_failed");
    const path = row.path.replace(/\{[^}]+\}/g, encodeURIComponent(input.access.ids[id]));
    objects.push({ operationId, path });
  }
  for (const path of input.observedReads) {
    const url = new URL(path, "http://api.localhost");
    if (url.origin !== "http://api.localhost" || !path.startsWith("/api/v1/") || path.includes("#"))
      throw new MixedFailure("read_failed");
    const row = operations.find((one) => matches(one.path, url.pathname));
    if (!row) throw new MixedFailure("read_failed");
    if (row.path.includes("{") && !objects.some((one) => one.path === path))
      objects.push({ operationId: row.operationId, path });
  }
  if (!all.length || !objects.length) throw new MixedFailure("read_failed");
  return { operations: all, details: objects };
}
export async function readMixedGets(
  api: Pick<M1Api, "request">,
  rows: readonly MixedRead[],
  adminHeaders: Readonly<Record<string, string>>,
  merchantHeaders: Readonly<Record<string, string>>,
  signal: AbortSignal,
) {
  const result: { operationId: string; status: number }[] = [];
  for (const row of rows) {
    signal.throwIfAborted();
    try {
      const response = await api.request(row.path, {
        headers: row.path.startsWith("/api/v1/admin/") ? adminHeaders : merchantHeaders,
        signal,
      });
      await response.body?.cancel();
      if (response.status !== 200) throw new MixedFailure("read_failed");
      result.push({ operationId: row.operationId, status: response.status });
    } catch {
      throw new MixedReadFailure(row.operationId); // selected validated old spec only, never the URL
    }
  }
  return result;
}
export async function readMixedOpenApi(
  api: M1Api,
  input: {
    previousAccess: MixedPrivateAccess;
    observedReads: readonly string[];
    signal: AbortSignal;
    source: string;
    replay?: { previousSource: string; readSpec: z.output<typeof MixedReadSpec> };
  },
) {
  const readSpec = input.replay
    ? replayMixedReadSpec(input.source, input.replay.previousSource, input.replay.readSpec)
    : MixedReadSpec.parse({
        source: input.source,
        operations: mixedReadOperations(
          await Promise.all(
            ["merchant", "admin", "portal"].map(
              async (surface) =>
                JSON.parse(
                  await readFile(
                    new URL(
                      "../../../../packages/contract/generated/" + surface + ".openapi.json",
                      import.meta.url,
                    ),
                    "utf8",
                  ),
                ) as unknown,
            ),
          ),
        ),
      });
  const operations = readSpec.operations;
  const signedIn = await loginM1Staff(api, input.previousAccess.admin);
  const call = createM1Caller(api);
  const agreements = await call("m.agreement.list", {}, { query: { scene: "login" } });
  const consents = agreements.items.flatMap((row) =>
    row.subjectKind === "user" && row.currentVersion
      ? [
          {
            agreementKey: row.agreementKey,
            agreementVersionId: row.currentVersion.agreementVersionId,
          },
        ]
      : [],
  );
  const identity = m1HttpIdentity(input.previousAccess.chainId).merchant;
  const login = await call(
    "m.session.phoneLogin",
    {},
    {
      body: { loginCode: identity.loginCode, phoneCode: identity.phoneCode, consents },
    },
  );
  if (login.me.user.merchantUserId !== input.previousAccess.ids.merchantUserId)
    throw new MixedFailure("read_failed");
  const merchantHeaders = {
    authorization: "Bearer " + login.token,
    "X-Client-Version": "1.0.0",
    "X-Store-Id": input.previousAccess.ids.storeId,
  };
  const makeInvitation = () =>
    call("m.invitation.create", merchantHeaders, {
      body: { clientRequestId: randomUUID() },
    });
  let invitation: Awaited<ReturnType<typeof makeInvitation>> | undefined;
  try {
    input.signal.throwIfAborted();
    if (operations.some((row) => row.operationId === "m.invitation.lookup"))
      invitation = await makeInvitation();
    const plan = mixedReadPlan(operations, {
      access: input.previousAccess,
      observedReads: input.observedReads,
      token: invitation?.token ?? "",
      year: new Date(Date.now() + 8 * 3600_000).getUTCFullYear(),
    });
    return {
      operations: await readMixedGets(
        api,
        plan.operations,
        signedIn.headers,
        merchantHeaders,
        input.signal,
      ),
      details: await readMixedGets(
        api,
        plan.details,
        signedIn.headers,
        merchantHeaders,
        input.signal,
      ),
      readSpec,
    };
  } finally {
    if (invitation)
      await call("m.invitation.revoke", merchantHeaders, {
        params: { invitationId: invitation.invitationId },
        body: { reason: "by_owner" },
      });
  }
}
