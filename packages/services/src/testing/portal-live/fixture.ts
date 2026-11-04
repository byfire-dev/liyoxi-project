import { randomBytes } from "node:crypto";
import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import {
  assertTestDatabaseUrl,
  dropTestDatabase,
  listTestDatabases,
  testDatabaseName,
  testDatabaseUrl,
} from "@liyoxi/db/testing/standalone";
import { Redis } from "ioredis";
import { loadEnv } from "../../kernel/index.js";
import type { Clock } from "../../kernel/index.js";
import { createLogger } from "../../logger.js";
import { createRuntime } from "../../runtime.js";
import type { Runtime } from "../../runtime.js";
import { loadKeyring } from "../../security/index.js";
import type { Keyring } from "../../security/index.js";
import { createFactories } from "../data/factories/index.js";
import { createProviderHarness } from "../data/provider-harness.js";
import { sealerOf } from "../data/seal.js";
import { createSeededDatabase } from "../data/seeded-db.js";
import { fakeKeyEnv } from "../m1-fake-keys.js";
import { assertTestRedisPrefix, disconnectTestRedis, testRedisPrefix } from "../redis.js";
import { createPortalLiveObservations } from "./observations.js";
import type { PortalLiveTicketFact } from "./observations.js";
import { createPortalPreview, createPortalPreviewTools } from "./preview.js";
import { portalLivePhones } from "./preview-scope.js";
import type { PortalLiveMediaResult } from "./preview-media.js";
import type {
  PortalLivePreviewAction,
  PortalLivePreviewFacts,
  PortalLivePreviewScopes,
} from "./preview-types.js";

export type PortalLiveActor = "owner" | "clerk" | "otherOwner";
export type PortalLiveStage =
  "scope" | "database" | "agreements" | "runtime" | "http" | "identities" | "control" | "closing";
export interface PortalLiveDiagnostic {
  stage: PortalLiveStage;
  code: "STARTED" | "READY" | "FAILED" | "CLOSED" | "OWNERSHIP_CHANGED";
}
export interface PortalLiveOptions {
  runId: string;
  portalOrigin: string;
  version: string;
  signal: AbortSignal;
  diagnostic(event: PortalLiveDiagnostic): void;
}
export interface PortalLiveFixture {
  readonly runtime: Runtime;
  readonly merchantDeps: { appid: string; keyring: Keyring };
  primePhoneLogin(actor: PortalLiveActor): { loginCode: string; phoneCode: string };
  beginReadWindow(): Promise<string>;
  endReadWindow(
    windowId: string,
  ): Promise<{ unchanged: boolean; changedTables: readonly string[] }>;
  discardReadWindow(): boolean;
  ticketFacts(ids: readonly string[]): Promise<readonly PortalLiveTicketFact[]>;
  preparePreview(scopes: PortalLivePreviewScopes): Promise<PortalLivePreviewFacts>;
  previewAction(action: PortalLivePreviewAction): Promise<PortalLivePreviewFacts>;
  previewFacts(): Promise<PortalLivePreviewFacts>;
  readPreviewMedia(requestTarget: string): PortalLiveMediaResult;
  close(): Promise<void>;
}

/** Validate before touching a connection. Never include the rejected input in an error. */
export function assertPortalLiveInput(
  options: Pick<PortalLiveOptions, "runId" | "portalOrigin" | "version">,
  source: Readonly<Record<string, string | undefined>>,
) {
  if (
    source.APP_ENV !== "test" ||
    !/^[a-f0-9]{12}$/.test(options.runId) ||
    !/^[A-Za-z0-9._-]{1,80}$/.test(options.version)
  )
    throw new Error("INVALID_LIVE_SCOPE");
  try {
    const origin = new URL(options.portalOrigin);
    if (
      origin.origin !== options.portalOrigin ||
      origin.protocol !== "https:" ||
      origin.hostname !== "portal.localhost" ||
      !origin.port ||
      origin.username ||
      origin.password
    )
      throw new Error("INVALID_LIVE_ORIGIN");
    for (const [key, protocols] of [
      ["DATABASE_URL", ["postgres:", "postgresql:"]],
      ["REDIS_URL", ["redis:"]],
    ] as const) {
      const url = new URL(source[key] ?? "");
      if (
        !protocols.some((protocol) => protocol === url.protocol) ||
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.search ||
        url.hash
      )
        throw new Error("INVALID_LIVE_TRANSPORT");
    }
  } catch {
    throw new Error("INVALID_LIVE_ENVIRONMENT");
  }
}

