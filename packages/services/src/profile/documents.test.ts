import { beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../kernel/index.js";
import { useSeededDatabase } from "../testing/index.js";
import { harness, ownedFile } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
describe("证照手填与日期展示", () => {
  it.each([
    { uscc: "91310000MA1K000000" },
    { validFrom: "2026-02-30" },
    { validFrom: "long_term" },
    { validFrom: "2026-02-01", validTo: "2026-01-01" },
    { unknown: "不能注入未定义字段" },
  ] as Record<string, string>[])("非法字段 %j 回滚派生列与轮次版本", async (fields) => {
    const { viewer } = await h.owner(),
      file = await ownedFile(h, viewer, "kyc_license");
    const created = await h.profile.createDocument(viewer, {
      docType: "business_license",
      fileId: file.id,
    });
    await expect(
      h.profile.updateDocument(viewer, created.doc.qualificationDocId, {
        lockVersion: created.lockVersion,
        fields,
      }),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    expect(
      (
        await h.prisma.qualificationDoc.findUniqueOrThrow({
          where: { id: created.doc.qualificationDocId },
        })
      ).submittedFieldsEnc,
    ).toBeNull();
    expect(
      (
        await h.prisma.qualificationSubmission.findUniqueOrThrow({
          where: { id: created.qualificationSubmissionId },
        })
      ).lockVersion,
    ).toBe(created.lockVersion);
  });
  it("许可证字段依字典脱敏，并按生效参数和北京时间算临期", async () => {
    const { viewer } = await h.owner(),
      file = await ownedFile(h, viewer, "kyc_permit");
    const created = await h.profile.createDocument(viewer, {
      docType: "industry_permit",
      permitType: "food_business",
      fileId: file.id,
    });
    const fields = {
      operatorName: "食品经营者",
      certNo: "JY12345678901234",
      premises: "测试经营场所",
      businessItems: "热食制售",
      validTo: "2026-01-20",
    };
    const updated = await h.profile.updateDocument(viewer, created.doc.qualificationDocId, {
      lockVersion: created.lockVersion,
      fields,
    });
    expect(updated.doc.expiryState).toBe("expiring");
    expect(updated.doc.displayFields).toEqual([
      { key: "premises", label: "经营场所", value: fields.premises },
      { key: "businessItems", label: "经营项目", value: fields.businessItems },
    ]);
    expect(JSON.stringify(updated)).not.toContain(fields.certNo);
    await h.prisma.paramValue.create({
      data: {
        id: uuidv7(),
        key: "remind.cert_expiry.days",
        value: 5,
        effectiveAt: h.clock.now(),
        createdByStaffId: uuidv7(),
        createdAt: h.clock.now(),
      },
    });
    expect((await h.profile.qualification(viewer)).openRound!.docs[0]!.expiryState).toBe("none");
    h.clock.set(new Date("2026-01-20T16:00:00Z")); // 北京已到21日：20日到期证照应过期。
    expect((await h.profile.qualification(viewer)).openRound!.docs[0]!.expiryState).toBe("expired");
  });
});
