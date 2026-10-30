import { failed, ok } from "../types.js";
import type { EsignProvider } from "../types.js";
import { createPlatformCertSigner } from "./platform-cert.js";
import type { PlatformCertOptions } from "./platform-cert.js";

/** Worker composition supplies actual material capability; API must not construct this. */
export function createPlatformCertEsign(options: PlatformCertOptions) {
  const signer = createPlatformCertSigner(options);
  const provider: EsignProvider = {
    status: "platform_cert",
    configured: true,
    async seal(input) {
      const result = await signer.seal(input);
      if (result.ok) return ok(result.value);
      return failed(
        result.reason === "unconfigured"
          ? "unconfigured"
          : result.reason === "rejected"
            ? "rejected"
            : "unavailable",
        "机构证书签署未成功",
      );
    },
  };
  return { provider, close: () => signer.close() };
}
