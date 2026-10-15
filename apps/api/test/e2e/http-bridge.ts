// W228 prerequisite: this module is built from the selected revision together with its handlers.
// It is test composition, not the production server entry and not a replacement for the four-step drill.
import { createHash } from "node:crypto";
import { serve } from "@hono/node-server";
import { security } from "@liyoxi/services";
import { createM1Support } from "@liyoxi/services/testing";
import type { M1Attachment, M1Scope, M1SupportOptions } from "@liyoxi/services/testing";
import { createApp } from "../../src/app.js";
import { provideMerchantDeps } from "../../src/merchant/services.js";
import { HANDLERS } from "../../src/routes/index.js";
import { bootstrapM1Admin, loginM1Staff } from "./m1-auth.js";
import type { M1AuthenticatedStaff } from "./m1-auth.js";
import { createM1HttpApi } from "./http.js";
import type { M1PhaseClient } from "./http.js";
import { createM1Caller } from "./runner-api.js";
import { runM1Chain } from "./runner.js";
import type { M1ChainContext } from "./runner.js";

/** Fictional per-round values. Different chainIds do not reuse the original M1 merchant. */
export function m1HttpIdentity(chainId: string) {
  if (!/^[a-z0-9]{1,12}$/.test(chainId)) throw new Error("M1 HTTP 链标识无效");
  const hex = createHash("sha256").update(chainId).digest("hex");
  const digits = (BigInt(`0x${hex.slice(0, 12)}`) % 100_000_000n).toString().padStart(8, "0");
  const chars = "0123456789ABCDEFGHJKLMNPQRTUWXY";
  const weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  const prefix = `91310000M${hex.slice(0, 8).toUpperCase()}`;
  const check =
    (31 - ([...prefix].reduce((sum, one, i) => sum + chars.indexOf(one) * weights[i]!, 0) % 31)) %
    31;
  return {
    merchant: {
      loginCode: `mixed-${chainId}`,
      phoneCode: `138${digits}`,
      uscc: prefix + chars[check],
    },
    reviewerPhone: `199${digits}`,
  };
}
export type M1HttpAdmin = Pick<
  M1AuthenticatedStaff,
  "staffId" | "phone" | "password" | "secret" | "recoveryCodes"
>;

