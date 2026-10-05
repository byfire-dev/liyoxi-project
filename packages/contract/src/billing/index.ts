// billing 的 jsonb 结构（W1-10 起）：账本操作的展示文案码与参数。带 Zod，只从包入口给出。
export { LEDGER_TITLE_ARGS, LEDGER_TITLE_CODES, parseLedgerTitleArgs } from "./ledger.js";
export type { LedgerTitleArgs, LedgerTitleCode } from "./ledger.js";
