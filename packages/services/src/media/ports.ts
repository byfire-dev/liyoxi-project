import { defineKeyedPort } from "../kernel/index.js";
import type { Clock, FileRefType } from "../kernel/index.js";
import type { FileCategoryGuard } from "./context.js";
export type { FileCategoryGuard } from "./context.js";
export { fileRefTypePort } from "../kernel/index.js";
export type { ExpectedFileRef, FileRefType } from "../kernel/index.js";
/** 静态登记由 media 实例绑定业务时钟；不共享可变时钟或改变基础引用契约。 */
export interface ClockBoundFileRefType extends FileRefType {
  withClock(clock: Clock): FileRefType;
}
export const fileCategoryGuardPort = defineKeyedPort<FileCategoryGuard>("media.category_guard");