export async function createM1HttpBridge(input: {
  readonly attach: M1Attachment;
  readonly signal?: AbortSignal;
  readonly backgroundWorker?: M1SupportOptions["backgroundWorker"];
  readonly diagnosticWrite?: M1SupportOptions["diagnosticWrite"];
  readonly beforeOrder?: () => Promise<void>;
  readonly phaseClient?: M1PhaseClient;
}) {
  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  signal.throwIfAborted();
  const support = await createM1Support({
    attach: input.attach,
    signal,
    backgroundWorker: input.backgroundWorker,
    diagnosticWrite: input.diagnosticWrite,
  });
  let server: ReturnType<typeof serve> | undefined;
  let closed = false;
  let ran = false;
  let running: Promise<unknown> | undefined;
  const close = async () => {
    if (closed) return;
    closed = true;
    controller.abort();
    await running?.catch(() => undefined);
    try {
      const active = server;
      if (active)
        await new Promise<void>((resolve, reject) => {
          active.close((error) => (error ? reject(error) : resolve()));
          if ("closeIdleConnections" in active) active.closeIdleConnections();
        });
    } finally {
      await support.close();
    }
  };
  try {
    provideMerchantDeps(support.runtime, {
      keyring: security.loadKeyring(support.runtime.env),
      appid: "wxlyxm1demo000001",
    });
    const app = createApp({
      runtime: support.runtime,
      handlers: HANDLERS,
      ...(input.phaseClient === undefined
        ? {}
        : { trustedProxy: { hops: 1, cidrs: ["127.0.0.1/32", "::1/128"] } }),
    });
    const origin = await new Promise<string>((resolve, reject) => {
      const listening = serve(
        { hostname: "127.0.0.1", port: 0, fetch: app.app.fetch },
        ({ port }) => {
          app.readiness.state = "ready";
          resolve(`http://127.0.0.1:${port}`);
        },
      );
      server = listening;
      listening.once("error", reject);
    });
    const api = await createM1HttpApi({
      support,
      origin,
      version: input.attach.version,
      signal,
      phaseClient: input.phaseClient,
    });
    if (!support.httpIO) throw new Error("M1 HTTP 真实对象装配缺失");
    const externalIO = support.httpIO;
    const call = createM1Caller(api);
    return {
      protocol: "m1-http-v1" as const,
      origin,
      api,
      support,
      async runChain(
        options: {
          readonly admin?: M1HttpAdmin;
          readonly onStep?: (value: {
            step: number;
            completed: boolean;
            elapsedMs?: number;
          }) => void;
        } = {},
      ) {
        if (closed || ran) throw new Error("M1 HTTP 桥每轮只运行一条主链");
        signal.throwIfAborted();
        ran = true;
        // A W228 read phase may precede this write chain under a different merchant's scope.
        if (input.phaseClient !== undefined) api.resetObservedReads();
        const identity = m1HttpIdentity(input.attach.chainId);
        const captured: {
          admin?: M1AuthenticatedStaff;
          state?: M1ChainContext & { readonly scope: M1Scope; readonly sampleId: string };
        } = {};
        let step = 0;
        const task = runM1Chain({
          api,
          support,
          say: (message) => {
            const completed = message.match(/：完成（(\d+)毫秒）$/);
            if (!completed) step++;
            options.onStep?.({
              step,
              completed: Boolean(completed),
              ...(completed ? { elapsedMs: Number(completed[1]) } : {}),
            });
          },
          externalIO,
          merchantIdentity: identity.merchant,
          reviewerPhone: identity.reviewerPhone,
          uploadConcurrency: 1,
          beforeOrder: async () => {
            await input.beforeOrder?.();
            return [];
          },
          // The first round really bootstraps; later rounds really authenticate the first account.
          bootstrapAdmin: async () =>
            (captured.admin = options.admin
              ? await loginM1Staff(api, options.admin)
              : await bootstrapM1Admin(api)),
          seedDemo: async (signedIn) => {
            const report = await support.seedDemo();
            const created = await call("admin.staff.create", signedIn.headers, {
              body: {
                name: "混跑质检员",
                phone: identity.reviewerPhone,
                roleKey: "delivery_manager",
                isLead: true,
                activateNow: true,
                activationDelivery: "manual",
                inviteWecom: false,
              },
            });
            if (!created.activation?.activationCode || created.replayed)
              throw new Error("M1 HTTP 本轮质检人缺真实新发激活码");
            const activationCode = created.activation.activationCode;
            const expiresAt = new Date(created.activation.expiresAt);
            return {
              ...report,
              inserted: report.inserted + 1,
              tables: [
                ...report.tables,
                { step: "http-reviewer", table: "staff", inserted: 1, existing: 0 },
              ],
              staff: report.staff.map((member) =>
                member.key !== "delivery_manager"
                  ? member
                  : {
                      key: member.key,
                      staffId: created.staff.staffId,
                      staffNo: created.staff.staffNo,
                      name: created.staff.name,
                      roleKey: "delivery_manager" as const,
                      activation: { code: activationCode, expiresAt },
                    },
              ),
            };
          },
          afterChain: async (current) => {
            captured.state = current;
          },
        });
        running = task;
        const report = await task;
        signal.throwIfAborted();
        const { admin, state } = captured;
        if (!admin || !state) throw new Error("M1 HTTP 主链缺真实身份或结果");
        return {
          report,
          initialization: options.admin ? ("existing-login" as const) : ("bootstrap" as const),
          observedReads: [...api.observedReads],
          // Private capability: never serialize this object into a public report or workflow log.
          access: {
            admin,
            merchantHeaders: state.owner.headers,
            ids: {
              entityId: state.scope.entityId,
              storeId: state.scope.storeId,
              merchantUserId: state.scope.merchantUserId,
              orderId: state.scope.orderId,
              orderItemId: state.scope.orderItemId,
              deliveryTicketId: state.scope.deliveryTicketId,
              sampleId: state.sampleId,
            },
          },
        };
      },
      async drain() {
        if (closed) throw new Error("M1 HTTP 桥已关闭");
        signal.throwIfAborted();
        const begun = performance.now();
        const result = await support.drainEvents();
        signal.throwIfAborted();
        if (performance.now() - begun > 30_000) throw new Error("M1 HTTP worker 排空超过三十秒");
        return result;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
