import { APP_ENVS, assertNotInTransaction, isInTransaction } from "../kernel/index.js";
import type { AppEnv, Clock } from "../kernel/index.js";
import type { ModelBudgetTransport } from "../media/index.js";

const WAIT = 250,
  DAY = 86400000,
  OFFSET = 28800000;
const unavailable = { status: "unavailable" } as const;
const uint = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export type ModelBudgetInspection =
  | typeof unavailable
  | { readonly status: "inspected"; readonly key: "missing" | "wrong_type" }
  | {
      readonly status: "inspected";
      readonly key: "hash";
      readonly schema: "invalid_metadata" | "invalid_sample";
      readonly reason: "metadata" | "field_bound" | "current_counter" | "index" | "target";
    }
  | {
      readonly status: "inspected";
      readonly key: "hash";
      readonly schema: "sampled_metadata_ok";
      readonly fieldCount: number;
      readonly closedBeforeMs: number;
      readonly clock: {
        businessNowMs: number;
        redisNowMs: number;
        savedBusinessMs: number;
        savedRedisMs: number;
        savedDay: number;
        businessDay: number;
        redisDay: number;
        rollback: boolean;
        dayMismatch: boolean;
        skewExceeded: boolean;
        rolloverPending: boolean;
      };
      readonly coverage: {
        kind: "sampled";
        slotsRead: number;
        holes: number;
        totalSlots: number;
        hasMore: boolean;
      };
      readonly sampledReservations: {
        beforeDeadline: number;
        retentionWindow: number;
        expired: number;
        boundaryDisagreement: number;
        earliestDeadlineMs: number | null;
        latestDeadlineMs: number | null;
      };
      readonly currentGlobalUsed: number | null;
    };

