// 仅测试Provider替身：不生成数字签名，诚实返回stamp；密码学测试使用运行时生成的TEST ONLY证书。
// 要测图片章与未配置，用 providers 里的真实实现（createStampEsign、未配置实现），不用替身。

import { ok } from "../../providers/types.js";
import type { EsignProvider, ProviderMethodName } from "../../providers/types.js";
import { createFakeCore, systemClock } from "./base.js";
import type { FakeClock, FakeControl } from "./base.js";

type Method = ProviderMethodName<EsignProvider>;

export const FAKE_CERT_SERIAL = "FAKE-CERT-0001";

export interface FakeEsign extends EsignProvider, FakeControl<Method> {
  /** 签过的文件（签之前的内容），按先后 */
  readonly sealed: Uint8Array[];
}

export function createFakeEsign(options: { clock?: FakeClock } = {}): FakeEsign {
  const clock = options.clock ?? systemClock;
  const core = createFakeCore<Method>(clock);
  const sealed: Uint8Array[] = [];

  return {
    status: "fake",
    configured: true,
    ...core.control,
    sealed,

    seal: (input) =>
      core.run("seal", input, () => {
        sealed.push(new Uint8Array(input.pdf));
        return ok({
          pdf: new Uint8Array(input.pdf),
          mode: "stamp",
        });
      }),
  };
}
