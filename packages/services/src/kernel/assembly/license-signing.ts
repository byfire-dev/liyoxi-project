// Driver construction follows the existing kernel-only Provider composition boundary.
import { createPlatformCertEsign, createSsmMaterialSource } from "../../providers/index.js";
import type { EsignProvider } from "../../providers/types.js";
import { systemClock } from "../clock.js";
import type { Clock } from "../clock.js";
import type { Env } from "../env.js";

export function assembleLicenseSigning(input: { clock: Clock; ssm?: Env["ESIGN_SSM"] }) {
  const source = input.ssm ? createSsmMaterialSource(input.ssm, { clock: systemClock }) : null;
  const signing = source
    ? createPlatformCertEsign({ clock: input.clock, loadMaterial: source.loadMaterial })
    : null;
  const provider: EsignProvider = signing?.provider ?? {
    configured: false,
    status: "unconfigured",
    seal: async () => ({ ok: false, reason: "unconfigured", message: "授权书签署尚未配置" }),
  };
  let closing: Promise<void> | undefined;
  return {
    provider,
    close: () =>
      (closing ??= (async () => {
        const results = await Promise.allSettled([signing?.close(), source?.close()]);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      })()),
  };
}
