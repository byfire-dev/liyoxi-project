// A small real-domain exercise; only initial actor/invitation rows are fixture preparation.
import { randomBytes } from "node:crypto";
import { z } from "@liyoxi/contract";
import { createIdentityContext, uuidv7 } from "../kernel/index.js";
import { createEvents } from "../events/index.js";
import { createFactories } from "./data/index.js";
import type { M1Support } from "./m1-types.js";

export async function prepareM1WorkerExercise(support: M1Support) {
  support.sharedScope();
  if (support.runtime.env.APP_ENV !== "local" || !support.httpIO)
    throw new Error("M1 worker代表夹具仅接受受保护HTTP装配");
  const runtime = support.runtime,
    now = runtime.clock.now();
  const fixture = await runtime.tx.run(async (tx) => {
    const make = createFactories({
      db: tx,
      clock: { now: () => new Date(now.getTime() - 25 * 3_600_000) },
    });
    const merchant = await make.merchant();
    const invitation = await tx.invitation.create({
      data: {
        id: uuidv7(),
        entityId: merchant.entity.id,
        storeId: merchant.store.id,
        inviterMemberId: merchant.owner.id,
        role: "clerk",
        tokenHash: randomBytes(32),
        status: "pending",
        expiresAt: new Date(now.getTime() - 1000),
        clientRequestId: uuidv7(),
        createdAt: new Date(now.getTime() - 86_400_000),
        updatedAt: now,
      },
    });
    const timer = await runtime.timers.arm(tx, {
      kind: "invitation.expire",
      subject: { type: "invitation", id: invitation.id },
      key: `invitation.expire:invitation:${invitation.id}`,
      fireAt: invitation.expiresAt,
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
    });
    return { merchant, invitationId: invitation.id, timerId: timer.id };
  });
  const { merchant } = fixture;
  const actor = {
    identity: createIdentityContext({
      actor: { type: "merchant", id: merchant.user.id, client: "weapp", role: "owner" },
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
    }),
    merchant: {
      standing: "owner" as const,
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
    },
  };
  const registered = (
    await runtime.media.register(actor, {
      category: "store_asset",
      files: [
        {
          fileName: "worker-owned.mp4",
          sizeBytes: String(support.productionVideo.sizeBytes),
          clientToken: uuidv7(),
        },
      ],
    })
  ).items[0]!;
  if (
    !registered.post ||
    (await support.httpIO.upload(
      { ...registered.post, key: registered.key, expiresAt: new Date(registered.expiresAt) },
      support.productionVideo.bytes,
    )) !== 204
  )
    throw new Error("M1 worker代表视频未实际上传");
  await runtime.media.complete(actor, registered.fileId);
  return {
    fileId: registered.fileId,
    timerId: fixture.timerId,
    async read() {
      support.sharedScope();
      return runtime.tx.run(async (tx) => ({
        invitation: await tx.invitation.findUniqueOrThrow({
          where: { id: fixture.invitationId },
          select: { status: true },
        }),
        timer: await tx.timer.findUniqueOrThrow({
          where: { id: fixture.timerId },
          select: { status: true, dispatchNo: true, fireAt: true },
        }),
        file: await tx.fileObject.findUniqueOrThrow({
          where: { id: registered.fileId },
          select: { status: true, sha256: true, sizeBytes: true },
        }),
        info: await tx.mediaInfo.findUnique({
          where: { fileId: registered.fileId },
          select: { width: true, height: true, durationMs: true },
        }),
        jobs: await tx.mediaJob.findMany({
          where: { subjectId: registered.fileId },
          select: { kind: true, state: true, provider: true, attemptNo: true },
        }),
      }));
    },
    async emitUnknown() {
      const events = createEvents({
        assembly: runtime.assembly,
        tx: runtime.tx,
        clock: runtime.clock,
        testEvents: [{ name: "lyxtest.future", schema: z.strictObject({ v: z.literal(1) }) }],
      });
      await runtime.tx.run((tx) =>
        events.emit(
          tx,
          createIdentityContext({ actor: { type: "system", job: "lyxtest.future" } }),
          { type: "lyxtest.future", payload: { v: 1 } },
        ),
      );
    },
  };
}
