// Fictional upstream test inputs only. No production default, bootstrap identity or ready evidence.
import type { PrismaClient } from "@liyoxi/db";
import { assertTestDatabaseUrl } from "@liyoxi/db/testing/standalone";
import { paramsAt } from "../config/index.js";
import { uuidv7 } from "../kernel/index.js";
import type { Clock, Env } from "../kernel/index.js";
import { fakeUscc } from "./data/factories/context.js";

export const M1_LICENSE_TEST_INPUTS = {
  portalPublicOrigin: "https://portal.example.invalid",
} as const;
export type M1LicenseTestInputs = typeof M1_LICENSE_TEST_INPUTS;
type M1LicenseInputDb = Pick<PrismaClient, "$queryRaw" | "paramValue" | "staff">;

export function assertM1LicenseTestInputs(value: unknown): asserts value is M1LicenseTestInputs {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join() !== "portalPublicOrigin" ||
    !("portalPublicOrigin" in value) ||
    value.portalPublicOrigin !== M1_LICENSE_TEST_INPUTS.portalPublicOrigin
  )
    throw new Error("M1 授权测试输入必须由owner明确传递固定虚构验真地址");
}

export async function assertM1LicenseTestDatabase(db: M1LicenseInputDb, databaseUrl: string) {
  assertTestDatabaseUrl(databaseUrl);
  const actual = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (new URL(databaseUrl).pathname !== `/${actual[0]?.name}`)
    throw new Error("M1 虚构法定输入的借用连接与本轮测试库不一致");
}

/** Caller must first verify its owned scope; the borrowed client must target that exact test DB. */
export async function prepareM1LicenseInputs(input: {
  db: M1LicenseInputDb;
  clock: Clock;
  env: Pick<Env, "APP_ENV" | "DATABASE_URL" | "PORTAL_PUBLIC_ORIGIN">;
  inputs: M1LicenseTestInputs;
}) {
  assertM1LicenseTestInputs(input.inputs);
  const { db, clock, env } = input;
  if (
    !["test", "local"].includes(env.APP_ENV) ||
    env.PORTAL_PUBLIC_ORIGIN !== input.inputs.portalPublicOrigin
  )
    throw new Error("M1 虚构法定输入仅接受显式授权的本轮测试装配");
  await assertM1LicenseTestDatabase(db, env.DATABASE_URL);
  const now = clock.now();
  if ((await paramsAt(db, ["platform.legal_entity"], now))["platform.legal_entity"]) return;
  // Real M1 bootstrap/demo seed (or explicit historical fixture input) has already supplied staff.
  const staff = await db.staff.findFirstOrThrow({
    where: { status: "active", staffRoleKey: "super_admin" },
    orderBy: { id: "asc" },
  });
  await db.paramValue.createMany({
    data: [
      {
        id: uuidv7(),
        key: "platform.legal_entity",
        value: { name: "授权测试平台（虚构）", creditCode: fakeUscc(900001) },
        effectiveAt: now,
        createdAt: now,
        createdByStaffId: staff.id,
        reason: "隔离测试owner授权的虚构法定输入，非授权书生成结果",
      },
    ],
    skipDuplicates: true,
  });
  if (!(await paramsAt(db, ["platform.legal_entity"], now))["platform.legal_entity"])
    throw new Error("M1 当前虚构平台法定输入不可用");
}
