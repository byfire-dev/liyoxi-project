// 三段式用例（W0-20）：事务外必须调外部服务的用例的统一写法。占用 → 外呼 → 落结果；中断后可续做，结果只落一次。
// 依据：约定 第 7 节 C51；01 第 5 节调用规则 3；01 分组 第 2.1 节的状态机；D7 第 3.1 节、第 2.3 节规则 5。
//
//   ① 事务一：占用幂等行（in_progress，30 秒），执行用例的 claim（记业务意图），一起提交。
//   ② 事务外：执行用例的 external。外部侧的幂等靠用例自己给的稳定的外部幂等号（商户单号、退款单号），工具不替它生成。
//   ③ 末个事务：把占用改成 done，执行用例的 settle（写业务结果），存结果，一起提交。
//
// 重复请求（同键）：哈希不同 → IDEMPOTENCY_KEY_REUSED；已完成 → 重放存下的结果，三段都不执行；
// 占用未过期 → IDEMPOTENCY_IN_PROGRESS；占用已过期（上一次的进程断在半路）→ 条件更新抢到占用后续做：
// claim 再执行一遍（resumed 为真，要写成“取得或新建”，取回上一次记下的意图），然后照常 ②、③。
//
// 出错怎么收场，只分两种：
//   业务失败  用例自己在 external、settle 里抛的 AppError：外部明确没办成，或落结果时守卫不过。
//             另开一个事务删掉占用、执行用例的 compensate（删行或标失败），错误原样抛出；同一个键可以直接重试。
//   结果未知  其余的一切：进程中断、程序错误、事务机制报的 BUSY 与超时。什么都不收拾，错误原样抛出；
//             占用留到过期，由重复请求续做。所以 external 里“不知道对方办没办成”时不要包成 AppError。
// claim 里抛错：事务一整个回滚，占用也不留。
//
// 三种形态（约定 C51）是同一条流水的三种用法：
//   先调外部、再开事务   不写 claim（或 claim 只读）；settle 落结果。
//   先落库、提交后外调   claim 落本地行；settle 按结果更新；compensate 删行或标失败。
//   多事务               claim 落技术状态；业务失败时它已提交、不回滚；要标记就写在 compensate 里。
// 幂等为 none、natural 的用例（如主动查单）走同一条流水，不读写幂等记录：没有占用，也就没有续做与重放。
import type { Clock } from "../clock.js";
import { AppError, isAppError } from "../errors.js";
import {
  completeIdempotency,
  enterIdempotency,
  IDEMPOTENCY_LEASE_MS,
  occupyIdempotency,
  releaseIdempotency,
  settleIdempotency,
  storeIdempotentResult,
  takeOverIdempotency,
} from "../idempotency.js";
import type { IdempotencyContext } from "../idempotency.js";
import { assertNotInTransaction, isInTransaction, KernelViolation } from "../tx.js";
import type { Tx, TxRunner } from "../tx.js";

export interface ThreePhaseClaim {
  /** 这次是不是接手续做：抢到了一个过期的占用。为真时上一次的 claim 已经提交过 */
  readonly resumed: boolean;
}

export interface ThreePhaseFailure {
  /** 用例抛的业务错误 */
  readonly error: AppError;
  /** 在哪一段抛的 */
  readonly phase: "external" | "settle";
}

/** 一个三段式用例的各段。Intent 是 claim 记下的业务意图，Outcome 是外部的应答，Result 是用例的返回值 */
export interface ThreePhaseUseCase<Result, Outcome, Intent = undefined> {
  /** 事务一：记业务意图，返回值交给后面各段。续做时会再执行一遍：写成“取得或新建”。不写即没有业务意图 */
  claim?: (tx: Tx, claim: ThreePhaseClaim) => Promise<Intent>;
  /** 事务外：调外部服务。用稳定的外部幂等号：续做时会再调一遍，外部侧同号只能生效一次 */
  external: (intent: Intent) => Promise<Outcome>;
  /** 末个事务：写业务结果。返回值存进幂等记录，要能 JSON 序列化 */
  settle: (tx: Tx, outcome: Outcome, intent: Intent) => Promise<Result>;
  /** 业务失败时在单独的事务里执行：删掉或标记 claim 落下的行。不写即什么都不动（claim 提交的技术状态留着） */
  compensate?: (tx: Tx, intent: Intent, failure: ThreePhaseFailure) => Promise<void>;
}

export interface ThreePhaseRunnerOptions {
  tx: TxRunner;
  /** 占用的到期时间取它 */
  clock: Clock;
}

export interface ThreePhaseRunOptions {
  /** 幂等上下文：与 tx.run 的 idem 是同一个东西，一个上下文只给一次。required 才读写幂等记录 */
  idem?: IdempotencyContext;
}

