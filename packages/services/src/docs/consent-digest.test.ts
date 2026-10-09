// True append-only evidence rows; only the external private object store is fictional.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dayRange } from "@liyoxi/shared/time";
import { createDocsAdminFixture, useSeededDatabase } from "../testing/index.js";
import type { Alerts } from "../kernel/index.js";
import { canonicalEvidence, calculateConsentDigest, runConsentDigest } from "./consent-digest.js";
import type { ConsentDigest, ConsentDigestDeps } from "./consent-digest.js";

const db = useSeededDatabase("services");
let h: ReturnType<typeof createDocsAdminFixture>;
let versionId: string;
const key = (day: string) => ({bucket: "secure" as const, key: `evidence/consents/${day}.json`});
const scheduled = (day: string) => new Date(dayRange(day).end.getTime() + 40 * 60000);
function dependencies() {
  const calls: Parameters<Alerts["raise"]>[0][] = [];
  const deps: ConsentDigestDeps = {tx: h.tx, storage: h.providers.storage, alerts: {async raise(input) {calls.push(input);}}};
  return {deps, calls};
}
async function sign(at: Date, extra: Parameters<typeof h.make.agreementConsent>[0] = {}) {
  return h.make.agreementConsent({agreementKey: "user", agreementVersionId: versionId, scene: "reconsent", consentedAt: at, ...extra});
}
beforeAll(async () => {
  h = createDocsAdminFixture(await db.prisma());
  versionId = (await h.make.agreementVersion({agreementKey: "user", effectiveAt: new Date("2020-01-01T00:00:00.000Z")})).id;
});
afterAll(async () => {await h?.close();});

