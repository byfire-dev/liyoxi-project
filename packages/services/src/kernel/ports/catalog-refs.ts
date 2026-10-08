import { definePort } from "../assembly/index.js";
import type { Assembly } from "../assembly/index.js";
import type { Tx } from "../tx.js";
export interface CatalogRef {
  readonly id: string;
  readonly title: string;
  readonly genreCodes: readonly string[];
  readonly isListed: boolean;
  readonly isOrderable: boolean;
}
/** L0配置只通过此只读口向内容拥有者求当前事实；不以未配置的空计数假装覆盖。 */
export interface CatalogRefs {
  areListed(tx: Tx, ids: readonly string[], at: Date): Promise<ReadonlyMap<string, boolean>>;
  read(tx: Tx, at: Date, ids?: readonly string[]): Promise<readonly CatalogRef[]>;
}
export const catalogRefPort = definePort<CatalogRefs>("catalog.refs");
export const catalogRefsOf = (assembly: Pick<Assembly, "port">): CatalogRefs =>
  assembly.port(catalogRefPort);
