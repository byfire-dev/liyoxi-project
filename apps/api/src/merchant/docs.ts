// 同一运行时的商家读取与交易消费共用当前文书装配。
import type { Docs, Runtime } from "@liyoxi/services";
export const docsOf = (runtime: Runtime): Docs => runtime.docs;
