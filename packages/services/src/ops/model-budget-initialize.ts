import { APP_ENVS, assertNotInTransaction, isInTransaction } from "../kernel/index.js";
import type { AppEnv, Clock } from "../kernel/index.js";
import { jobBudget } from "../media/index.js";
import type { ModelBudgetTransport } from "../media/index.js";
import { createModelBudgetInspector } from "./model-budget-inspect.js";

const WAIT = 250,
  DAY = 86_400_000,
  OFFSET = 28_800_000,
  SKEW = 5_000;
const maxDeadline = Math.max(
  ...["asr", "vision", "digest"].map((kind) => jobBudget(kind)!.deadlineMs),
);
const unavailable = { status: "unavailable" } as const;
export type ModelBudgetInitialization =
  | typeof unavailable
  | { readonly status: "refused"; readonly reason: "existing" | "wrong_type" | "clock" }
  | {
      readonly status: "initialized";
      readonly blockedBeijingDay: number;
      readonly closedBeforeMs: number;
      readonly earliestConfiguredDayMs: number;
    };
const uint = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

// 仅missing时一次HSET。未知当日用量按硬上限占满；不修损坏、不恢复快照、不退款。
const script = `
local key = KEYS[1]
local ty = redis.call('TYPE',key).ok
if ty ~= 'none' then return {'refused',ty == 'hash' and 'existing' or 'wrong_type'} end
local MAX,DAY,OFFSET,SKEW = 9007199254740991,86400000,28800000,5000
local function num(v)
  if type(v) ~= 'string' or not (v == '0' or string.match(v,'^[1-9]%d*$')) then return nil end
  local n = tonumber(v)
  return n and n <= MAX and n >= 0 and n == math.floor(n) and n or nil
end
local function dec(n) return string.format('%.0f',n) end
local now,duration = num(ARGV[1]),num(ARGV[2])
if not now or not duration or duration < 1 or duration > 1800000 then return {'unavailable'} end
local time = redis.call('TIME')
local rt = tonumber(time[1])*1000 + math.floor(tonumber(time[2])/1000)
local day = math.floor((now+OFFSET)/DAY)
if math.abs(now-rt) > SKEW or day ~= math.floor((rt+OFFSET)/DAY) then return {'refused','clock'} end
local tomorrow = (day+1)*DAY-OFFSET
local closed = tomorrow+duration+SKEW
if closed > MAX then return {'unavailable'} end
local g = 'g:'..dec(day)
local q = cjson.encode({'g',dec(day),dec((day+2)*DAY-OFFSET),g})
redis.call('HSET',key,'marker','model_budget_v1','business',dec(now),'redis',dec(rt),
  'day',dec(day),'closed',dec(closed),'head','1','next','2','cursor','1',g,'10000','q:1',q)
return {'initialized',day,closed,tomorrow}
`;

/** 显式保守建账；只借用传输，构造零IO，绝不接入runtime自动启动。 */
export function createModelBudgetInitializer(input: {
  readonly appEnv: AppEnv;
  readonly clock: Clock;
  readonly transport?: ModelBudgetTransport;
}) {
  if (
    !input ||
    Object.keys(input).some((key) => !["appEnv", "clock", "transport"].includes(key)) ||
    !APP_ENVS.includes(input.appEnv)
  )
    throw new TypeError("预算建账环境不合法");
  const key = `lyx:${input.appEnv}:model_budget:v1`,
    inspector = createModelBudgetInspector(input),
    controllers = new Set<AbortController>(),
    pending = new Set<Promise<ModelBudgetInitialization>>();
  let closed = false,
    closing: Promise<void> | undefined;
  return {
    initialize(signal: AbortSignal): Promise<ModelBudgetInitialization> {
      assertNotInTransaction("ops.modelBudget.initialize");
      if (closed || signal.aborted || isInTransaction() || !input.transport)
        return Promise.resolve(unavailable);
      const controller = new AbortController(),
        abort = () => controller.abort(),
        timer = setTimeout(abort, WAIT);
      signal.addEventListener("abort", abort, { once: true });
      controllers.add(controller);
      const running = (async (): Promise<ModelBudgetInitialization> => {
        try {
          const start = input.clock.now().getTime();
          if (!uint(start)) return unavailable;
          // 预检只给事实；写脚本仍再核TYPE，不能靠此读结果跨竞态覆盖已有账本。
          const fact = await inspector.inspect(controller.signal);
          if (fact.status !== "inspected") return unavailable;
          if (fact.key !== "missing")
            return {
              status: "refused",
              reason: fact.key === "wrong_type" ? "wrong_type" : "existing",
            };
          const now = input.clock.now().getTime();
          if (!uint(now) || now < start || now >= start + WAIT || controller.signal.aborted)
            return unavailable;
          const raw = await new Promise<unknown>((resolve) => {
            let settled = false;
            const finish = (value?: unknown) => {
              if (settled) return;
              settled = true;
              controller.signal.removeEventListener("abort", cancel);
              resolve(value);
            };
            const cancel = () => finish();
            controller.signal.addEventListener("abort", cancel, { once: true });
            if (controller.signal.aborted) return finish();
            void Promise.resolve()
              .then(() =>
                controller.signal.aborted
                  ? undefined
                  : input.transport!.eval(script, [key], [String(now), String(maxDeadline)]),
              )
              .then(finish, cancel);
          });
          const fresh = input.clock.now().getTime();
          if (
            !uint(fresh) ||
            fresh < now ||
            fresh >= start + WAIT ||
            controller.signal.aborted ||
            closed
          )
            return unavailable;
          if (
            Array.isArray(raw) &&
            raw.length === 2 &&
            raw[0] === "refused" &&
            ["existing", "wrong_type", "clock"].includes(raw[1])
          )
            return { status: "refused", reason: raw[1] };
          const day = Math.floor((now + OFFSET) / DAY),
            tomorrow = (day + 1) * DAY - OFFSET,
            floor = tomorrow + maxDeadline + SKEW;
          return Array.isArray(raw) &&
            raw.length === 4 &&
            raw[0] === "initialized" &&
            raw[1] === day &&
            raw[2] === floor &&
            raw[3] === tomorrow
            ? {
                status: "initialized",
                blockedBeijingDay: day,
                closedBeforeMs: floor,
                earliestConfiguredDayMs: tomorrow,
              }
            : unavailable;
        } catch {
          // 超时/未知结果不推定未写，不重发；下次显式预检仍拒绝任何已有key。
          return unavailable;
        } finally {
          clearTimeout(timer);
          controllers.delete(controller);
          signal.removeEventListener("abort", abort);
        }
      })();
      pending.add(running);
      void running.then(
        () => pending.delete(running),
        () => pending.delete(running),
      );
      return running;
    },
    close(): Promise<void> {
      closed = true;
      for (const controller of controllers) controller.abort();
      return (closing ??= Promise.allSettled([...pending, inspector.close()]).then(
        () => undefined,
      ));
    },
  };
}
