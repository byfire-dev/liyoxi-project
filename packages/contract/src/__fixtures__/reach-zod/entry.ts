// 反例：看上去是纯常量入口，实际经两层转手到了 Zod 运行时。只给契约自测的静态扫描用。
export { LEAF_NAME } from "./leaf.js";
export type { LeafSchema } from "./leaf.js";
