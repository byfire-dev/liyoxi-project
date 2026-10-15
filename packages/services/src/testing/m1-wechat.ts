// Owned mixed-run external IO: asynchronous fake acceptance, then the real encrypted inbox/event path.
import { createCipheriv, createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@liyoxi/db";
import { createIdentityContext } from "../kernel/index.js";
import type { Clock, Env } from "../kernel/index.js";
import { ok } from "../providers/types.js";
import type { WechatProvider } from "../providers/types.js";
import type { Webhooks } from "../security/index.js";

const key = Buffer.alloc(32, 0x29);
export const M1_LOCAL_WECHAT: NonNullable<Env["WECHAT"]> = {
  appid: "wxlyxm1demo000001",
  secret: "fake-mixed-only",
  messageToken: "fake-mixed-token",
  messageEncodingAESKey: key.toString("base64").slice(0, -1),
};
const sha1 = (...values: string[]) =>
  createHash("sha1").update(values.sort().join("")).digest("hex");

export function createM1WechatCallbackIo(input: {
  readonly db: Pick<PrismaClient, "mediaJob">;
  readonly clock: Clock;
  readonly provider: WechatProvider;
  readonly assertOwned: () => Promise<void>;
}) {
  const pending = new Set<string>();
  let pumping = false;
  return {
    close() {
      pending.clear();
    },
    provider: {
      ...input.provider,
      async checkImage(request) {
        const result = await input.provider.checkImage(request);
        if (!result.ok) return result;
        if (pending.size >= 128) throw new Error("M1 微信替身回调积压超界");
        const traceId = randomUUID();
        pending.add(traceId);
        return ok({ verdict: "pending", traceId });
      },
    } satisfies WechatProvider,
    async pump(webhooks: Webhooks) {
      if (pumping) return;
      pumping = true;
      try {
        await input.assertOwned();
        for (const traceId of [...pending].slice(0, 32)) {
          // External acceptance is not a callback until the real submitted trace is durable.
          const job = await input.db.mediaJob.findFirst({
            where: { kind: "audit_image_wx", externalJobId: traceId, state: "submitted" },
            select: { id: true },
          });
          if (!job) continue;
          const plain = Buffer.from(
            JSON.stringify({
              MsgType: "event",
              Event: "wxa_media_check",
              trace_id: traceId,
              errcode: 0,
              result: { suggest: "pass", label: 100 },
            }),
          );
          const length = Buffer.alloc(4);
          length.writeUInt32BE(plain.length);
          const raw = Buffer.concat([
            Buffer.alloc(16, 0x17),
            length,
            plain,
            Buffer.from(M1_LOCAL_WECHAT.appid),
          ]);
          const pad = 32 - (raw.length % 32);
          const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
          cipher.setAutoPadding(false);
          const encrypted = Buffer.concat([
            cipher.update(Buffer.concat([raw, Buffer.alloc(pad, pad)])),
            cipher.final(),
          ]).toString("base64");
          const timestamp = String(Math.floor(input.clock.now().getTime() / 1000));
          const nonce = randomUUID();
          const receipt = await webhooks.prepare("wechat", {
            method: "POST",
            operationId: "hooks.wechat.message.receive",
            headers: { "content-type": "application/json" },
            rawBody: Buffer.from(
              JSON.stringify({ ToUserName: "gh_mixed_fake", Encrypt: encrypted }),
            ),
            query: {
              timestamp,
              nonce,
              encrypt_type: "aes",
              signature: sha1(M1_LOCAL_WECHAT.messageToken, timestamp, nonce),
              msg_signature: sha1(M1_LOCAL_WECHAT.messageToken, timestamp, nonce, encrypted),
            },
          });
          if (receipt.kind !== "ready") throw new Error("M1 微信替身回调验签未受理");
          const reply = await webhooks.accept(
            receipt,
            createIdentityContext({ actor: { type: "system", job: "m1.fake_wechat_callback" } }),
          );
          if (reply.status !== 200) throw new Error("M1 微信替身回调入箱未受理");
          pending.delete(traceId);
        }
      } finally {
        pumping = false;
      }
    },
  };
}
