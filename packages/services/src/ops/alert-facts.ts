import { detach, uuidv7 } from "../kernel/index.js";
import type { AlertInput, Alerts, Clock, Tx, TxRunner } from "../kernel/index.js";
import type { ProviderLogger } from "../providers/types.js";
import { ALERT_RULES } from "./alert-rules.js";

export interface AlertFactsDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly logger: ProviderLogger;
}
export interface AlertFacts extends Alerts {
  close(): Promise<void>;
}

const RULE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const forbidden =
  /phone|openid|password|secret|token|cookie|authorization|license|idno|uscc|cipher|enc|rawbody|stack|message|error/i;

/** 原告警 writer 的有界标量投影；不序列化未知对象或异常。 */
export function safeAlertDetail(
  detail: Readonly<Record<string, unknown>>,
): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(detail).slice(0, 32)) {
    if (forbidden.test(key) || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) continue;
    if (value === null || typeof value === "boolean") result[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (
      typeof value === "string" &&
      value.length <= 160 &&
      /^[a-zA-Z0-9_.:/@ -]*$/.test(value)
    )
      result[key] = value;
  }
  return result;
}

function fingerprint(input: AlertInput): string {
  if (typeof input.rule !== "string" || input.rule.length > 120 || !RULE.test(input.rule))
    throw new TypeError("告警规则键不合法");
  if (
    input.dimension !== undefined &&
    (typeof input.dimension !== "string" ||
      input.dimension.length === 0 ||
      input.dimension.length > 200 ||
      !/^[a-zA-Z0-9_.:/-]+$/.test(input.dimension))
  )
    throw new TypeError("告警维度不合法");
  if (!["P1", "P2", "P3"].includes(input.severity)) throw new TypeError("告警级别不合法");
  if (input.detail === null || typeof input.detail !== "object" || Array.isArray(input.detail))
    throw new TypeError("告警详情不合法");
  return input.dimension === undefined ? input.rule : `${input.rule}:${input.dimension}`;
}

/** 唯一 SQL writer；后继 probe 通道也从所属独立事务调用此函数，不复制 upsert。 */
export async function writeAlertFact(
  tx: Tx,
  input: AlertInput,
  kind: "event" | "probe",
  at: Date,
): Promise<void> {
  const key = fingerprint(input);
  if (kind !== "event" && kind !== "probe") throw new TypeError("告警类型不合法");
  await tx.$executeRawUnsafe(
    `INSERT INTO alert_event
      (id,fingerprint,rule,severity,kind,status,first_seen_at,last_seen_at,last_value,created_at,updated_at)
      VALUES ($1::uuid,$2,$3,$4,$5,'open',$6,$6,$7::jsonb,$6,$6)
      ON CONFLICT (fingerprint) WHERE status IN ('open','acked') DO UPDATE
      SET severity=LEAST(alert_event.severity,EXCLUDED.severity),
        last_seen_at=EXCLUDED.last_seen_at,occurrences=alert_event.occurrences+1,
        ok_streak=0,updated_at=EXCLUDED.updated_at,
        last_value=EXCLUDED.last_value
          || CASE WHEN alert_event.last_value ? '_notifiedSeverity'
            THEN jsonb_build_object('_notifiedSeverity',alert_event.last_value->>'_notifiedSeverity') ELSE '{}'::jsonb END
          || CASE WHEN alert_event.last_value ? '_robotFailures'
            THEN jsonb_build_object('_robotFailures',alert_event.last_value->'_robotFailures') ELSE '{}'::jsonb END`,
    uuidv7(),
    key,
    input.rule,
    input.severity,
    kind,
    at,
    JSON.stringify(safeAlertDetail(input.detail)),
  );
}

/** 每个运行时独占关闭状态和在途写；不持有或关闭借用的连接池。 */
export function createAlertFacts({ tx, clock, logger }: AlertFactsDeps): AlertFacts {
  let closed = false;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  const log = (evt: string, message: string) => {
    try {
      logger.error({ evt }, message);
    } catch {
      // 日志口故障同样不得覆盖业务原异常。
    }
  };
  return {
    raise(input) {
      if (closed) {
        log("ops.alert_facts_closed", "告警事实运行时已关闭");
        return Promise.resolve();
      }
      const writing = Promise.resolve().then(async () => {
        try {
          fingerprint(input);
          const known = ALERT_RULES.includes(input.rule);
          if (!known) log("ops.alert_unknown_rule", "告警键未登记，已转为受控告警事实");
          const actual: AlertInput = known
            ? input
            : {
                rule: "ops.unknown_rule",
                dimension: input.rule,
                severity: "P2",
                detail: { requestedRule: input.rule },
              };
          const at = clock.now();
          await detach(() => tx.run((handle) => writeAlertFact(handle, actual, "event", at)));
        } catch {
          log("ops.alert_write_failed", "告警独立事务写入失败");
        }
      });
      pending.add(writing);
      void writing.finally(() => pending.delete(writing));
      return writing;
    },
    close() {
      closed = true;
      return (closing ??= Promise.all([...pending]).then(() => undefined));
    },
  };
}

/** 静态登记不持有 mutable binding；实际进程必须用所属 Assembly 注入 writer。 */
export const unboundAlertFacts: Alerts = {
  async raise() {
    throw new TypeError("告警事实运行时尚未装配");
  },
};
