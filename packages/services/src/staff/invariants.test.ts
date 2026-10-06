// W1-01b 只核对已有 staff.I8 登记；不登记会在无管理员库违规的 staff.I2。
import { expect, it } from "vitest";
import { createTxRunner } from "../kernel/index.js";
import { useSeededDatabase } from "../testing/index.js";
import { registration } from "./register.js";

const db = useSeededDatabase("services");
it("staff.I8 恰登记一次：种子库零违规，少一行角色只报缺的角色", { timeout: 180_000 }, async () => {
  const prisma = await db.prisma();
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const matches = registration.invariants.filter((item) => item.code === "staff.I8");
  expect(matches).toHaveLength(1);
  const invariant = matches[0]!;
  const context = { now: new Date("2026-10-06T00:00:00Z") };
  expect(await tx.run((current) => invariant.run!(current, {}, context))).toEqual([]);
  await prisma.staffGroup.deleteMany({ where: { staffRoleKey: "channel_ops" } });
  await prisma.staffRole.delete({ where: { key: "channel_ops" } });
  expect(await tx.run((current) => invariant.run!(current, {}, context))).toMatchObject([
    { subject: { type: "staff_role", key: "channel_ops" } },
  ]);
});
