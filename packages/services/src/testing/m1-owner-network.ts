// Pure guard for the explicit HEAD owner in a controller-owned test network. No Docker/IO.
import { z } from "zod";
import type { M1OwnerNetwork, M1SupportOptions } from "./m1-types.js";

const identityKeys = ["runId", "source", "nonce", "networkId"] as const;
const services = ["postgres", "redis", "minio"] as const;
const invalid = () => new Error("M1 ownerNetwork 不是本轮明确私网收据或固定测试连接");

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

const identity = z.strictObject({
  runId: z.string().regex(/^[a-z0-9]{1,12}$/),
  source: z.string().regex(/^[a-f0-9]{40}$/),
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
  networkId: z.string().regex(/^[a-f0-9]{64}$/),
});
/** One runtime parser for private JSONL input and the support guard; no duplicate DTO. */
export const M1OwnerNetworkSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (
      !exactRecord(value, ["expected", "receipt"]) ||
      !exactRecord(value.expected, identityKeys) ||
      !exactRecord(value.receipt, [...identityKeys, "schemaVersion", "containers"]) ||
      !exactRecord(value.receipt.containers, services)
    )
      ctx.addIssue({ code: "custom", message: invalid().message });
  })
  .pipe(
    z.strictObject({
      expected: identity,
      receipt: z.strictObject({
        ...identity.shape,
        schemaVersion: z.literal(1),
        containers: z.strictObject({
          postgres: z.string().regex(/^[a-f0-9]{64}$/),
          redis: z.string().regex(/^[a-f0-9]{64}$/),
          minio: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      }),
    }),
  )
  .superRefine(({ expected, receipt }, ctx) => {
    if (
      identityKeys.some((key) => receipt[key] !== expected[key]) ||
      new Set(services.map((service) => receipt.containers[service])).size !== services.length
    )
      ctx.addIssue({ code: "custom", message: invalid().message });
  }) satisfies z.ZodType<M1OwnerNetwork>;

/** Receipt equality is a consistency check; the controller must inspect Docker before issuing it. */
export function assertM1OwnerNetwork(
  options: Pick<M1SupportOptions, "ownerNetwork" | "runId" | "attach" | "clock">,
  env: { readonly APP_ENV?: string; readonly DATABASE_URL?: string; readonly REDIS_URL?: string },
): void {
  if (env.APP_ENV !== "test" || options.attach !== undefined || options.clock !== undefined)
    throw invalid();
  const parsed = M1OwnerNetworkSchema.safeParse(options.ownerNetwork);
  if (!parsed.success || options.runId !== parsed.data.expected.runId) throw invalid();
  const { expected } = parsed.data;

  // Canonical strings reject extra credentials, ports, paths, query options and URL aliases.
  const host = `lyx-mixed-${expected.runId}`;
  if (
    !["postgresql", "postgres"].some(
      (scheme) =>
        env.DATABASE_URL === `${scheme}://liyoxi:lyx-local-dev@${host}-postgres:5432/liyoxi`,
    ) ||
    env.REDIS_URL !== `redis://${host}-redis:6379/0`
  )
    throw invalid();
}
