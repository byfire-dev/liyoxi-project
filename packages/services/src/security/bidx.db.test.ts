import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";

import { uuidv7 } from "../kernel/index.js";
import { useTestDatabase } from "../testing/index.js";
import { ringA, ringBA } from "./__fixtures__/keys.js";
import { blindIndex } from "./bidx.js";
import { openField, phoneBidx, sealPhone } from "./pii.js";

// 验收第 7 条：盲索引可等值查。真库里的 merchant_user：phone_enc、phone_bidx（唯一）、phone_mask、phone_last4。
// 连接用支架给的缺省身份（应用角色 lyx_app）。

const db = useTestDatabase("services");
let prisma: PrismaClient;
const COLUMN = "merchant_user.phone_enc";
const NOW = new Date("2026-01-05T04:00:00Z");

async function addUser(phone: string): Promise<string> {
  const sealed = sealPhone(ringA, COLUMN, phone);
  const id = uuidv7();
  await prisma.merchantUser.create({
    data: {
      id,
      phoneEnc: sealed.enc,
      phoneBidx: sealed.bidx,
      phoneMask: sealed.mask,
      phoneLast4: sealed.last4,
      status: "active",
      sourceType: "organic",
      lastActiveAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
  return id;
}

const findByPhone = (phone: string) =>
  prisma.merchantUser.findMany({ where: { phoneBidx: phoneBidx(ringA, phone) } });

beforeAll(async () => {
  prisma = await db.prisma();
}, 120_000);

describe("盲索引：真库里等值查", () => {
  let first: string;
  let second: string;

  it("写两行，按盲索引查到且只查到对应的那一行", async () => {
    first = await addUser("13812345678");
    second = await addUser("+86 139 0000 1111");
    const found = await findByPhone("13812345678");
    expect(found.map((row) => row.id)).toEqual([first]);
    expect(found[0]?.phoneMask).toBe("138****5678");
    expect(found[0]?.phoneLast4).toBe("5678");
    expect(openField(ringA, COLUMN, found[0]?.phoneEnc ?? "")).toBe("13812345678");
    expect((await findByPhone("13900001111")).map((row) => row.id)).toEqual([second]);
    expect(await findByPhone("13812345670")).toEqual([]);
  });

  it("+86 写法与纯数字写法盲索引相同：查到同一行", async () => {
    for (const written of [
      "+8613812345678",
      "+86 138-1234-5678",
      "8613812345678",
      "138 1234 5678",
    ]) {
      expect((await findByPhone(written)).map((row) => row.id)).toEqual([first]);
    }
    expect((await findByPhone("13900001111")).map((row) => row.id)).toEqual([second]);
  });

  it("库里存的是 32 字节；同一明文在 phone、uscc 两种用途下不同，按 uscc 的盲索引查不到", async () => {
    const row = await prisma.merchantUser.findUniqueOrThrow({ where: { id: first } });
    expect(row.phoneBidx).toHaveLength(32);
    const asUscc = blindIndex(ringA, "uscc", "13812345678");
    expect(asUscc.equals(Buffer.from(row.phoneBidx ?? []))).toBe(false);
    expect(await prisma.merchantUser.findMany({ where: { phoneBidx: asUscc } })).toEqual([]);
  });

  it("唯一约束落在盲索引上：换一种写法再注册同一个号码被拒", async () => {
    await expect(addUser("+8613812345678")).rejects.toMatchObject({ code: "P2002" });
  });

  it("数据密钥轮换之后，旧行照样按盲索引查到、解得开", async () => {
    const found = await prisma.merchantUser.findMany({
      where: { phoneBidx: phoneBidx(ringBA, "13812345678") },
    });
    expect(found.map((row) => row.id)).toEqual([first]);
    expect(openField(ringBA, COLUMN, found[0]?.phoneEnc ?? "")).toBe("13812345678");
  });
});
