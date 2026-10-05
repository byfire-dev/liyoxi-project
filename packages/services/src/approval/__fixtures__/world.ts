// approval 连库用例的共用部分（W1-06）：只给本目录的测试用。
// 一个测试文件一个带种子的库（角色、字典、清单模板都是种子里的）；探针表在 beforeAll 里用属主身份建。
// 员工、商家用测试数据工厂造；员工上下文照库里的员工行、角色行建（sampleStaffContext）。
import type { PrismaClient } from "@liyoxi/db";
import { beforeAll } from "vitest";

import type { StaffContext } from "../../authz/index.js";
import { isAppError, uuidv7 } from "../../kernel/index.js";
import type { IdentityContext } from "../../kernel/index.js";
import {
  connectTestDatabase,
  createClock,
  createFactories,
  createSampleApproval,
  SAMPLE_APPROVAL_DDL,
  sampleMerchantIdentity,
  sampleStaffContext,
  sampleStaffIdentity,
  useSeededDatabase,
} from "../../testing/index.js";
import type {
  Factories,
  SampleApproval,
  SampleSubmitInput,
  TestDatabase,
} from "../../testing/index.js";

/** 连库的用例与钩子的时限：机器忙的时候建库、删库都慢 */
export const SLOW = 120_000;

export interface Person {
  readonly id: string;
  /** 身份上下文：操作人、请求号 */
  readonly identity: IdentityContext;
  /** 员工上下文：权限点与数据范围 */
  readonly staff: StaffContext;
}

export interface Merchant {
  readonly userId: string;
  readonly entityId: string;
  readonly storeId: string;
  readonly identity: IdentityContext;
}

export interface StaffOptions {
  role?: string;
  isLead?: boolean;
  groupId?: string | null;
}

export interface World {
  db: TestDatabase;
  prisma: PrismaClient;
  sample: SampleApproval;
  make: Factories;
  /** 造一名在职员工，缺省是财务（数据范围“全部”，持 billing.adjust.approve、finance.refund.approve） */
  person(options?: StaffOptions): Promise<Person>;
  /** 员工行变了之后（禁用、换组）重新读一遍上下文 */
  reload(person: Person): Promise<Person>;
  group(roleKey: string): Promise<string>;
  /** 造一个已认证的商家；给了交付经理就把门店挂到他名下 */
  merchant(options?: { managerId?: string }): Promise<Merchant>;
  /** 五种样例申请的入参 */
  input: {
    pointsAdjust(merchant: Merchant): SampleSubmitInput;
    extend(merchant: Merchant): SampleSubmitInput;
    qualification(merchant: Merchant, roundNo?: number): SampleSubmitInput;
    channelAccount(merchant: Merchant): SampleSubmitInput;
    orderCancel(merchant: Merchant, dramaOrderId?: string): SampleSubmitInput;
  };
}

/** 在测试文件顶层调：返回的对象在 beforeAll 之后才有内容 */
export function useApprovalWorld(options: { max?: number } = {}): World {
  const db = useSeededDatabase("services", options);
  const world = { db } as World;

  beforeAll(async () => {
    const prisma = await db.prisma();
    const owner = await connectTestDatabase(db.name, { role: null });
    try {
      await owner.query(SAMPLE_APPROVAL_DDL);
    } finally {
      await owner.end();
    }
    const clock = createClock();
    const make = createFactories({ db: prisma, clock });
    const sample = createSampleApproval(prisma);
    let groups = 0;

    const reload = async (person: Pick<Person, "id">): Promise<Person> => ({
      id: person.id,
      identity: sampleStaffIdentity(person.id),
      staff: await sampleStaffContext(prisma, person.id),
    });

    Object.assign(world, {
      prisma,
      sample,
      make,
      reload,
      async person({ role = "finance", isLead = false, groupId = null }: StaffOptions = {}) {
        const staff = await make.staff({ staffRoleKey: role, isLead, staffGroupId: groupId });
        return reload(staff);
      },
      async group(roleKey: string) {
        groups += 1;
        const now = clock.now();
        const group = await prisma.staffGroup.create({
          data: {
            id: uuidv7(),
            name: `样例组 ${uuidv7().slice(-6)}-${String(groups)}`,
            staffRoleKey: roleKey,
            createdAt: now,
            updatedAt: now,
          },
        });
        return group.id;
      },
      async merchant({ managerId }: { managerId?: string } = {}) {
        const { user, entity, store } = await make.merchant({ verified: true });
        if (managerId !== undefined) {
          await prisma.store.update({
            where: { id: store.id },
            data: { deliveryManagerId: managerId },
          });
        }
        return {
          userId: user.id,
          entityId: entity.id,
          storeId: store.id,
          identity: sampleMerchantIdentity(user.id, entity.id, store.id),
        };
      },
      input: {
        pointsAdjust: ({ entityId }: Merchant) => ({
          kind: "points_adjust",
          subjectType: "billing_account",
          subjectId: entityId,
          entityId,
        }),
        extend: ({ entityId }: Merchant) => ({
          kind: "subscription_extend",
          subjectType: "subscription_term",
          subjectId: uuidv7(),
          entityId,
        }),
        qualification: ({ entityId, storeId }: Merchant, roundNo = 1) => ({
          kind: "qualification",
          subjectType: "store",
          subjectId: storeId,
          entityId,
          storeId,
          input: { roundNo },
        }),
        channelAccount: ({ entityId, storeId }: Merchant) => ({
          kind: "channel_account",
          subjectType: "channel_account",
          subjectId: uuidv7(),
          entityId,
          storeId,
        }),
        orderCancel: ({ entityId, storeId }: Merchant, dramaOrderId = uuidv7()) => ({
          kind: "order_cancel",
          subjectType: "drama_order",
          subjectId: dramaOrderId,
          entityId,
          storeId,
        }),
      },
    } satisfies Omit<World, "db">);
  }, SLOW);

  return world;
}

/** 调一下，拿到它抛的业务错误的符号名与 details；没抛、抛的不是 AppError 都让用例失败 */
export async function refusal(
  attempt: Promise<unknown>,
): Promise<{ error: string; details: unknown }> {
  try {
    await attempt;
  } catch (error) {
    if (isAppError(error)) return { error: error.error, details: error.details };
    throw error;
  }
  throw new Error("本该被拒，却成功了");
}
