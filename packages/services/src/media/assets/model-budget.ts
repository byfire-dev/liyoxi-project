import { assertNotInTransaction, isInTransaction, isUuid } from "../../kernel/index.js";
import type { Clock } from "../../kernel/index.js";
import { jobBudget } from "../jobs/policy.js";

export interface ModelBudgetContext {
  readonly entityId: string;
  readonly storeId: string;
  readonly jobId: string;
  /** 人工retry后持久的新意图；首代缺失时仍使用真实jobId，不改变jobId本身。 */
  readonly modelIntentId?: string;
  readonly fileIds: readonly string[];
  readonly kind: "asr" | "vision" | "digest";
  readonly attemptNo: number;
  readonly expectedSourceHash: string;
  readonly dailyFileCap: number;
  readonly dailyCallCap: number;
  readonly readAtMs: number;
  readonly admitUntilMs: number;
  readonly leaseUntilMs: number;
  readonly originalDeadlineMs: number;
}
export interface ModelBudgetTransport {
  eval(script: string, keys: readonly string[], argv: readonly string[]): Promise<unknown>;
}
type Denial = "disabled" | "quota_global" | "quota_store" | "duplicate" | "stale" | "unavailable";
export type ModelBudgetDecision =
  | { readonly status: "reserved"; readonly units: number; readonly newFiles: number }
  | { readonly status: "denied"; readonly reason: Denial };
export type ModelBudgetMaintenance =
  | { readonly status: "maintained"; readonly scanned: number; readonly removed: number }
  | { readonly status: "denied"; readonly reason: "unavailable" };

const WAIT = 250,
  HARD_FIELDS = 250_000;
const denied = (reason: Denial): ModelBudgetDecision => ({ status: "denied", reason });
const uint = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
const fields = [
  "entityId",
  "storeId",
  "jobId",
  "fileIds",
  "kind",
  "attemptNo",
  "expectedSourceHash",
  "dailyFileCap",
  "dailyCallCap",
  "readAtMs",
  "admitUntilMs",
  "leaseUntilMs",
  "originalDeadlineMs",
];

function context(value: ModelBudgetContext, now: number): ModelBudgetContext | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== fields.length + (Object.hasOwn(value, "modelIntentId") ? 1 : 0) ||
    !fields.every((key) => Object.hasOwn(value, key)) ||
    (Object.hasOwn(value, "modelIntentId") &&
      (typeof value.modelIntentId !== "string" || !isUuid(value.modelIntentId))) ||
    ![value.entityId, value.storeId, value.jobId].every(
      (id) => typeof id === "string" && isUuid(id),
    ) ||
    !["asr", "vision", "digest"].includes(value.kind) ||
    !uint(value.attemptNo, 32767) ||
    value.attemptNo === 0 ||
    typeof value.expectedSourceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.expectedSourceHash) ||
    !uint(value.dailyFileCap, 200) ||
    !uint(value.dailyCallCap, 10000) ||
    !Array.isArray(value.fileIds) ||
    value.fileIds.length > 9 ||
    (value.kind !== "digest" && value.fileIds.length !== 1) ||
    !value.fileIds.every(
      (id, index) =>
        typeof id === "string" && isUuid(id) && (index === 0 || value.fileIds[index - 1]! < id),
    ) ||
    ![value.readAtMs, value.admitUntilMs, value.leaseUntilMs, value.originalDeadlineMs].every((n) =>
      uint(n, 8_640_000_000_000_000),
    ) ||
    value.readAtMs > now ||
    value.admitUntilMs <= now ||
    value.admitUntilMs > value.readAtMs + WAIT ||
    value.admitUntilMs > value.leaseUntilMs ||
    value.admitUntilMs > value.originalDeadlineMs ||
    value.originalDeadlineMs <= now ||
    value.originalDeadlineMs - now > jobBudget(value.kind)!.deadlineMs
  )
    return undefined;
  return { ...value, fileIds: [...value.fileIds] };
}

