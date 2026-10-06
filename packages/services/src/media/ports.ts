import { defineKeyedPort } from "../kernel/index.js";
import type { FileCategoryGuard } from "./context.js";
export type { FileCategoryGuard } from "./context.js";
export { fileRefTypePort } from "../kernel/index.js";
export type { ExpectedFileRef, FileRefType } from "../kernel/index.js";
export const fileCategoryGuardPort = defineKeyedPort<FileCategoryGuard>("media.category_guard");