const releaseClaim = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
async function scopedKeys(redis: Redis, prefix: string) {
  assertTestRedisPrefix(prefix);
  const keys = new Set<string>();
  let cursor = "0";
  do {
    const [next, found] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 100);
    cursor = next;
    for (const key of found) if (key.startsWith(prefix)) keys.add(key);
  } while (cursor !== "0");
  return [...keys];
}

/** Owns one new DB/prefix. Auth rows are created later by the API's real HTTP chain. */
export async function createPortalLiveFixture(
  options: PortalLiveOptions,
): Promise<PortalLiveFixture> {
  assertPortalLiveInput(options, process.env);
  options.signal.throwIfAborted();
  const name = testDatabaseName("api", { session: options.runId, worker: "0", label: "portal" });
  const databaseUrl = testDatabaseUrl(name);
  assertTestDatabaseUrl(databaseUrl);
  const prefix = testRedisPrefix({ session: options.runId, worker: "0" });
  const ownerKey = `${prefix}portal_live.owner`,
    claim = randomBytes(32).toString("hex");
  const owner = new Redis(process.env.REDIS_URL!, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 5_000,
    commandTimeout: 5_000,
  });
  // Redis errors must not use the library's unhandled-error output (which can contain connection facts).
  owner.on("error", () => {});
  let acquired = false,
    fresh = false,
    databaseStarted = false;
  let runtime: Runtime | undefined, db: PrismaClient | undefined;
  let observations: ReturnType<typeof createPortalLiveObservations> | undefined;
  let preview: ReturnType<typeof createPortalPreview> | undefined;
  let previewTools: ReturnType<typeof createPortalPreviewTools> | undefined;
  let closing: Promise<void> | undefined;
  let stage: PortalLiveStage = "scope";
  const diagnostic = (code: PortalLiveDiagnostic["code"]) => {
    try {
      options.diagnostic({ stage, code });
    } catch {
      /* diagnostics cannot own resources */
    }
  };
  const close = () =>
    (closing ??= (async () => {
      stage = "closing";
      let failed = false;
      const attempt = async (action: () => Promise<unknown>) => {
        try {
          await action();
        } catch {
          failed = true;
        }
      };
      try {
        observations?.discardReadWindow();
      } catch {
        failed = true;
      }
      await attempt(async () => preview?.close());
      await attempt(async () => runtime?.close());
      await attempt(async () => previewTools?.codec.tools.close());
      previewTools?.transport.close();
      await attempt(async () => db?.$disconnect());
      if (acquired) {
        try {
          if ((await owner.get(ownerKey)) !== claim) {
            diagnostic("OWNERSHIP_CHANGED");
            failed = true;
          } else if (!fresh) {
            // Collision preparation never owns the old DB or any old prefix key.
            if ((await owner.eval(releaseClaim, 1, ownerKey, claim)) !== 1) failed = true;
          } else {
            if (databaseStarted) await dropTestDatabase(name);
            if ((await listTestDatabases({ session: options.runId })).includes(name))
              throw new Error("DATABASE_REMAINS");
            for (const key of await scopedKeys(owner, prefix)) {
              if (key === ownerKey) continue;
              // The ownership check and deletion are one Redis operation.
              const removed = await owner.eval(
                "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end return redis.call('UNLINK', KEYS[2])",
                2,
                ownerKey,
                key,
                claim,
              );
              if (removed === -1) throw new Error("OWNERSHIP_CHANGED");
            }
            if ((await scopedKeys(owner, prefix)).some((key) => key !== ownerKey))
              throw new Error("PREFIX_REMAINS");
            if ((await owner.eval(releaseClaim, 1, ownerKey, claim)) !== 1)
              throw new Error("OWNERSHIP_CHANGED");
          }
        } catch {
          failed = true;
        }
      }
      await attempt(() => disconnectTestRedis(owner));
      if (failed) {
        diagnostic("FAILED");
        throw new Error("PORTAL_LIVE_CLOSE_FAILED");
      }
      diagnostic("CLOSED");
    })());
  try {
    diagnostic("STARTED");
    await owner.connect();
    options.signal.throwIfAborted();
    acquired = (await owner.set(ownerKey, claim, "NX")) === "OK";
    if (!acquired) throw new Error("SCOPE_COLLISION");
    if (
      (await scopedKeys(owner, prefix)).some((key) => key !== ownerKey) ||
      (await listTestDatabases({ session: options.runId })).includes(name)
    )
      throw new Error("SCOPE_COLLISION");
    fresh = true;
    options.signal.throwIfAborted();
    let offset = 0;
    const clock: Clock = { now: () => new Date(Date.now() + offset) };
    stage = "database";
    diagnostic("STARTED");
    databaseStarted = true;
    await createSeededDatabase(name, { clock });
    options.signal.throwIfAborted();
    const env = {
      ...loadEnv({
        APP_ENV: "test",
        LOG_LEVEL: "warn",
        DATABASE_URL: databaseUrl,
        REDIS_URL: process.env.REDIS_URL!,
        PORTAL_PUBLIC_ORIGIN: options.portalOrigin,
      }),
      ...fakeKeyEnv(),
    };
    const keyring = loadKeyring(env),
      harness = createProviderHarness({ clock });
    previewTools = createPortalPreviewTools({
      providers: harness.providers,
      clock,
      runId: options.runId,
      portalOrigin: options.portalOrigin,
    });
    db = createPrismaClient({ connectionString: databaseUrl, max: 1 });
    stage = "agreements";
    diagnostic("STARTED");
    const make = createFactories({ db, clock, seal: sealerOf(keyring) });
    const staff = await make.staff({ staffRoleKey: "super_admin" });
    const file = await make.fileObject({ bucket: "secure", category: "legal_doc", ext: "pdf" });
    for (const agreementKey of ["user", "privacy"])
      await make.agreementVersion({ agreementKey, createdByStaffId: staff.id, pdfFileId: file.id });
    options.signal.throwIfAborted();
    stage = "runtime";
    diagnostic("STARTED");
    runtime = createRuntime({
      entry: "api",
      env: { ...env, MEDIA_PRODUCTION: previewTools.codec.env },
      version: options.version,
      clock,
      providers: { ...harness.providers, storage: previewTools.transport.storage },
      mediaProductionTools: previewTools.codec.tools,
      redisKeyPrefix: prefix,
      healthCacheMs: 0,
      logger: createLogger({
        svc: "api",
        env: "test",
        level: "warn",
        version: options.version,
        destination: {
          write() {
            /* Only the explicit safe stage channel leaves this fixture. */
          },
        },
      }),
    });
    observations = createPortalLiveObservations(db);
    preview = createPortalPreview({
      db,
      runtime,
      clock,
      keyring,
      tools: previewTools,
      providers: harness.providers,
      enableReadTables: () => observations!.enablePreviewReadTables(),
      expireMedia() {
        if (offset !== 0) throw new Error("PREVIEW_CLOCK_ALREADY_ADVANCED");
        offset = 3_600_001;
      },
    });
    const used = new Set<PortalLiveActor>();
    const phones = portalLivePhones;
    return {
      runtime,
      merchantDeps: { appid: "wxlyxtestportal01", keyring },
      ...observations,
      preparePreview: preview.preparePreview,
      previewAction: preview.previewAction,
      previewFacts: preview.previewFacts,
      readPreviewMedia: preview.readPreviewMedia,
      primePhoneLogin(actor) {
        if (closing || used.has(actor) || !Object.hasOwn(phones, actor))
          throw new Error("LOGIN_INPUT_ALREADY_USED");
        used.add(actor);
        const loginCode = `portal-${options.runId}-${actor}-login`;
        const phoneCode = `portal-${options.runId}-${actor}-phone`;
        harness.providers.wechat.sessions.set(loginCode, {
          openid: `portal-${options.runId}-${actor}`,
        });
        harness.providers.wechat.phones.set(phoneCode, phones[actor]);
        return { loginCode, phoneCode };
      },
      close,
    };
  } catch {
    diagnostic("FAILED");
    await close();
    throw new Error("PORTAL_LIVE_START_FAILED");
  }
}
