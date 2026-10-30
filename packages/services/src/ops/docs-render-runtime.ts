import { createHash, randomUUID } from "node:crypto";
import { AppError, guardProviderCall, assembleLicenseSigning } from "../kernel/index.js";
import type { Clock, DeliveredEvent, Env, QueueChannel, TxRunner } from "../kernel/index.js";
import type { DeliveryRef } from "../events/index.js";
import {
  claimLicenseRevision,
  completeLicenseRevision,
  failLicenseRevision,
  readQueuedLicenseRevision,
  createLicensePdfRenderer,
} from "../docs/index.js";
import type {
  LicenseConvergenceDeps,
  LicensePdfRenderer,
  LicenseRenderQueueDeps,
} from "../docs/index.js";
import { latestLicenseRenderClaimLease } from "../audit/index.js";
import { readMaterialFileFacts } from "../media/index.js";
import type { Media } from "../media/index.js";
import type { EsignProvider, ProviderLogger } from "../providers/types.js";

export interface LicenseRenderingEngine {
  readonly renderer: LicensePdfRenderer;
  readonly signer: EsignProvider;
  close(): Promise<void>;
}

/** Called only by worker composition. API does not construct credential readers or signers. */
export function createLicenseRenderingEngine(input: {
  appEnv: Env["APP_ENV"];
  clock: Clock;
  fontDir?: string;
  ssm?: Env["ESIGN_SSM"];
  override?: LicenseRenderingEngine;
}): LicenseRenderingEngine {
  if (input.override) {
    if (!["local", "test"].includes(input.appEnv))
      throw new TypeError("授权书测试渲染能力只允许本地或测试环境");
    return input.override;
  }
  const renderer = createLicensePdfRenderer({ fontDir: input.fontDir });
  const signing = assembleLicenseSigning({ clock: input.clock, ssm: input.ssm });
  let closing: Promise<void> | undefined;
  return {
    renderer,
    signer: signing.provider,
    close: () =>
      (closing ??= (async () => {
        const result = await Promise.allSettled([renderer.close(), signing.close()]);
        const failure = result.find((row) => row.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      })()),
  };
}

/** One runtime owns its admissions and all actual IO; shutdown drains before dependency disposal. */
export function createDocsRenderRuntime(deps: {
  tx: TxRunner;
  clock: Clock;
  convergence: LicenseConvergenceDeps;
  media: Media;
  channel: Pick<QueueChannel, "enqueue">;
  engine?: LicenseRenderingEngine;
  logger?: ProviderLogger;
  allowStamp?: boolean;
}) {
  let paused = false,
    closed = false,
    warned = false;
  let lifetime = new AbortController();
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const queue: LicenseRenderQueueDeps = {
    ...deps.convergence,
    readLastClaimLease: latestLicenseRenderClaimLease,
    files: {
      async assertAndLink(tx, input) {
        await deps.media.link(tx, {
          fileId: input.fileId,
          refType: "license_letter_revision",
          refId: input.revisionId,
          role: "pdf",
          entityId: input.entityId,
          storeId: input.storeId,
        });
        const [file] = await readMaterialFileFacts(tx, [input.fileId]);
        if (
          !file ||
          file.scopeType !== "entity" ||
          file.entityId !== input.entityId ||
          file.storeId !== null ||
          file.category !== "legal_doc" ||
          file.ext !== "pdf" ||
          file.sha256 !== input.sha256 ||
          file.status !== "stored" ||
          file.moderationState === "block"
        )
          throw new AppError("FILE_NOT_AVAILABLE");
      },
    },
  };
  const configured = () =>
    Boolean(
      deps.engine?.renderer.configured &&
      deps.engine.signer.configured &&
      (deps.allowStamp || deps.engine.signer.status !== "stamp"),
    );
  const track = <T>(run: () => Promise<T>): Promise<T> => {
    if (closed || paused) return Promise.reject(new TypeError("授权书任务已停止准入"));
    const promise = Promise.resolve().then(run);
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => undefined);
    return promise;
  };
  const processRevision = async (revisionId: string, signal: AbortSignal) => {
    if (!configured()) {
      if (!warned) {
        warned = true;
        deps.logger?.warn(
          { evt: "docs.render_unconfigured" },
          "授权书正文、字体或签署能力尚未配置，版次保留待生成",
        );
      }
      return;
    }
    const engine = deps.engine!;
    signal.throwIfAborted();
    const claim = await deps.tx.run((tx) => claimLicenseRevision(tx, queue, revisionId));
    if (!claim) return;
    try {
      signal.throwIfAborted();
      const rendered = await engine.renderer.render({
        snapshot: claim.snapshot,
        templateVersion: claim.templateVersion,
        contentFingerprint: claim.contentFp,
        signal,
      });
      signal.throwIfAborted();
      if (!rendered.ok) {
        await deps.tx.run((tx) =>
          failLicenseRevision(
            tx,
            queue,
            claim,
            rendered.reason === "missing_glyph" ? rendered.issue : undefined,
          ),
        );
        deps.logger?.warn({ evt: "docs.render_failed", reason: rendered.reason }, "授权书尚未生成");
        return;
      }
      guardProviderCall({ provider: "esign", method: "seal" });
      const sealed = await engine.signer.seal({ pdf: rendered.value.pdf, signal });
      signal.throwIfAborted();
      if (!sealed.ok || (sealed.value.mode === "stamp" && !deps.allowStamp)) {
        await deps.tx.run((tx) => failLicenseRevision(tx, queue, claim));
        deps.logger?.warn({ evt: "docs.sign_failed" }, "授权书签署未成功");
        return;
      }
      const value = sealed.value;
      const hash = createHash("sha256").update(value.pdf).digest("hex");
      const stored = await deps.media.putSystemFile({
        category: "legal_doc",
        entityId: claim.entityId,
        storeId: null,
        objectKey: `license/${claim.licenseLetterId}/${claim.revisionId}/${hash}.pdf`,
        fileName: `${claim.letterNo}-v${claim.revNo}.pdf`,
        body: value.pdf,
      });
      // Storage has no cancellation port: await actual completion, then discard on shutdown.
      signal.throwIfAborted();
      if (stored.sha256 !== hash) throw new AppError("FILE_NOT_AVAILABLE");
      await deps.tx.run((tx) =>
        completeLicenseRevision(tx, queue, claim, {
          fileId: stored.fileId,
          pdfSha256: hash,
          ...(value.mode === "certificate"
            ? {
                signMode: "platform_cert" as const,
                platformSignedAt: value.signedAt,
                certIssuer: value.certIssuer,
                certSerial: value.certSerial,
              }
            : { signMode: "stamp" as const, platformSignedAt: deps.clock.now() }),
        }),
      );
    } catch (error) {
      // A lost/expired claim is ignored by its durable fence; no unbounded immediate retry.
      await deps.tx.run((tx) => failLicenseRevision(tx, queue, claim));
      if (!signal.aborted) {
        deps.logger?.warn(
          { evt: "docs.render_failed", reason: "unavailable" },
          "授权书生成未完成，等待恢复重试",
        );
        throw error;
      }
    }
  };
  const enqueue = (ref: { revisionId: string }, jobId?: string) =>
    track(() =>
      deps.channel.enqueue("docs", jobId ?? `docs-${ref.revisionId}-${randomUUID()}`, ref),
    );
  return {
    queue,
    get configured() {
      return configured();
    },
    process: (ref: { revisionId: string }) => {
      const signal = lifetime.signal;
      return track(() => processRevision(ref.revisionId, signal));
    },
    enqueue,
    beforeConsume(ref: DeliveryRef, event: DeliveredEvent) {
      if (ref.subscriber !== "docs.onRevisionQueued") return Promise.resolve();
      return track(async () => {
        const queued = await deps.tx.run((tx) => readQueuedLicenseRevision(tx, event));
        if (queued)
          await deps.channel.enqueue("docs", `docs-${ref.eventId}-${ref.dispatchNo}`, {
            revisionId: queued.revisionId,
          });
      });
    },
    pause() {
      paused = true;
      lifetime.abort();
      return Promise.allSettled([...pending]).then(() => undefined);
    },
    resume() {
      if (closed) throw new TypeError("授权书运行时已关闭");
      if (paused) lifetime = new AbortController();
      paused = false;
    },
    close() {
      if (closing) return closing;
      closed = true;
      paused = true;
      lifetime.abort();
      return (closing = (async () => {
        await Promise.allSettled([...pending]);
        await deps.engine?.close();
      })());
    },
  };
}
export type DocsRenderRuntime = ReturnType<typeof createDocsRenderRuntime>;
