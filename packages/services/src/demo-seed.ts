// 演示种子的运行器（W1-01a 起头；计划 第 8.5 节；docs/plan/tasks/README.md 第 7.3 节）。
//   命令：pnpm db:seed:demo（入口 packages/services/scripts/demo-seed.ts）。库要先跑完迁移与 pnpm db:seed。
//   只进本地、测试与预发：APP_ENV=prod 拒绝执行。仓库里不放任何固定口令：演示员工都建成待激活，激活码只打印一次。
//   可以反复跑：每一步都是“没有才建”，再跑一遍新增 0 行、不重发激活码。
//   加一步：在模块目录里写 demo-seed.ts（只经服务函数写），从模块入口给出，再在下面的 DEMO_SEED_STEPS 里加一行。
//   先后固定：staff → 占位文件入库（W1-07）→ docs（W1-03）→ billing（W1-11b）→ content（W1-13）→ 演示参数（W1-21）。
//   前面的步骤要交给后面用的东西放进 state（如演示员工的 id：staff.demoStaffId(state.staff, "content_ops")）；
//   要别的依赖（配置、存储……）就往 DemoSeedDeps 里加字段，入口脚本从进程运行时取来给上。
// 本文件是包级文件，不属于任何一层：只引各模块的 index.ts。
import { AGREEMENT_SEEDS, seedPlaceholderAgreementVersions } from "./docs/index.js";
import { seedPlaceholderFiles } from "./media/index.js";
import type { Media } from "./media/index.js";
import type { Notices } from "./config/index.js";
import { createIdentityContext, lockRows } from "./kernel/index.js";
import type { Flow } from "./flow/index.js";
import type { AppEnv, Clock, SeedTableResult, TxRunner } from "./kernel/index.js";
import type { Keyring } from "./security/index.js";
import { seedDemoStaff } from "./staff/index.js";
import type { DemoStaffMember } from "./staff/index.js";

export interface DemoSeedDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  /** 字段加密的密钥环（security.loadKeyring(env)） */
  readonly keyring: Keyring;
  readonly flow: Pick<Flow, "transition">;
  readonly appEnv: AppEnv;
  readonly media?: Media;
  readonly notices?: Pick<Notices, "announce">;
}

/** 步骤之间传的东西：前面的步骤写，后面的步骤读 */
export interface DemoSeedState {
  /** 演示员工（staff 一步写入）；它之前是空数组 */
  staff: readonly DemoStaffMember[];
  files: Record<string, { pdfFileId: string; sha256: string }>;
}

export interface DemoSeedStep {
  /** 模块目录名或这一步的名字，打印用 */
  readonly name: string;
  run(deps: DemoSeedDeps, state: DemoSeedState): Promise<readonly SeedTableResult[]>;
}

/** 按先后跑。各包在自己的位置加一行，不改别人的行 */
export const DEMO_SEED_STEPS: readonly DemoSeedStep[] = [
  {
    name: "staff",
    async run(deps, state) {
      const result = await seedDemoStaff(deps);
      state.staff = result.staff;
      return result.tables;
    },
  },
  {
    name: "media",
    async run(deps, state) {
      if (!deps.media) return [];
      const result = await seedPlaceholderFiles(
        deps.media,
        AGREEMENT_SEEDS.map((seed) => seed.key),
      );
      state.files = result.files;
      return result.tables;
    },
  },
  {
    name: "docs",
    async run(deps, state) {
      if (!deps.media || !deps.notices) return [];
      const staffId = state.staff.find((staff) => staff.key === "content_ops")?.staffId;
      if (!staffId) throw new Error("协议占位种子缺演示内容运营员工");
      const ctx = createIdentityContext({ actor: { type: "system", job: "docs.demo_seed" } });
      return deps.tx.run(async (tx) => {
        const result = await seedPlaceholderAgreementVersions(
          tx,
          ctx,
          { clock: deps.clock, notices: deps.notices!, appEnv: deps.appEnv },
          { staffId, files: state.files },
        );
        const versions = await tx.agreementVersion.findMany({
          where: { pdfFileId: { in: Object.values(state.files).map((file) => file.pdfFileId) } },
          select: { id: true, sourceFileId: true, pdfFileId: true },
        });
        const fileIds = versions.flatMap((row) =>
          [row.sourceFileId, row.pdfFileId].filter((id): id is string => id !== null),
        );
        await lockRows(tx, "file_object", fileIds);
        for (const version of versions)
          for (const [role, fileId] of [
            ["source", version.sourceFileId],
            ["pdf", version.pdfFileId],
          ] as const)
            if (fileId)
              await deps.media!.link(tx, {
                fileId,
                refType: "agreement_version",
                refId: version.id,
                role,
                entityId: null,
                storeId: null,
              });
        return result;
      });
    },
  },
  // billing 的受控财务配置占位：W1-11b
  // content 的 3 部演示剧：W1-13
  // 演示参数（order.start_delay_minutes = 0）：W1-21
];

/** 生产环境拒绝执行 */
export class DemoSeedRefusedError extends Error {
  constructor() {
    super("演示种子只进本地、测试与预发，APP_ENV=prod 下拒绝执行");
    this.name = "DemoSeedRefusedError";
  }
}

export interface DemoSeedReport {
  readonly at: Date;
  readonly tables: readonly (SeedTableResult & { readonly step: string })[];
  /** 新增的总行数；再跑一遍应为 0 */
  readonly inserted: number;
  /** 演示员工；本次新建的带激活码（明文只在这里出现一次） */
  readonly staff: readonly DemoStaffMember[];
}

export async function runDemoSeed(
  deps: DemoSeedDeps & { readonly steps?: readonly DemoSeedStep[] },
): Promise<DemoSeedReport> {
  if (deps.appEnv === "prod") throw new DemoSeedRefusedError();
  const at = deps.clock.now();
  const state: DemoSeedState = { staff: [], files: {} };
  const tables: (SeedTableResult & { step: string })[] = [];
  for (const step of deps.steps ?? DEMO_SEED_STEPS) {
    const results = await step.run(deps, state);
    tables.push(...results.map((result) => ({ step: step.name, ...result })));
  }
  return {
    at,
    tables,
    inserted: tables.reduce((sum, table) => sum + table.inserted, 0),
    staff: state.staff,
  };
}
