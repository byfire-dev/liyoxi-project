import { defineKeyedPort } from "../kernel/index.js";
import type { Clock, FileRefType } from "../kernel/index.js";
import type { FileCategoryGuard } from "./context.js";
import type { MediaAssetsDeps } from "./assets/types.js";
export type { FileCategoryGuard } from "./context.js";
export { fileRefTypePort } from "../kernel/index.js";
export type { ExpectedFileRef, FileRefType } from "../kernel/index.js";
/** 静态登记由 media 实例绑定业务时钟；不共享可变时钟或改变基础引用契约。 */
export interface ClockBoundFileRefType extends FileRefType {
  withClock(clock: Clock): FileRefType;
}
/** media本域引用绑定现有tenant只读公口；静态未绑定保守保护，不直查同层表。 */
export interface StoreBoundFileRefType extends FileRefType {
  withStoreFacts(readStore: MediaAssetsDeps["readStore"], clock: Clock): FileRefType;
}
export const fileCategoryGuardPort = defineKeyedPort<FileCategoryGuard>("media.category_guard");
