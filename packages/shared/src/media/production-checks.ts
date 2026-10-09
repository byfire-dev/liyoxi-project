/** D5 §6.2：只接受技术事实与可信制作上下文，不读取数据库或 Provider。 */
export interface ProductionTechnicalFacts {
  readonly container: string | null;
  readonly videoCodec: string | null;
  readonly videoProfile: string | null;
  readonly pixelFormat: string | null;
  readonly bitDepth: number | null;
  readonly displayWidth: number | null;
  readonly displayHeight: number | null;
  readonly audioCodec: string | null;
  readonly audioStreamCount: number;
  readonly sizeBytes: number;
  readonly durationMs: number | null;
  readonly aigcVerified: boolean;
  readonly faststart: boolean;
  readonly frameRate: number | null;
  readonly variableFrameRate: boolean;
  readonly avDriftMs: number | null;
  readonly bitrateKbps: number | null;
}
export interface ProductionCheckContext {
  readonly masterId: string;
  readonly masterDurationMs: number;
  readonly masterDisplayWidth: number;
  readonly masterDisplayHeight: number;
  readonly headAdMs: number;
  readonly tailAdMs: number;
  readonly aiUsed: boolean;
  readonly masterSource: "declared" | "current_fallback";
  readonly masterIsCurrent: boolean;
}
export interface ProductionCheckOptions {
  readonly finalMaxMb: number;
  /** null 关闭 S3，其余为正式配置的毫秒值。 */
  readonly softDurationMs: number | null;
}
export interface ProductionHardCheck {
  readonly code: "H1" | "H2" | "H3" | "H4" | "H5" | "H6" | "H7";
  readonly pass: boolean;
  readonly actual: string | number;
  readonly expected: string | number;
}
export interface ProductionSoftCheck {
  readonly code: "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8" | "S9" | "S10";
  readonly level: "warn";
  readonly actual: string | number;
  readonly note: string;
}
export function checkProduction(
  facts: ProductionTechnicalFacts,
  context: ProductionCheckContext | null,
  options: ProductionCheckOptions,
): {
  readonly gate: "pass" | "reject";
  readonly hard: readonly ProductionHardCheck[];
  readonly soft: readonly ProductionSoftCheck[];
} {
  if (
    !Number.isFinite(options.finalMaxMb) ||
    options.finalMaxMb <= 0 ||
    options.finalMaxMb > 200 ||
    (options.softDurationMs !== null &&
      (!Number.isFinite(options.softDurationMs) || options.softDurationMs <= 0))
  )
    throw new RangeError("制作检查参数超出正式边界");
  const positive = (n: number | null): n is number => n !== null && Number.isFinite(n) && n > 0;
  const actual = (n: number | null): number | string =>
    n !== null && Number.isFinite(n) ? n : "unknown";
  const ctx =
    context !== null &&
    positive(context.masterDurationMs) &&
    positive(context.masterDisplayWidth) &&
    positive(context.masterDisplayHeight) &&
    Number.isFinite(context.headAdMs) &&
    context.headAdMs >= 0 &&
    Number.isFinite(context.tailAdMs) &&
    context.tailAdMs >= 0;
  const dimensions = positive(facts.displayWidth) && positive(facts.displayHeight);
  const hard: ProductionHardCheck[] = [
    {
      code: "H1",
      pass: facts.container === "mp4",
      actual: facts.container ?? "unknown",
      expected: "mp4",
    },
    {
      code: "H2",
      pass:
        facts.videoCodec === "h264" &&
        ["High", "Main"].includes(facts.videoProfile ?? "") &&
        facts.pixelFormat === "yuv420p" &&
        facts.bitDepth === 8,
      actual: `${facts.videoCodec ?? "unknown"}/${facts.videoProfile ?? "unknown"}/${facts.pixelFormat ?? "unknown"}/${actual(facts.bitDepth)}`,
      expected: "h264/Main|High/yuv420p/8",
    },
    {
      code: "H3",
      pass:
        ctx &&
        dimensions &&
        Math.abs(facts.displayWidth! / facts.displayHeight! / (9 / 16) - 1) <= 0.01 &&
        facts.displayWidth! >= 720 &&
        facts.displayWidth! >= Math.min(1080, context!.masterDisplayWidth),
      actual: `${actual(facts.displayWidth)}x${actual(facts.displayHeight)}`,
      expected: ctx
        ? `9:16±1%,width>=${Math.max(720, Math.min(1080, context!.masterDisplayWidth))}`
        : "master context required",
    },
    {
      code: "H4",
      pass: facts.audioCodec === "aac" && facts.audioStreamCount === 1,
      actual: `${facts.audioCodec ?? "unknown"}/${facts.audioStreamCount}`,
      expected: "aac/1",
    },
    {
      code: "H5",
      pass:
        Number.isSafeInteger(facts.sizeBytes) &&
        facts.sizeBytes > 0 &&
        facts.sizeBytes <= options.finalMaxMb * 1024 * 1024,
      actual: actual(facts.sizeBytes),
      expected: options.finalMaxMb * 1024 * 1024,
    },
    {
      code: "H6",
      pass:
        positive(facts.durationMs) && facts.durationMs >= 20_000 && facts.durationMs < 1_200_000,
      actual: actual(facts.durationMs),
      expected: "20000<=durationMs<1200000",
    },
    {
      code: "H7",
      pass: context !== null && (!context.aiUsed || facts.aigcVerified),
      actual: facts.aigcVerified ? "verified" : "unverified",
      expected: "AI used => verified",
    },
  ];
  const soft: ProductionSoftCheck[] = [];
  const warn = (code: ProductionSoftCheck["code"], value: string | number, note: string) =>
    soft.push({ code, level: "warn", actual: value, note });
  if (facts.sizeBytes > 100 * 1024 * 1024) warn("S1", facts.sizeBytes, "文件大于100MiB");
  if (ctx && positive(facts.durationMs)) {
    const difference = Math.abs(
      facts.durationMs - (context!.masterDurationMs + context!.headAdMs + context!.tailAdMs),
    );
    if (difference > 1500) warn("S2", difference, "与原片及片头片尾广告总长偏差大于1500ms");
  }
  if (
    options.softDurationMs !== null &&
    positive(facts.durationMs) &&
    facts.durationMs > options.softDurationMs
  )
    warn("S3", facts.durationMs, "超过配置的软时长");
  if (!facts.faststart) warn("S4", "false", "moov不在mdat之前");
  if (facts.variableFrameRate || ![25, 30].includes(facts.frameRate ?? 0))
    warn("S5", actual(facts.frameRate), "可变帧率或不是25/30fps");
  if (
    facts.avDriftMs !== null &&
    Number.isFinite(facts.avDriftMs) &&
    Math.abs(facts.avDriftMs) > 80
  )
    warn("S6", facts.avDriftMs, "音画偏移大于80ms");
  if (facts.bitrateKbps !== null && Number.isFinite(facts.bitrateKbps) && facts.bitrateKbps > 8000)
    warn("S7", facts.bitrateKbps, "码率大于8Mbps");
  if (positive(facts.displayWidth) && facts.displayWidth < 1080)
    warn("S8", facts.displayWidth, "显示宽度不足1080");
  if (context?.masterSource === "current_fallback")
    warn("S9", "current_fallback", "未声明原片而使用当前版本兜底");
  if (context && !context.masterIsCurrent) warn("S10", context.masterId, "所用原片已非当前版本");
  return { gate: hard.every((item) => item.pass) ? "pass" : "reject", hard, soft };
}
export function sampleWatermark(storeName: string, now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new RangeError("水印日期不合格");
  const name = [...storeName.replace(/[\p{Cc}\p{Cf}\s<>"'\\`/「」]/gu, "")].slice(0, 10).join("");
  if (!name) throw new RangeError("门店简称清洗后为空");
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const date = `${String(beijing.getUTCMonth() + 1).padStart(2, "0")}-${String(beijing.getUTCDate()).padStart(2, "0")}`;
  return `样片 · 仅供「${name}」确认 · ${date}`;
}
