// Bundler 解析：相对导入不带后缀
import type { KeyValue } from "./storage";
import { toPairs } from "./storage";
import { STORE_ID_KEY } from "./keys";

export const pairs: KeyValue[] = toPairs({ [STORE_ID_KEY]: "1" });
