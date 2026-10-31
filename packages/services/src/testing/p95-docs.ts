// P95 alone snapshots queued history before admitting real PDF work. No business terminal writer.
import { setTimeout as pause } from "node:timers/promises";
import { claimDeliveries, consumeDelivery } from "../events/index.js";
import type { ClaimedDelivery } from "../events/index.js";
import { alertsOf } from "../kernel/index.js";
import { assertM1ReadyDocuments, readM1DocsBacklog } from "./m1-docs.js";
import type { M1Support } from "./m1-types.js";

export function createP95DocsTransport(support: M1Support, assertOwned: () => void) {
  const { runtime } = support;
  const startedAt = new Date(support.sharedScope().startedAt);
  const deferred: ClaimedDelivery[] = [];
  const consume = async (ref: ClaimedDelivery) => {
    assertOwned();
    const event = await runtime.tx.run((tx) =>
      tx.outboxEvent.findUniqueOrThrow({ where: { id: ref.eventId } }),
    );
    if (
      event.occurredAt < startedAt ||
      event.occurredAt > runtime.clock.now() ||
      !runtime.events.subscribers.get(ref.subscriber)
    )
      throw new Error("P95出站投递不属于本轮真实服务图");
    const result = await consumeDelivery(
      {
        tx: runtime.tx,
        subscribers: runtime.events.subscribers,
        alerts: alertsOf(runtime.assembly),
        beforeConsume: (reference, delivered) =>
          runtime.docsRender.beforeConsume(reference, delivered),
      },
      ref,
    );
    if (result !== "done")
      throw new Error(`P95实际投递 ${ref.eventType} → ${ref.subscriber}：${result}`);
  };
  async function drain(entityIds: readonly string[], stage: boolean) {
    assertOwned();
    const deadline = performance.now() + 30_000;
    let expanded = 0,
      consumed = 0;
    for (let round = 0; round < 32; round++) {
      assertOwned();
      if (performance.now() >= deadline) throw new Error("P95单店真实docs运输超过三十秒");
      expanded += (await runtime.events.expand()).events;
      const { claimed, dead } = await runtime.tx.run((tx) => claimDeliveries(tx));
      if (dead.length) throw new Error("P95真实出站投递进入死信");
      for (const ref of claimed) {
        if (stage && ref.subscriber === "docs.onRevisionQueued") {
          if (ref.eventType !== "license_letter.revision_queued")
            throw new Error("P95暂存投递不是授权首版任务");
          deferred.push(ref);
        } else {
          await consume(ref);
          consumed++;
        }
      }
      if (claimed.length) continue;
      const [unpublished, unsettled] = await runtime.tx.run((tx) =>
        Promise.all([
          tx.outboxEvent.count({ where: { publishedAt: null } }),
          tx.outboxDelivery.count({ where: { status: { not: "done" } } }),
        ]),
      );
      if (unpublished) continue;
      if (unsettled !== (stage ? deferred.length : 0))
        throw new Error("P95出站图仍有未完成或非本轮暂存投递");
      if (stage) return { expanded, consumed };
      const docs = await runtime.tx.run((tx) => readM1DocsBacklog(tx, entityIds));
      if (docs.docsFailed) throw new Error("P95真实授权版次生成失败");
      if (docs.docsPending) {
        await pause(25);
        round--;
        continue;
      }
      // Ready commits may emit after the first outbox count; prove issued only after a second read.
      if (await runtime.tx.run((tx) => tx.outboxEvent.count({ where: { publishedAt: null } })))
        continue;
      await assertM1ReadyDocuments(runtime, undefined, entityIds);
      return { expanded, consumed };
    }
    throw new Error("P95出站事件超过32轮，拒绝把未排空视为成功");
  }
  return {
    stagePrototype: (entityId: string) => drain([entityId], true),
    async completePrototype() {
      let consumed = 0;
      for (const ref of deferred.splice(0)) {
        await consume(ref);
        consumed++;
      }
      // The regular support owns consumer activation/lifetime. Only the four prototype versions
      // exist here, so its unchanged full-database proof and limits remain applicable.
      const completed = await support.drainEvents();
      return { expanded: completed.expanded, consumed: completed.consumed + consumed };
    },
    drain: (entityId: string) => drain([entityId], false),
  };
}