// 单KEY脚本共用检查；不自动建账，数字用十进制字符串保存，避免JSON精度截断。
const common = `
local key = KEYS[1]
local bad = {'denied','unavailable'}
local MAX = 9007199254740991
local DAY, OFFSET, SKEW = 86400000, 28800000, 5000
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
if redis.call('TYPE',key).ok ~= 'hash' then return bad end
local m = redis.call('HMGET',key,'marker','business','redis','day','closed','head','next','cursor')
if m[1] ~= 'model_budget_v1' then return bad end
local b,r,d,closed,head,nextq,cursor = num(m[2]),num(m[3]),num(m[4]),num(m[5]),num(m[6]),num(m[7]),num(m[8])
if not b or not r or not d or not closed or not head or not nextq or not cursor or
  head < 1 or head > nextq or cursor < head or cursor > nextq then return bad end
local now,limit = num(ARGV[1]),num(ARGV[2])
local time = redis.call('TIME')
local rt = tonumber(time[1])*1000 + math.floor(tonumber(time[2])/1000)
if not now or not limit or limit < 16 or limit > 250000 or now < b or rt < r or math.abs(now-rt) > SKEW then return bad end
local day = math.floor((now+OFFSET)/DAY)
if day < d or day ~= math.floor((rt+OFFSET)/DAY) then return bad end
local function index(kind,stamp,expiry,target)
  return cjson.encode({kind,dec(stamp),dec(expiry),target})
end
local function waters(h,n,c,floor)
  return {'business',dec(now),'redis',dec(rt),'day',dec(day),'closed',dec(floor),'head',dec(h),'next',dec(n),'cursor',dec(c)}
end
`;

const reserveScript =
  common +
  `
local read,admit,lease,deadline = num(ARGV[3]),num(ARGV[4]),num(ARGV[5]),num(ARGV[6])
local kind,attempt,job,store = ARGV[7],num(ARGV[8]),ARGV[9],ARGV[10]
local filecap,callcap = num(ARGV[11]),num(ARGV[12])
if not read or not admit or not lease or not deadline or not attempt or attempt < 1 or attempt > 32767 or
  not id(job) or not id(store) or not filecap or filecap > 200 or not callcap or callcap > 10000 or
  (kind ~= 'asr' and kind ~= 'vision' and kind ~= 'digest') then return bad end
if read > now or admit > read+250 or admit > lease or admit > deadline or
  now >= admit or rt >= admit or now >= lease or rt >= lease or now >= deadline or rt >= deadline or
  deadline <= closed or deadline-now > (kind == 'asr' and 1800000 or 900000) or
  math.floor((read+OFFSET)/DAY) ~= day then return {'denied','stale'} end
if filecap == 0 or callcap == 0 then return {'denied','disabled'} end
local token = 't:'..job..':'..dec(attempt)..':'..kind
local old = redis.call('HGET',key,token)
if old then if not num(old) then return bad end return {'denied','duplicate'} end
local g,s = 'g:'..dec(day),'s:'..dec(day)..':'..store
local gv,sv = redis.call('HGET',key,g),redis.call('HGET',key,s)
local used,files = gv and num(gv) or 0,sv and num(sv) or 0
if (gv and (not num(gv) or used == 0)) or (sv and (not num(sv) or files == 0)) or used > 10000 or files > 200 or (sv and not gv) then return bad end
local cost = kind == 'asr' and 1 or 3
local added,previous = {},nil
if #ARGV-12 > 9 or (kind ~= 'digest' and #ARGV-12 ~= 1) then return bad end
for i=13,#ARGV do
  local file = ARGV[i]
  if not id(file) or (previous and previous >= file) then return bad end
  previous = file
  local field = 'f:'..dec(day)..':'..store..':'..file
  local v = redis.call('HGET',key,field)
  if v then if v ~= '1' or not sv or not gv then return bad end else table.insert(added,field) end
end
if used+cost > callcap then return {'denied','quota_global'} end
if files+#added > filecap then return {'denied','quota_store'} end
local writes,new = {g,dec(used+cost),token,dec(deadline)},{}
local expiry = (day+2)*DAY-OFFSET
if not gv then table.insert(new,{g,index('g',day,expiry,g)}) end
if #added > 0 then
  table.insert(writes,s) table.insert(writes,dec(files+#added))
  if not sv then table.insert(new,{s,index('s',day,expiry,s)}) end
end
for _,f in ipairs(added) do table.insert(writes,f) table.insert(writes,'1') table.insert(new,{f,index('f',day,expiry,f)}) end
table.insert(new,{token,index('t',deadline,deadline+SKEW,token)})
if nextq > MAX-#new or redis.call('HLEN',key)+2*#new > limit then return bad end
for i,item in ipairs(new) do
  local q = 'q:'..dec(nextq+i-1)
  if redis.call('HEXISTS',key,q) == 1 then return bad end
  table.insert(writes,q) table.insert(writes,item[2])
end
for _,v in ipairs(waters(head,nextq+#new,cursor,closed)) do table.insert(writes,v) end
redis.call('HSET',key,unpack(writes))
return {'reserved',cost,#added}
`;

