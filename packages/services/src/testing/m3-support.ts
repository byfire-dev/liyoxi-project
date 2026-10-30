// M3 合流支架：沿用 M1 唯一隔离/runtime/close；新增方法不直接写业务状态。
import { createNotices, insertDictItemsMissing } from "../config/index.js";
import { DEMO_DICT_ITEMS } from "../content/index.js";
import { DEMO_SEED_STEPS, runDemoSeed } from "../demo-seed.js";
import { loadKeyring } from "../security/index.js";
import type { DemoSeedReport } from "../demo-seed.js";
import { createM1Support } from "./m1-support.js";
import { prepareM1LicenseInputs } from "./m1-license-inputs.js";
import { seedM1ProfileDefaults } from "./m1-profile-defaults.js";
import type { M1Support, M1SupportOptions } from "./m1-types.js";
import { M3_JOB_SELECT, readM3Facts, resolveM3Scope } from "./m3-facts.js";
import type { M3MediaScope } from "./m3-facts.js";
import { m3ModelBudget } from "./m3-model-budget.js";

export type { M3MediaScope } from "./m3-facts.js";
export interface M3DrainOptions {
  readonly maxRounds?: number;
  readonly maxJobs?: number;
  readonly maxAdvanceMs?: number;
}
export interface M3Support extends M1Support {
  seedPrerequisites(): Promise<DemoSeedReport>;
  configureUnderstanding(enabled: boolean): void;
  readFacts(scope: M3MediaScope): Promise<Awaited<ReturnType<typeof readM3Facts>>>;
  drainMedia(
    scope: M3MediaScope,
    options?: M3DrainOptions,
  ): Promise<{
    readonly executed: number;
    readonly rounds: number;
    readonly advancedMs: number;
    readonly jobs: Awaited<ReturnType<typeof readM3Facts>>["jobs"];
  }>;
}
export type M3SupportOptions = Pick<M1SupportOptions, "runId" | "clock">;

export async function createM3Support(options: M3SupportOptions = {}): Promise<M3Support> {
  let understanding = false;
  const base = await createM1Support({
    ...options,
    prepareProviders(providers) {
      // handler 的 provider 标识在装配时固定，必须始终保持 fake；开关只控制配置/预算。
      // 首段正式日额度为 0，因此走真实 budget_unconfigured，不冒称 provider-unconfigured。
      const configured = <T extends object>(target: T): T =>
        new Proxy(target, {
          get(object, key) {
            if (key === "configured") return understanding;
            return Reflect.get(object, key, object);
          },
        });
      providers.asr = configured(providers.asr);
      providers.llm = configured(providers.llm);
    },
    modelBudgetTransport: (input) => m3ModelBudget(input, () => understanding),
  });
  let closed = false;
  const assertOwned = () => {
    if (closed || base.runtime.env.APP_ENV !== "test") throw new Error("M3 支架已关闭或环境改变");
  };
  const readFacts = (scope: M3MediaScope) => {
    assertOwned();
    return base.runtime.tx.run((tx) => readM3Facts(tx, scope));
  };
  return {
    ...base,
    async seedDemo() {
      throw new Error("M3 禁止旧内容种子；请 seedPrerequisites 后通过真实 HTTP 创建内容");
    },
    async seedPrerequisites() {
      assertOwned();
      const inputs = base.sharedScope().licenseTestInputs;
      if (!inputs) throw new Error("M3 缺少本轮owner明确授权的法定测试输入");
      const runtime = base.runtime;
      const report = await runDemoSeed({
        ...runtime,
        keyring: loadKeyring(runtime.env),
        appEnv: "test",
        // 显式列出前置；即使将来新增步骤也不会默默把业务造数带进 M3。
        steps: DEMO_SEED_STEPS.filter((step) =>
          ["staff", "media", "docs", "billing", "parameters"].includes(step.name),
        ),
        billing: { assembly: runtime.assembly, bizNo: runtime.bizNo },
        notices: createNotices({ clock: base.clock, events: runtime.events }),
        params: runtime.config.params,
      });
      // 跳过旧内容造数时，仍须准备本轮owner授权的虚构平台法定输入。
      await runtime.tx.run((tx) =>
        prepareM1LicenseInputs({
          db: tx,
          clock: base.clock,
          env: runtime.env,
          inputs,
        }),
      );
      const baseline = await seedM1ProfileDefaults(runtime);
      // 旧 content 种子还包含共享字典；只复用数据，不调用任何旧剧目/文件造数。
      const dictionaries = await runtime.tx.run((tx) =>
        insertDictItemsMissing(tx, DEMO_DICT_ITEMS, base.clock.now()),
      );
      if (dictionaries.inserted > 0) await runtime.config.cache.bump("dict");
      return {
        ...report,
        inserted: report.inserted + baseline.inserted + dictionaries.inserted,
        tables: [
          ...report.tables,
          { ...baseline, step: "m3-profile-baseline" },
          { ...dictionaries, step: "m3-shared-dictionaries" },
        ],
      };
    },
    configureUnderstanding(enabled) {
      assertOwned();
      if (typeof enabled !== "boolean") throw new TypeError("M3 理解配置必须为布尔值");
      understanding = enabled;
    },
    readFacts,
    async drainMedia(scope, options = {}) {
      assertOwned();
      const maxRounds = options.maxRounds ?? 24,
        maxJobs = options.maxJobs ?? 128,
        maxAdvanceMs = options.maxAdvanceMs ?? 120_000;
      if (
        !Number.isInteger(maxRounds) ||
        maxRounds < 1 ||
        maxRounds > 64 ||
        !Number.isInteger(maxJobs) ||
        maxJobs < 1 ||
        maxJobs > 256 ||
        !Number.isInteger(maxAdvanceMs) ||
        maxAdvanceMs < 0 ||
        maxAdvanceMs > 1_800_000
      )
        throw new TypeError("M3 排空上界不合法");
      const started = base.clock.now().getTime();
      let executed = 0;
      for (let round = 0; round < maxRounds; round++) {
        assertOwned();
        await base.drainEvents();
        const active = await base.runtime.tx.run(async (tx) => {
          const resolved = await resolveM3Scope(tx, scope);
          return tx.mediaJob.findMany({
            where: {
              AND: [
                resolved.jobWhere,
                { state: { in: ["queued", "running", "submitting", "submitted"] } },
              ],
            },
            select: M3_JOB_SELECT,
            orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
            take: maxJobs + 1,
          });
        });
        if (!active.length)
          return {
            executed,
            rounds: round + 1,
            advancedMs: base.clock.now().getTime() - started,
            jobs: (await readFacts(scope)).jobs,
          };
        if (active.length > maxJobs || executed >= maxJobs)
          throw new Error("M3 本轮任务排空超过任务上界");
        const now = base.clock.now().getTime(),
          next = active[0]!.nextRunAt.getTime();
        if (next > now) {
          if (next - started > maxAdvanceMs) throw new Error("M3 本轮任务排空超过拨钟上界");
          base.clock.advance(next - now);
        }
        for (const job of active) {
          if (job.nextRunAt > base.clock.now()) break;
          if (++executed > maxJobs) throw new Error("M3 本轮任务排空超过任务上界");
          await base.runtime.media.jobs.run({ jobId: job.id });
        }
      }
      throw new Error("M3 本轮任务排空超过轮次上界；不伪装业务完成");
    },
    async close() {
      closed = true;
      understanding = false;
      await base.close();
    },
  };
}