// 仅读一个正式key；返回值不包含target/标识符或任何原始字段内容。
const script = `
local key = KEYS[1]
local ty = redis.call('TYPE',key).ok
if ty == 'none' then return {'missing'} end
if ty ~= 'hash' then return {'wrong_type'} end
local function bad(scope,reason) return {'hash',scope,reason} end
local MAX,DAY,OFFSET,SKEW = 9007199254740991,86400000,28800000,5000
local function num(v)
  if type(v) ~= 'string' or not (v == '0' or string.match(v,'^[1-9]%d*$')) then return nil end
  local n = tonumber(v)
  if not n or n > MAX or n < 0 or n ~= math.floor(n) then return nil end
  return n
end
local function dec(n) return string.format('%.0f',n) end
local function id(v)
  return type(v) == 'string' and #v == 36 and string.sub(v,9,9) == '-' and
    string.sub(v,14,14) == '-' and string.sub(v,19,19) == '-' and string.sub(v,24,24) == '-' and
    #string.gsub(v,'-','') == 32 and string.match(string.gsub(v,'-',''),'^[0-9a-f]+$') ~= nil
end
local m = redis.call('HMGET',key,'marker','business','redis','day','closed','head','next','cursor')
local b,r,d,c,h,n,pos = num(m[2]),num(m[3]),num(m[4]),num(m[5]),num(m[6]),num(m[7]),num(m[8])
if m[1] ~= 'model_budget_v1' or not b or not r or not d or not c or not h or not n or not pos or
  h < 1 or h > n or pos < h or pos > n then return bad('invalid_metadata','metadata') end
local length = redis.call('HLEN',key)
if length > 250000 then return bad('invalid_metadata','field_bound') end
local now = num(ARGV[1])
if not now then return bad('invalid_metadata','metadata') end
local time = redis.call('TIME')
local rt = tonumber(time[1])*1000 + math.floor(tonumber(time[2])/1000)
local day = math.floor((now+OFFSET)/DAY)
local current = redis.call('HGET',key,'g:'..dec(day))
local used = current and num(current) or -1
if current and (not used or used < 1 or used > 10000) then return bad('invalid_metadata','current_counter') end
local seen,holes,live,retaining,expired,split,earliest,latest = {},0,0,0,0,0,MAX,0
local scanned = math.min(128,n-h)
for i=0,scanned-1 do
  local raw = redis.call('HGET',key,'q:'..dec(h+i))
  if not raw then holes = holes+1 else
    local ok,v = pcall(cjson.decode,raw)
    if not ok or type(v) ~= 'table' or #v ~= 4 then return bad('invalid_sample','index') end
    local kind,stamp,expiry,target = v[1],num(v[2]),num(v[3]),v[4]
    if not stamp or not expiry or type(target) ~= 'string' or seen[target] then return bad('invalid_sample','index') end
    seen[target] = true
    local value = num(redis.call('HGET',key,target))
    if not value then return bad('invalid_sample','target') end
    if kind == 't' then
      local job,attempt,k = string.match(target,'^t:([^:]+):(%d+):([^:]+)$')
      local a = num(attempt)
      if not id(job) or not a or a < 1 or a > 32767 or (k ~= 'asr' and k ~= 'vision' and k ~= 'digest') or
        value ~= stamp or expiry ~= stamp+SKEW then return bad('invalid_sample','target') end
      earliest,latest = math.min(earliest,stamp),math.max(latest,stamp)
      if now < stamp and rt < stamp then live = live+1
      elseif now >= expiry and rt >= expiry then expired = expired+1
      elseif now >= stamp and rt >= stamp and now < expiry and rt < expiry then retaining = retaining+1
      else split = split+1 end
    else
      local pd,store,file
      if kind == 'g' then pd = string.match(target,'^g:(%d+)$')
      elseif kind == 's' then pd,store = string.match(target,'^s:(%d+):([^:]+)$')
      elseif kind == 'f' then pd,store,file = string.match(target,'^f:(%d+):([^:]+):([^:]+)$')
      else return bad('invalid_sample','target') end
      if num(pd) ~= stamp or stamp > d or expiry ~= (stamp+2)*DAY-OFFSET or
        (kind ~= 'g' and not id(store)) or (kind == 'f' and (not id(file) or value ~= 1)) or
        value < 1 or (kind == 'g' and value > 10000) or (kind == 's' and value > 200) then
        return bad('invalid_sample','target') end
    end
  end
end
if live+retaining+expired+split == 0 then earliest,latest = -1,-1 end
return {'hash',length,rt,b,r,d,c,h,n,pos,scanned,holes,live,retaining,expired,split,earliest,latest,used}
`;