const maintainScript =
  common +
  `
local deletes,seen = {},{}
local scanned,removed,position,newhead,floor = 0,0,cursor,head,closed
if position == nextq then position = head end
for slot=1,math.min(128,nextq-head) do
  local q = 'q:'..dec(position)
  local raw = redis.call('HGET',key,q)
  local due = not raw
  if raw then
    local ok,v = pcall(cjson.decode,raw)
    if not ok or type(v) ~= 'table' or #v ~= 4 then return bad end
    local kind,stamp,expiry,target = v[1],num(v[2]),num(v[3]),v[4]
    if not stamp or not expiry or type(target) ~= 'string' or seen[target] then return bad end
    seen[target] = true
    local actual = redis.call('HGET',key,target)
    local value = num(actual)
    if not value then return bad end
    if kind == 't' then
      local job,attempt,k = string.match(target,'^t:([^:]+):(%d+):([^:]+)$')
      local a = num(attempt)
      if not id(job) or not a or a < 1 or a > 32767 or (k ~= 'asr' and k ~= 'vision' and k ~= 'digest') or
        value ~= stamp or expiry ~= stamp+SKEW then return bad end
    else
      local pd,store,file
      if kind == 'g' then pd = string.match(target,'^g:(%d+)$')
      elseif kind == 's' then pd,store = string.match(target,'^s:(%d+):([^:]+)$')
      elseif kind == 'f' then pd,store,file = string.match(target,'^f:(%d+):([^:]+):([^:]+)$')
      else return bad end
      if num(pd) ~= stamp or stamp > d or expiry ~= (stamp+2)*DAY-OFFSET or
        (kind ~= 'g' and not id(store)) or (kind == 'f' and (not id(file) or value ~= 1)) or
        value < 1 or (kind == 'g' and value > 10000) or (kind == 's' and value > 200) then return bad end
    end
    due = now >= expiry and rt >= expiry
    if due then
      if kind == 't' then floor = math.max(floor,stamp) end
      table.insert(deletes,target) table.insert(deletes,q) removed = removed+1
    end
  end
  if position == newhead and due then newhead = newhead+1 end
  position = position+1
  if position == nextq then position = newhead end
  scanned = scanned+1
end
if position < newhead or position >= nextq then position = newhead end
redis.call('HSET',key,unpack(waters(newhead,nextq,position,floor)))
if #deletes > 0 then redis.call('HDEL',key,unpack(deletes)) end
return {'maintained',scanned,removed}
`;

