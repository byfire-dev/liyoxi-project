import { beforeAll, describe, expect, it } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";
import { harness, buyer, drama, version, residual } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
  await version(h);
}, 120000);
describe("只读报价边界", () => {
  it("唯一剧已删除/不存在：返回可验证的空报价与阻断，零业务写入", async () => {
    const b = await buyer(h),
      id = uuidv7();
    const q = await h.order.quote(b.actor, { dramaIds: [id], isTopModel: false });
    expect(q.items).toEqual([]);
    expect(q.expect).toEqual({ totalChargePoints: 0, items: [] });
    expect(q.blockers).toContainEqual(
      expect.objectContaining({ code: "DRAMA_NOT_ORDERABLE", dramaId: id }),
    );
    expect(await residual(h, b.entity.id)).toEqual({ orders: 0, items: 0, holds: 0, consents: 0 });
  });
  it("同平台两账号为请求校验失败，不吞成可提交报价阻断", async () => {
    const b = await buyer(h),
      d = await drama(h),
      a = await h.prisma.channelAccount.findUniqueOrThrow({ where: { id: b.accountId } }),
      id = uuidv7();
    await h.prisma.channelAccount.create({
      data: { ...a, id, accountUid: id, accountUidNorm: id },
    });
    await expect(
      h.order.quote(b.actor, {
        dramaIds: [d.id],
        channelAccountIds: [a.id, id],
        isTopModel: false,
      }),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
  });
});