describe("同意证据日摘要真实DB/私有存储", () => {
  it("规范化包含所有类型/键，字节/时间/bigint与普通字符串不碰撞", () => {
    expect(canonicalEvidence({z: 1, a: {n: 2, b: 3}})).toBe(canonicalEvidence({a: {b: 3, n: 2}, z: 1}));
    expect(canonicalEvidence(1n)).not.toBe(canonicalEvidence("1"));
    expect(canonicalEvidence(new Uint8Array([1, 2]))).not.toBe(canonicalEvidence("0102"));
    expect(canonicalEvidence(new Date("2020-01-01T00:00:00Z"))).not.toBe(canonicalEvidence("2020-01-01T00:00:00.000Z"));
  });
  it("前一BJT自然日双端边界、100条真实证据按seq且包含所有列", async () => {
    const day = "2026-10-01", range = dayRange(day);
    await sign(new Date(range.start.getTime() - 1));
    const first = await sign(range.start, {userAgent: "fictional-user-agent", deviceSnapshot: {model: "Fictional"}});
    for (let i = 1; i < 99; i += 1) await sign(new Date(range.start.getTime() + i));
    const last = await sign(new Date(range.end.getTime() - 1));
    await sign(range.end);
    const actual = await h.tx.run(tx => calculateConsentDigest(tx, day));
    const rows = await h.prisma.agreementConsent.findMany({where: {consentedAt: {gte: range.start, lt: range.end}}, orderBy: {seq: "asc"}});
    const hash = createHash("sha256");
    for (const row of rows) hash.update(canonicalEvidence(row) + "\n");
    expect(actual).toEqual({v: 1, day, rows: 100, firstSeq: String(first.seq), lastSeq: String(last.seq), sha256: hash.digest("hex")});
    const {deps, calls} = dependencies();
    const result = await runConsentDigest(deps, scheduled(day));
    expect(result).toMatchObject({day, rows: 100, sha256: actual.sha256, created: true});
    const stored = h.providers.storage.objects.get(`secure/${key(day).key}`)!;
    expect(JSON.parse(Buffer.from(stored.body).toString())).toEqual(actual);
    expect(Buffer.from(stored.body).toString()).not.toMatch(/fictional-user-agent|phone|openid|device|requestId/);
    expect(calls).toEqual([]);
  });
  it("同日重复不覆盖，次日真实重算前一摘要；存储采用IfAbsent和内容身份", async () => {
    const day = "2026-10-02";
    const {deps, calls} = dependencies();
    const before = h.providers.storage.callsOf("putObject").length;
    const first = await runConsentDigest(deps, scheduled(day));
    const second = await runConsentDigest(deps, scheduled(day));
    expect(first).toMatchObject({created: true, verifiedPrevious: true});
    expect(second).toEqual({...first, created: false});
    expect(h.providers.storage.callsOf("putObject")).toHaveLength(before + 1);
    const put = h.providers.storage.callsOf("putObject").at(-1)!;
    expect(put.input).toMatchObject({bucket: "secure", key: key(day).key, ifAbsent: true, contentIdentity: first.sha256});
    expect(calls).toEqual([]);
  });
  it("真实摘要对象篡改只发P1并失败，不覆盖、不额外伪报P2", async () => {
    const day = "2026-10-03", {deps, calls} = dependencies();
    await runConsentDigest(deps, scheduled(day));
    const original = h.providers.storage.objects.get(`secure/${key(day).key}`)!;
    const saved = JSON.parse(Buffer.from(original.body).toString()) as ConsentDigest;
    h.providers.storage.put(key(day), Buffer.from(JSON.stringify({...saved, sha256: "0".repeat(64)})), "application/json");
    const before = h.providers.storage.callsOf("putObject").length;
    await expect(runConsentDigest(deps, scheduled(day))).rejects.toMatchObject({error: "FILE_NOT_AVAILABLE"});
    expect(calls.map(c => [c.rule, c.severity])).toEqual([["evidence.consent_digest_mismatch", "P1"]]);
    expect(h.providers.storage.callsOf("putObject")).toHaveLength(before);
    expect(JSON.stringify(calls)).not.toMatch(/phone|openid|device|requestId/);
    // Restore external fixture only; append-only DB evidence is never changed.
    h.providers.storage.put(key(day), original.body, original.mime);
  });
  it("坏JSON、超限对象及Provider写失败均受控P2，不在错误或告警留原文", async () => {
    const day = "2026-10-04", {deps, calls} = dependencies();
    h.providers.storage.put(key(day), Buffer.from('{"phone":"never-log-this"'), "application/json");
    await expect(runConsentDigest(deps, scheduled(day))).rejects.toMatchObject({error: "FILE_NOT_AVAILABLE"});
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({rule: "evidence.consent_digest_unavailable", severity: "P2", detail: {day}});
    expect(JSON.stringify(calls)).not.toContain("never-log-this");
    h.providers.storage.put(key(day), Buffer.alloc(4097), "application/json");
    const reads = h.providers.storage.callsOf("readObject").length;
    await expect(runConsentDigest(deps, scheduled(day))).rejects.toMatchObject({error: "FILE_NOT_AVAILABLE"});
    expect(h.providers.storage.callsOf("readObject")).toHaveLength(reads + 1); // prior day only; oversize day is not read
    h.providers.storage.objects.delete(`secure/${key(day).key}`);
    h.providers.storage.failNext("putObject", {reason: "unavailable"});
    await expect(runConsentDigest(deps, scheduled(day))).rejects.toMatchObject({error: "FILE_NOT_AVAILABLE"});
    expect(h.providers.storage.objects.has(`secure/${key(day).key}`)).toBe(false);
  });
  it("取消已在途HEAD实际等待清理，不再写入；原始取消保留且仅安全P2", async () => {
    const day = "2026-10-05", {deps, calls} = dependencies();
    const controller = new AbortController();
    let entered!: () => void, cleaned = false;
    const reached = new Promise<void>(resolve => {entered = resolve;});
    const head = vi.spyOn(h.providers.storage, "head").mockImplementation(async input => {
      entered();
      try {await new Promise<void>((_, reject) => {input.signal?.addEventListener("abort", () => reject(input.signal?.reason), {once: true});});}
      finally {cleaned = true;}
      throw new Error("unreachable");
    });
    const before = h.providers.storage.callsOf("putObject").length;
    const result = runConsentDigest(deps, scheduled(day), controller.signal);
    await reached;
    controller.abort(new Error("fictional cancellation"));
    await expect(result).rejects.toThrow("fictional cancellation");
    expect(cleaned).toBe(true);
    expect(h.providers.storage.callsOf("putObject")).toHaveLength(before);
    expect(calls.map(c => c.rule)).toEqual(["evidence.consent_digest_unavailable"]);
    head.mockRestore();
  });
}, 60_000);
