import { createHash } from "node:crypto";
import { AppError, uuidv7 } from "../../kernel/index.js";
import type { ReconciliationDeps } from "./context.js";
import { dateValue, dayLock, ownTradeNo, sourceOf } from "./context.js";
import { BillValidationError, parseCheckedTradeBill } from "./parse.js";

/** 只接日期，不接调用方自称可信的原文。外调/归档在TX外；完整校验后才持久化行。 */
export async function importDay(deps: ReconciliationDeps, day: string, signal: AbortSignal) {
  const source = sourceOf(deps),
    key = { mchid: source.mchid, billDate: dateValue(day), billType: "trade_all" };
  const before = await deps.tx.run((tx) =>
    tx.wxBillFile.findUnique({ where: { mchid_billDate_billType: key } }),
  );
  if (before?.status === "parsed") return before;
  await deps.tx.run(async (tx) => {
    await dayLock(tx, source.mchid, day);
    const now = deps.clock.now();
    await tx.wxBillFile.upsert({
      where: { mchid_billDate_billType: key },
      create: {
        ...key,
        id: uuidv7(),
        status: "pending",
        attemptCount: 1,
        createdAt: now,
        updatedAt: now,
      },
      update: { attemptCount: { increment: 1 }, updatedAt: now },
    });
  });
  try {
    signal.throwIfAborted();
    const result = await source.provider.fetchVerifiedTradeBill({ billDate: day });
    signal.throwIfAborted();
    if (!result.ok) throw new AppError("PROVIDER_UNAVAILABLE");
    const proof = result.value;
    if (proof.billDate !== day || proof.appid !== source.appid || proof.mchid !== source.mchid)
      throw new BillValidationError("source", 0);
    if (proof.kind === "missing") {
      return await deps.tx.run(async (tx) => {
        await dayLock(tx, source.mchid, day);
        return tx.wxBillFile.update({
          where: { mchid_billDate_billType: key },
          data: { status: "pending", lastError: "NO_STATEMENT_EXIST", updatedAt: deps.clock.now() },
        });
      });
    }
    const bytes = proof.bytes;
    if (createHash("sha1").update(bytes).digest("hex") !== proof.sha1)
      throw new BillValidationError("digest", 0);
    const checked = parseCheckedTradeBill(bytes, day);
    if (before?.sha1 && before.sha1 !== proof.sha1)
      throw new BillValidationError("changed_original", 0);
    const archive = await deps.systemFiles.putSystemFile({
      category: "pay_bill",
      entityId: null,
      storeId: null,
      fileName: `${day}.csv`,
      body: bytes,
      objectKey: `billing/bills/${source.mchid}/${day}/${proof.sha1}.csv`,
    });
    signal.throwIfAborted();
    return await deps.tx.run(async (tx) => {
      await dayLock(tx, source.mchid, day);
      const current = await tx.wxBillFile.findUniqueOrThrow({
        where: { mchid_billDate_billType: key },
      });
      if (current.sha1 && current.sha1 !== proof.sha1)
        throw new BillValidationError("changed_original", 0);
      if (current.status === "parsed") return current;
      const now = deps.clock.now();
      await tx.wxBillFile.update({
        where: { id: current.id },
        data: {
          status: "downloaded",
          fileId: archive.fileId,
          sha1: proof.sha1,
          isHashVerified: true,
          downloadedAt: now,
          updatedAt: now,
        },
      });
      await deps.media.link(tx, {
        fileId: archive.fileId,
        refType: "wx_bill_file",
        refId: current.id,
        role: "main",
        entityId: null,
        storeId: null,
      });
      await tx.wxBillLine.createMany({
        data: checked.lines.map(({ applyRefundAmountFen: _apply, ...line }) => {
          const isForeign =
            line.appid !== source.appid ||
            line.mchid !== source.mchid ||
            !ownTradeNo(deps, line.outTradeNo);
          return {
            ...line,
            id: uuidv7(),
            wxBillFileId: current.id,
            billDate: key.billDate,
            isForeign,
            matchState: isForeign ? "foreign" : "unmatched",
            createdAt: now,
            updatedAt: now,
          };
        }),
        skipDuplicates: true,
      });
      return tx.wxBillFile.update({
        where: { id: current.id },
        data: {
          status: "parsed",
          lineCount: checked.lines.length,
          summary: {
            ...checked.summary,
            refundApplications: {
              v: 1,
              sha1: proof.sha1,
              amounts: Object.fromEntries(
                checked.lines
                  .filter((l) => l.lineKind === "refund")
                  .map((l) => [String(l.lineNo), l.applyRefundAmountFen]),
              ),
            },
          },
          lastError: null,
          updatedAt: now,
        },
      });
    });
  } catch (error) {
    // 错误只存安全分类，不落URL、原文或Provider message。已解析原件永不回退。
    await deps.tx.run(async (tx) => {
      await dayLock(tx, source.mchid, day);
      await tx.wxBillFile.updateMany({
        where: { ...key, status: { not: "parsed" } },
        data: {
          status: "failed",
          lastError:
            error instanceof BillValidationError
              ? `validation:${error.code}:${error.row}`
              : "download_or_archive_failed",
          updatedAt: deps.clock.now(),
        },
      });
    });
    throw error;
  }
}
