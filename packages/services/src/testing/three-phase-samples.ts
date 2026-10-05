// 三段式的样例用例（W0-20）：只给测试与演示用，不进生产装配。真实的三段式用例（约定 C51 的登记表）由各域的包写。
//
// 样例业务是“预下单尝试”：一张探针表 lyx_sample_prepay（不在迁移里，测试库里现建），外部服务是 Provider 的微信支付
// （测试里传替身：预下单幂等于商户单号）。三种形态共用 external 与 settle，只差 claim 与 compensate：
//   external_first  先调外部、再开事务：不写 claim，settle 里落整行
//   local_first     先落库、提交后外调：claim 落一行 pending；外呼失败时 compensate 删行
//   multi_tx        多事务：claim 落一行 pending（技术状态）；业务失败时它不回滚，compensate 只把它标成 closed
// settled 列记 settle 执行了几次：“业务结果只落一次”就是它等于 1。
import { AppError } from "../kernel/index.js";
import type { ThreePhaseUseCase, Tx } from "../kernel/index.js";
import type { WechatPayProvider } from "../providers/types.js";

export const SAMPLE_PREPAY_TABLE = "lyx_sample_prepay";

/** 建探针表并授权给应用角色。要属主身份的连接（connectTestDatabase(库名, { role: null })）；可重复执行 */
export const SAMPLE_PREPAY_DDL = `
  CREATE TABLE IF NOT EXISTS ${SAMPLE_PREPAY_TABLE} (
    out_trade_no text PRIMARY KEY,
    status text NOT NULL CHECK (status IN ('pending', 'prepaid', 'closed')),
    prepay_id text,
    settled integer NOT NULL DEFAULT 0
  );
  GRANT SELECT, INSERT, UPDATE, DELETE ON ${SAMPLE_PREPAY_TABLE} TO lyx_app;`;

export type SampleShape = "external_first" | "local_first" | "multi_tx";

export interface SamplePrepayInput {
  /** 商户单号：业务侧稳定的外部幂等号，续做时再呼用的还是它 */
  outTradeNo: string;
  amountFen: number;
  payerOpenid: string;
}

export interface SamplePrepayResult {
  outTradeNo: string;
  prepayId: string;
  /** 调起参数：短时有效，登记脱敏路径 payParams 后重放为 null（约定 C50） */
  payParams: string | null;
}

export interface SamplePrepayDeps {
  wechatPay: WechatPayProvider;
  /** 包住外呼：故障注入时传 createCallInterrupter().call；不给就直接调 */
  call?: <T>(external: () => Promise<T>) => Promise<T>;
}

export interface SamplePrepayRow {
  outTradeNo: string;
  status: string;
  prepayId: string | null;
  settled: number;
}

type Intent = { outTradeNo: string } | undefined;

/** 一个样例用例的各段，交给三段式工具的 run */
export function samplePrepay(
  shape: SampleShape,
  { wechatPay, call = (external) => external() }: SamplePrepayDeps,
  input: SamplePrepayInput,
): ThreePhaseUseCase<SamplePrepayResult, { prepayId: string }, Intent> {
  const { outTradeNo } = input;
  const useCase: ThreePhaseUseCase<SamplePrepayResult, { prepayId: string }, Intent> = {
    async external() {
      const sent = await call(() =>
        wechatPay.createJsapiOrder({ ...input, description: "三段式样例" }),
      );
      if (sent.ok) return sent.value;
      // 外部明确没办成：抛业务错误，工具据此补偿并释放占用。结果未知（中断、超时不知成败）不走这里
      throw new AppError(
        sent.reason === "rejected" ? "STATE_NOT_ALLOWED" : "PROVIDER_UNAVAILABLE",
        {
          message: sent.message,
        },
      );
    },
    async settle(tx, { prepayId }) {
      await tx.$executeRaw`
        INSERT INTO lyx_sample_prepay AS p (out_trade_no, status, prepay_id, settled)
        VALUES (${outTradeNo}, 'prepaid', ${prepayId}, 1)
        ON CONFLICT (out_trade_no) DO UPDATE
          SET status = 'prepaid', prepay_id = EXCLUDED.prepay_id, settled = p.settled + 1`;
      return { outTradeNo, prepayId, payParams: `prepay_id=${prepayId}` };
    },
  };
  if (shape === "external_first") return useCase;
  return {
    ...useCase,
    // 取得或新建：续做时这一行已经在了
    async claim(tx) {
      await tx.$executeRaw`
        INSERT INTO lyx_sample_prepay (out_trade_no, status) VALUES (${outTradeNo}, 'pending')
        ON CONFLICT (out_trade_no) DO NOTHING`;
      return { outTradeNo };
    },
    async compensate(tx) {
      if (shape === "local_first") {
        await tx.$executeRaw`DELETE FROM lyx_sample_prepay WHERE out_trade_no = ${outTradeNo}`;
      } else {
        await tx.$executeRaw`
          UPDATE lyx_sample_prepay SET status = 'closed' WHERE out_trade_no = ${outTradeNo}`;
      }
    },
  };
}

/** 探针表的全部行，按商户单号排序 */
export const samplePrepayRows = (db: { $queryRaw: Tx["$queryRaw"] }): Promise<SamplePrepayRow[]> =>
  db.$queryRaw<SamplePrepayRow[]>`
    SELECT out_trade_no AS "outTradeNo", status, prepay_id AS "prepayId", settled
    FROM lyx_sample_prepay ORDER BY out_trade_no`;
