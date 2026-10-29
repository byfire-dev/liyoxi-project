// W2-03：低层员工服务只读拥有者的当前在办事实，并经同一拥有者完成改派。
import type {
  ASSIGNMENT_HISTORY_SOURCE,
  ASSIGNMENT_HISTORY_SUBJECT_TYPE,
} from "@liyoxi/contract/enums";
import { defineKeyedPort } from "../assembly/index.js";
import type { Assembly } from "../assembly/index.js";
import { AppError } from "../errors.js";
import type { RowLockTable } from "../lock.js";
import type { IdentityContext } from "../actor.js";
import type { Tx } from "../tx.js";

export type StaffWorkSourceKey = (typeof ASSIGNMENT_HISTORY_SOURCE.values)[number];
export type StaffWorkSubjectType = (typeof ASSIGNMENT_HISTORY_SUBJECT_TYPE.values)[number];
/** 已落地的五个默认必需来源；可选来源不能削弱这份要求。 */
export const STAFF_WORK_OWNERS = ["profile", "order", "delivery", "publish", "staff"] as const;
export type StaffWorkOwner = (typeof STAFF_WORK_OWNERS)[number] | "ad";
const dispatchOwners = [...STAFF_WORK_OWNERS, "ad"] as const;

export interface StaffWorkItem {
  readonly source: StaffWorkSourceKey;
  readonly subjectType: StaffWorkSubjectType;
  readonly subjectId: string;
  readonly label: string;
  readonly entityId: string;
  readonly storeId: string | null;
  /** 派生发布任务的负责人仍改其所属工单，不能复制处理人到任务表。 */
  readonly reassignOwner: StaffWorkOwner;
  readonly locks: readonly { readonly table: RowLockTable; readonly id: string }[];
}
export interface StaffWorkQuery {
  readonly staffId: string;
  readonly now: Date;
}
export interface StaffWorkReassignment {
  readonly fromStaffId: string;
  readonly toStaffId: string;
  readonly items: readonly StaffWorkItem[];
  readonly ctx: IdentityContext;
  readonly now: Date;
}
export interface StaffWorkSource {
  /** 返回真实当前对象，空数组只代表该已登记拥有者的查询结果。 */
  listOpen(tx: Tx, input: StaffWorkQuery): Promise<readonly StaffWorkItem[]>;
  /** 调用者已先锁员工与全部业务行；实现重新校验当前归属，返回真正改动的对象。 */
  reassign(tx: Tx, input: StaffWorkReassignment): Promise<readonly StaffWorkItem[]>;
}
export const staffWorkPort = defineKeyedPort<StaffWorkSource>("staff.work_sources");

export interface StaffFollowUpSubject {
  readonly entityId: string;
  readonly storeId: string | null;
}
export type StaffFollowUpReader = (tx: Tx, id: string) => Promise<StaffFollowUpSubject | null>;
export const staffFollowUpPort = defineKeyedPort<StaffFollowUpReader>("staff.follow_up_subjects");

export interface StaffWorkSources {
  read(tx: Tx, input: StaffWorkQuery): Promise<readonly StaffWorkItem[]>;
  reassign(tx: Tx, input: StaffWorkReassignment): Promise<readonly StaffWorkItem[]>;
}

/** 每个 runtime 只拿自己的 assembly；遗漏已落地来源必须显式拒绝，不能当计数零。 */
export function staffWorkSourcesOf(
  assembly: Pick<Assembly, "portEntries">,
  options: { readonly requiredOwners?: readonly StaffWorkOwner[] } = {},
): StaffWorkSources {
  const sources = assembly.portEntries(staffWorkPort);
  const requiredOwners = [...new Set([...STAFF_WORK_OWNERS, ...(options.requiredOwners ?? [])])];
  const missingSources = (missing: readonly StaffWorkOwner[]) =>
    new AppError("INTERNAL", {
      message: "员工在办来源尚未完整装配",
      details: { missingSources: missing },
    });
  const required = (inputOwners: readonly StaffWorkOwner[] = []) => {
    const missing = [...new Set([...requiredOwners, ...inputOwners])].filter(
      (key) => !sources.has(key),
    );
    if (missing.length > 0) throw missingSources(missing);
    return sources;
  };
  const unique = (items: readonly StaffWorkItem[]) => {
    const byKey = new Map<string, StaffWorkItem>();
    for (const item of items) {
      const key = `${item.source}:${item.subjectType}:${item.subjectId}`;
      const prior = byKey.get(key);
      if (prior && prior.reassignOwner !== item.reassignOwner)
        throw new AppError("INTERNAL", { message: "同一在办对象的改派拥有者不一致" });
      byKey.set(key, item);
    }
    return [...byKey.values()];
  };
  return {
    async read(tx, input) {
      const items: StaffWorkItem[] = [];
      for (const source of required().values()) items.push(...(await source.listOpen(tx, input)));
      return unique(items);
    },
    async reassign(tx, input) {
      const implementations = required(input.items.map((item) => item.reassignOwner));
      const moved: StaffWorkItem[] = [];
      for (const owner of dispatchOwners) {
        const items = input.items.filter((item) => item.reassignOwner === owner);
        if (items.length > 0) {
          const source = implementations.get(owner);
          if (!source) throw missingSources([owner]);
          moved.push(...(await source.reassign(tx, { ...input, items })));
        }
      }
      return unique(moved);
    },
  };
}

/** 只有激活码这次调用持有明文；实现必须在员工事务提交后调用。 */
export type StaffActivationSender = (input: {
  readonly phone: string;
  readonly code: string;
  readonly activationId: string;
}) => Promise<{ readonly status: string }>;