export interface ThreePhaseRunner {
  /** 跑一个三段式用例。只在事务外调用；重放时返回存下的结果，上下文的 replayed 为真 */
  run<Result, Outcome, Intent = undefined>(
    useCase: ThreePhaseUseCase<Result, Outcome, Intent>,
    options?: ThreePhaseRunOptions,
  ): Promise<Result>;
}

/**
 * 外呼前钩子：交给 createProviders、createFakeProviders 的 beforeCall（装配处接）。
 * 在事务里调任何 Provider 方法，local、test 下在这里抛错，请求发不出去；stg、prod 上报后照常调（D7 第 2.3 节规则 5）。
 */
export function guardProviderCall(call: {
  readonly provider: string;
  readonly method: string;
}): void {
  assertNotInTransaction(`${call.provider}.${call.method}`);
}

type Claimed<Intent> = { replay: unknown } | { intent: Intent; lease: Date | undefined };

export function createThreePhaseRunner({ tx, clock }: ThreePhaseRunnerOptions): ThreePhaseRunner {
  return {
    async run<Result, Outcome, Intent = undefined>(
      useCase: ThreePhaseUseCase<Result, Outcome, Intent>,
      { idem }: ThreePhaseRunOptions = {},
    ): Promise<Result> {
      if (isInTransaction()) {
        throw new KernelViolation(
          "external_call_in_transaction",
          "三段式用例不能在事务里跑：它要在两个事务之间调外部服务（01 第 5 节调用规则 3）",
        );
      }
      if (idem && !enterIdempotency(idem)) {
        throw new KernelViolation(
          "idempotency_context_reused",
          "一个幂等上下文只给一次：这个上下文已经交给过 tx.run 或别的三段式用例",
        );
      }
      const keyed = idem?.mode === "required" ? idem : undefined;

      // ① 占用（或抢占），连同业务意图提交。没有幂等记录、也没有 claim 的用例不开这个事务
      let claimed: Claimed<Intent> = { intent: undefined as Intent, lease: undefined };
      if (keyed || useCase.claim) {
        claimed = await tx.run(async (handle): Promise<Claimed<Intent>> => {
          let lease: Date | undefined;
          let resumed = false;
          if (keyed) {
            const now = clock.now();
            lease = new Date(now.getTime() + IDEMPOTENCY_LEASE_MS);
            const found = await occupyIdempotency(handle, keyed, lease);
            if (found.state === "done") return { replay: found.result };
            if (found.state === "in_progress") {
              const expired = found.lockedUntil.getTime() <= now.getTime();
              if (!expired || !(await takeOverIdempotency(handle, keyed, now, lease))) {
                throw new AppError("IDEMPOTENCY_IN_PROGRESS");
              }
              resumed = true;
            }
          }
          const intent = (await useCase.claim?.(handle, { resumed })) as Intent;
          return { intent, lease };
        });
      }
      if ("replay" in claimed) {
        if (idem) settleIdempotency(idem, true);
        return claimed.replay as Result;
      }
      const { intent, lease } = claimed;

      /** 业务失败的收场：删掉自己的占用、执行补偿。占用已被别的请求接手时什么都不做，由接手的一方收场 */
      const abandon = async (failure: ThreePhaseFailure): Promise<void> => {
        if (!keyed && !useCase.compensate) return;
        await tx.run(async (handle) => {
          if (keyed && lease && !(await releaseIdempotency(handle, keyed, lease))) return;
          await useCase.compensate?.(handle, intent, failure);
        });
      };

      // ② 事务外调外部
      let outcome: Outcome;
      try {
        outcome = await useCase.external(intent);
      } catch (error) {
        if (isAppError(error)) await abandon({ error, phase: "external" });
        throw error;
      }

      // ③ 写回占用，落业务结果
      let rejected: unknown;
      let settled: { replay: unknown } | { result: Result };
      try {
        settled = await tx.run(async (handle) => {
          if (keyed && lease) {
            const finished = await completeIdempotency(handle, keyed, lease);
            if (finished) return { replay: finished.result };
          }
          let result: Result;
          try {
            result = await useCase.settle(handle, outcome, intent);
          } catch (error) {
            // 记下“这是 settle 自己抛的”：事务机制报的 BUSY 也是 AppError，那不算业务失败
            rejected = error;
            throw error;
          }
          if (keyed) await storeIdempotentResult(handle, keyed, result);
          return { result };
        });
      } catch (error) {
        if (error === rejected && isAppError(error)) await abandon({ error, phase: "settle" });
        throw error;
      }
      if (idem) settleIdempotency(idem, "replay" in settled);
      return "replay" in settled ? (settled.replay as Result) : settled.result;
    },
  };
}