function parse(value: unknown, now: number): ModelBudgetInspection {
  if (!Array.isArray(value)) return unavailable;
  if (value.length === 1 && ["missing", "wrong_type"].includes(value[0]))
    return { status: "inspected", key: value[0] };
  if (value.length === 3 && value[0] === "hash") {
    const reasons = {
      invalid_metadata: ["metadata", "field_bound", "current_counter"],
      invalid_sample: ["index", "target"],
    };
    if (
      Object.hasOwn(reasons, value[1]) &&
      reasons[value[1] as keyof typeof reasons].includes(value[2])
    )
      return { status: "inspected", key: "hash", schema: value[1], reason: value[2] };
    return unavailable;
  }
  if (
    value.length !== 19 ||
    value[0] !== "hash" ||
    value.slice(1, 16).some((n) => !uint(n)) ||
    value.slice(16).some((n) => !uint(n) && n !== -1)
  )
    return unavailable;
  const [
    ,
    fieldCount,
    rt,
    b,
    r,
    d,
    c,
    h,
    n,
    cursor,
    slots,
    holes,
    live,
    retaining,
    expired,
    split,
    earliest,
    latest,
    used,
  ] = value as [string, ...number[]];
  if (
    fieldCount! < 8 ||
    fieldCount! > 250000 ||
    h! < 1 ||
    h! > n! ||
    cursor! < h! ||
    cursor! > n! ||
    slots !== Math.min(128, n! - h!) ||
    holes! > slots! ||
    fieldCount! < 8 + 2 * (slots! - holes!) ||
    (used !== -1 && fieldCount! < 9) ||
    live! + retaining! + expired! + split! > slots! - holes! ||
    used! > 10000 ||
    used === 0 ||
    (live! + retaining! + expired! + split! === 0
      ? earliest !== -1 || latest !== -1
      : earliest! < 0 || earliest! > latest!)
  )
    return unavailable;
  const businessDay = Math.floor((now + OFFSET) / DAY),
    redisDay = Math.floor((rt! + OFFSET) / DAY);
  return {
    status: "inspected",
    key: "hash",
    schema: "sampled_metadata_ok",
    fieldCount: fieldCount!,
    closedBeforeMs: c!,
    clock: {
      businessNowMs: now,
      redisNowMs: rt!,
      savedBusinessMs: b!,
      savedRedisMs: r!,
      savedDay: d!,
      businessDay,
      redisDay,
      rollback: now < b! || rt! < r! || businessDay < d! || redisDay < d!,
      dayMismatch: businessDay !== redisDay,
      skewExceeded: Math.abs(now - rt!) > 5000,
      rolloverPending: d! < businessDay && d! < redisDay,
    },
    coverage: {
      kind: "sampled",
      slotsRead: slots!,
      holes: holes!,
      totalSlots: n! - h!,
      hasMore: n! - h! > slots!,
    },
    sampledReservations: {
      beforeDeadline: live!,
      retentionWindow: retaining!,
      expired: expired!,
      boundaryDisagreement: split!,
      earliestDeadlineMs: earliest === -1 ? null : earliest!,
      latestDeadlineMs: latest === -1 ? null : latest!,
    },
    currentGlobalUsed: used === -1 ? null : used!,
  };
}

/** 只诊断，不授权、不维护、不拥有连接；正式namespace不可覆盖。 */
export function createModelBudgetInspector(input: {
  readonly appEnv: AppEnv;
  readonly clock: Clock;
  readonly transport?: ModelBudgetTransport;
}) {
  if (
    !input ||
    Object.keys(input).some((key) => !["appEnv", "clock", "transport"].includes(key)) ||
    !APP_ENVS.includes(input.appEnv)
  )
    throw new TypeError("预算诊断环境不合法");
  const key = `lyx:${input.appEnv}:model_budget:v1`,
    controllers = new Set<AbortController>(),
    pending = new Set<Promise<ModelBudgetInspection>>();
  let closed = false,
    closing: Promise<void> | undefined;
  return {
    inspect(signal: AbortSignal): Promise<ModelBudgetInspection> {
      assertNotInTransaction("ops.modelBudget.inspect");
      if (closed || signal.aborted || isInTransaction() || !input.transport)
        return Promise.resolve(unavailable);
      const controller = new AbortController(),
        abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      controllers.add(controller);
      const running = (async (): Promise<ModelBudgetInspection> => {
        try {
          const now = input.clock.now().getTime();
          if (!uint(now)) return unavailable;
          const raw = await new Promise<unknown>((resolve) => {
            let settled = false;
            const finish = (v?: unknown) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              controller.signal.removeEventListener("abort", cancel);
              resolve(v);
            };
            const cancel = () => finish(),
              timer = setTimeout(cancel, WAIT);
            controller.signal.addEventListener("abort", cancel, { once: true });
            if (closed || signal.aborted) controller.abort();
            if (controller.signal.aborted) return finish();
            void Promise.resolve()
              .then(() =>
                controller.signal.aborted
                  ? undefined
                  : input.transport!.eval(script, [key], [String(now)]),
              )
              .then(finish, cancel);
          });
          const fresh = input.clock.now().getTime();
          return !uint(fresh) || fresh < now || fresh >= now + WAIT || signal.aborted || closed
            ? unavailable
            : parse(raw, now);
        } catch {
          return unavailable;
        } finally {
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
      return (closing ??= Promise.allSettled([...pending]).then(() => undefined));
    },
  };
}