/** 独立前置：借用传输，不建账、不退款、不装配模型或查询；调用方必须已退出全部PG事务。 */
export function createModelBudgetLedger({
  clock,
  transport,
  prefix,
  maxFields = HARD_FIELDS,
}: {
  readonly clock: Clock;
  readonly transport?: ModelBudgetTransport;
  readonly prefix: string;
  readonly maxFields?: number;
}) {
  if (
    !/^lyx:(?:local|test|stg|prod):(?:[a-z0-9_-]+:)*$/.test(prefix) ||
    prefix.length > 128 ||
    !uint(maxFields, HARD_FIELDS) ||
    maxFields < 16
  )
    throw new TypeError("预算账本命名空间或技术上界不合法");
  const key = `${prefix}model_budget:v1`;
  const now = (): number => clock.now().getTime();
  async function call(
    script: string,
    argv: readonly string[],
    signal: AbortSignal,
    ms: number,
  ): Promise<unknown> {
    if (!transport || signal.aborted || ms <= 0) return undefined;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve(value);
      };
      const abort = () => finish();
      const timer = setTimeout(abort, Math.min(WAIT, ms));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        finish();
        return;
      }
      // 迟到的成功/拒绝都由此消费；不重放eval，也不产生新的allow。
      void Promise.resolve()
        .then(() => (signal.aborted ? undefined : transport.eval(script, [key], argv)))
        .then(finish, abort);
    });
  }
  return {
    async reserve(input: ModelBudgetContext, signal: AbortSignal): Promise<ModelBudgetDecision> {
      assertNotInTransaction("media.modelBudget.reserve");
      if (isInTransaction()) return denied("unavailable");
      try {
        const started = now();
        if (!uint(started)) return denied("unavailable");
        const permit = context(input, started);
        if (!permit) return denied("stale");
        if (permit.dailyFileCap === 0 || permit.dailyCallCap === 0) return denied("disabled");
        const reply = await call(
          reserveScript,
          [
            started,
            maxFields,
            permit.readAtMs,
            permit.admitUntilMs,
            permit.leaseUntilMs,
            permit.originalDeadlineMs,
            permit.kind,
            permit.attemptNo,
            permit.modelIntentId ?? permit.jobId,
            permit.storeId,
            permit.dailyFileCap,
            permit.dailyCallCap,
            ...permit.fileIds,
          ].map(String),
          signal,
          permit.admitUntilMs - started,
        );
        const fresh = now();
        if (
          !uint(fresh) ||
          fresh < started ||
          signal.aborted ||
          fresh >= permit.admitUntilMs ||
          fresh >= permit.leaseUntilMs ||
          fresh >= permit.originalDeadlineMs
        )
          return denied("stale");
        const cost = permit.kind === "asr" ? 1 : 3;
        if (
          Array.isArray(reply) &&
          reply.length === 3 &&
          reply[0] === "reserved" &&
          reply[1] === cost &&
          uint(reply[2], permit.fileIds.length)
        )
          return { status: "reserved", units: cost, newFiles: reply[2] };
        if (
          Array.isArray(reply) &&
          reply.length === 2 &&
          reply[0] === "denied" &&
          ["disabled", "quota_global", "quota_store", "duplicate", "stale", "unavailable"].includes(
            reply[1] as string,
          )
        )
          return denied(reply[1] as Denial);
      } catch {
        /* 传输/时钟/未知对象故障都关闭；不退款。 */
      }
      return denied("unavailable");
    },
    async maintain(signal: AbortSignal): Promise<ModelBudgetMaintenance> {
      assertNotInTransaction("media.modelBudget.maintain");
      const unavailable = { status: "denied", reason: "unavailable" } as const;
      if (isInTransaction()) return unavailable;
      try {
        const started = now();
        if (!uint(started)) return unavailable;
        const reply = await call(
          maintainScript,
          [String(started), String(maxFields)],
          signal,
          WAIT,
        );
        const fresh = now();
        if (
          uint(fresh) &&
          fresh >= started &&
          !signal.aborted &&
          Array.isArray(reply) &&
          reply.length === 3 &&
          reply[0] === "maintained" &&
          uint(reply[1], 128) &&
          uint(reply[2], reply[1])
        )
          return { status: "maintained", scanned: reply[1], removed: reply[2] };
      } catch {
        /* 清理未知结果同样不能恢复授权。 */
      }
      return unavailable;
    },
  };
}
