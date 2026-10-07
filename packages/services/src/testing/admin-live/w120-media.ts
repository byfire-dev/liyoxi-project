import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRuntime } from "../../runtime.js";
import type { Runtime } from "../../runtime.js";
import { uuidv7 } from "../../kernel/index.js";
import type { MediaActor } from "../../media/index.js";

// 本文件只用于本轮后台 live 夹具；这一固定 MP4 经本机 ffprobe 测量，未声称在线探测。
const videoBase64 =
  "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uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuvAAAJBVBmiAyvXvrX1r619a+tfWvrX1r619a+tfWvrX1r619a+tfWvrX1r619a+tfWvrX1r619a+tfWvrX1r619a+tfWvrX1r619a+tfWvrX1r619a+tfWvrX1r619a+tfWvrX1r619a+tfWvrX1r619a+tfWvrWLxX2I8R4jxHiPEeI8R4jxHiPEeI8R4jxHiPEeI8R4jxHiPEeI8R4jxHiPEeI8R4jxHiPEeI8R4jxHiPEeI8R4jxHiPEeI8R4jxHiPEeI8R4jxHiPEeI8R4jxHiPEeI8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8/n8AAAAKQZpANr16AB/ggAAAAAhBmmA2gAP8MAAAAAhBmoA2gAP8MAAAAAhBmqA2gAP8MAAAAAhBmsA2gAP8MAAAAAhBmuA2gAP8MAAAAAhBmwA2gAP8MAAAAAhBmyA2gAP8MAAAAAhBm0A2gAP8MAAAAAhBm2A2gAP8MAAAAAhBm4A2gAP8MAAAAAhBm6A2gAP8MAAAAAhBm8A2gAP8MAAAAAhBm+A2gAP8MAAAAAhBmgA2gAP8MAAAAAhBmiA2gAP8MAAAAAhBmkA2gAP8MAAAAAhBmmA2gAP8MAAAAAhBmoA2gAP8MAAAAAhBmqA2gAP8MAAAAAhBmsA2gAP8MAAAAAhBmuA2gAP8MA==";
export const VIDEO_FACTS = {
  sha256: "201115661100985c0f01c470f60f2fba5eb36ef53721cb640e657f5727c578fb",
  sizeBytes: 17212,
  durationMs: 2000,
  width: 1080,
  height: 1920,
  codec: "h264",
} as const;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function guard(ok: unknown): asserts ok {
  if (!ok) throw new Error("W120 本轮媒体事实或归属不一致");
}
const local = (url: string, protocols: readonly string[]) => {
  const parsed = new URL(url);
  guard(
    protocols.includes(parsed.protocol) && ["127.0.0.1", "localhost"].includes(parsed.hostname),
  );
  return parsed;
};
export function createW120Media(ctx: Runtime) {
  const db = local(ctx.env.DATABASE_URL, ["postgres:", "postgresql:"]),
    redis = local(ctx.env.REDIS_URL, ["redis:"]);
  const runId = /^\/lyx_test_admin_live_([a-z0-9]{1,32})$/.exec(db.pathname)?.[1];
  guard(ctx.env.APP_ENV === "test" && runId && db.port === "5442" && redis.port === "6389");
  const real = createRuntime({
    entry: "api",
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      DATABASE_URL: db.toString(),
      REDIS_URL: redis.toString(),
    },
    version: "w120-local-media",
    clock: ctx.clock,
    redisKeyPrefix: `lyx:test:admin_live_${runId}:`,
  });
  const bytes = Buffer.from(videoBase64, "base64"),
    owned = new Map<
      string,
      {
        token: string;
        actor: MediaActor;
        category: "sample_video" | "final_episode";
        storeId: string;
        itemId: string;
        episodeNo: number;
        createdAt: Date;
        incomingKey: string;
      }
    >();
  guard(
    bytes.length === VIDEO_FACTS.sizeBytes &&
      digest(bytes) === VIDEO_FACTS.sha256 &&
      real.providers.storage.status === "local",
  );
  async function facts(fileId: string) {
    const scope = owned.get(fileId);
    guard(scope);
    const result = await real.tx.run(async (tx) => ({
      file: await tx.fileObject.findUniqueOrThrow({ where: { id: fileId } }),
      production: await tx.productionRecord.findUniqueOrThrow({ where: { fileId } }),
      jobs: await tx.mediaJob.findMany({ where: { subjectId: fileId, kind: "promote" } }),
      item: await tx.orderItem.findUniqueOrThrow({ where: { id: scope.itemId } }),
    }));
    const { file, production, item } = result;
    guard(
      file.storeId === scope.storeId &&
        file.entityId === item.entityId &&
        file.scopeType === "store" &&
        file.category === scope.category &&
        file.clientToken === scope.token &&
        file.uploadActorType === "staff" &&
        file.uploadActorId === scope.actor.identity.actor.id &&
        file.uploadClient === "admin" &&
        file.createdAt >= scope.createdAt &&
        file.declaredSize === BigInt(bytes.length) &&
        file.declaredMime === "video/mp4" &&
        production.orderItemId === scope.itemId &&
        production.episodeNo === scope.episodeNo &&
        production.kind === (scope.category === "sample_video" ? "sample" : "final") &&
        production.source === "manual_upload" &&
        production.uploadedByStaffId === file.uploadActorId &&
        result.jobs.length === 1 &&
        result.jobs[0]?.dedupeKey === `promote:${fileId}`,
    );
    return { ...result, scope };
  }
  async function physical(fileId: string) {
    const current = await facts(fileId);
    guard(
      current.file.status === "stored" &&
        current.file.sizeBytes === BigInt(bytes.length) &&
        current.file.mime === "video/mp4",
    );
    const signed = await real.media.signRead({ fileId, audience: "staff" });
    const url = local(signed.url, ["http:"]);
    guard(
      url.origin === "http://127.0.0.1:9100" &&
        url.pathname === `/lyx-local-media/${current.file.objectKey}`,
    );
    const response = await fetch(url);
    if (!response.ok || !response.headers.get("content-type")?.startsWith("video/mp4"))
      throw new Error(
        `W120 physical HTTP ${response.status} ${response.headers.get("content-type")}`,
      );
    const body = new Uint8Array(await response.arrayBuffer());
    guard(body.length === bytes.length && digest(body) === VIDEO_FACTS.sha256);
    return current;
  }
  return {
    runtime: real,
    async upload(
      actor: MediaActor,
      storeId: string,
      itemId: string,
      category: "sample_video" | "final_episode",
      episodeNo: number,
    ) {
      const token = `w120_${runId}_${uuidv7().slice(-12)}`,
        createdAt = ctx.clock.now();
      const registration = await real.media.register(actor, {
        category,
        storeId,
        production: {
          kind: category === "sample_video" ? "sample" : "final",
          orderItemId: itemId,
          episodeNo,
          aiUsage: { used: false, tools: [] },
        },
        files: [
          {
            fileName: `W120_第${episodeNo}集.mp4`,
            sizeBytes: String(bytes.length),
            clientToken: token,
          },
        ],
      });
      const entry = registration.items[0];
      guard(registration.items.length === 1 && entry?.post && entry.clientToken === token);
      const url = local(entry.post.url, ["http:"]);
      guard(
        url.origin === "http://127.0.0.1:9100" &&
          url.pathname === "/lyx-local-media" &&
          entry.post.fields.key === entry.key &&
          entry.key.startsWith("incoming/"),
      );
      owned.set(entry.fileId, {
        token,
        actor,
        category,
        storeId,
        itemId,
        episodeNo,
        createdAt,
        incomingKey: entry.key,
      });
      const form = new FormData();
      for (const [key, value] of Object.entries(entry.post.fields)) form.append(key, value);
      form.append("file", new Blob([bytes], { type: "video/mp4" }), `W120_第${episodeNo}集.mp4`);
      const response = await fetch(url, { method: "POST", body: form });
      guard(response.ok);
      await real.media.completeAdmin(actor, entry.fileId);
      const current = await facts(entry.fileId);
      guard(current.file.status === "promoting" && current.jobs[0]?.state === "queued");
      await real.media.promote({ jobId: current.jobs[0].id });
      await physical(entry.fileId);
      return entry.fileId;
    },
    async knownFacts(fileId: string) {
      const current = await physical(fileId);
      guard(
        current.jobs[0]?.state === "succeeded" &&
          ["uploading", "ready"].includes(current.production.pipelineState),
      );
      await real.tx.run(async (tx) => {
        guard(!(await tx.mediaInfo.findUnique({ where: { fileId } })));
        const now = ctx.clock.now();
        await tx.mediaInfo.create({
          data: {
            fileId,
            kind: "video",
            durationMs: VIDEO_FACTS.durationMs,
            width: VIDEO_FACTS.width,
            height: VIDEO_FACTS.height,
            probeVersion: 1,
            raw: {
              fixture:
                "W120 fixed physical MP4 measured once by local ffprobe; online probe remains M3",
              runId,
              sha256: VIDEO_FACTS.sha256,
              sizeBytes: bytes.length,
              codec: VIDEO_FACTS.codec,
            },
            probedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        });
      });
    },
    ids: () => [...owned.keys()],
    runId,
    async cleanup() {
      for (const fileId of owned.keys()) {
        const { file, scope } = await facts(fileId);
        for (const ref of [
          { bucket: file.bucket, key: file.objectKey },
          { bucket: file.incomingBucket, key: scope.incomingKey },
        ]) {
          guard(ref.bucket === "media");
          const removed = await real.providers.storage.delete({ bucket: "media", key: ref.key });
          guard(removed.ok);
        }
      }
    },
    close: () => real.close(),
  };
}

/** 验收进程结束前只清本文件登记的四个真实对象；先完整核对再发生物理删除。 */
async function cleanupRun(runId: string, ids: string[]) {
  guard(
    /^[a-z0-9]{16}$/.test(runId) &&
      ids.length === 2 &&
      new Set(ids).size === 2 &&
      ids.every((id) => /^[0-9a-f-]{36}$/.test(id)),
  );
  const runtime = createRuntime({
    entry: "api",
    version: "w120-local-cleanup",
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      DATABASE_URL: `postgresql://liyoxi:lyx-local-dev@127.0.0.1:5442/lyx_test_admin_live_${runId}`,
      REDIS_URL: "redis://127.0.0.1:6389",
    },
    redisKeyPrefix: `lyx:test:admin_live_${runId}:`,
  });
  try {
    guard(runtime.providers.storage.status === "local");
    const refs: string[] = [];
    for (const id of ids) {
      const { file, info, production, item, jobs } = await runtime.tx.run(async (tx) => {
        const file = await tx.fileObject.findUniqueOrThrow({ where: { id } });
        const production = await tx.productionRecord.findUniqueOrThrow({ where: { fileId: id } });
        guard(production.orderItemId);
        return {
          file,
          production,
          info: await tx.mediaInfo.findUniqueOrThrow({ where: { fileId: id } }),
          item: await tx.orderItem.findUniqueOrThrow({ where: { id: production.orderItemId } }),
          jobs: await tx.mediaJob.findMany({ where: { subjectId: id, kind: "promote" } }),
        };
      });
      const raw = info.raw as { runId?: string; sha256?: string; sizeBytes?: number };
      guard(
        raw.runId === runId &&
          raw.sha256 === VIDEO_FACTS.sha256 &&
          raw.sizeBytes === VIDEO_FACTS.sizeBytes &&
          file.clientToken?.startsWith(`w120_${runId}_`) &&
          file.scopeType === "store" &&
          file.entityId === item.entityId &&
          file.storeId === item.storeId &&
          file.uploadActorType === "staff" &&
          file.uploadActorId === production.uploadedByStaffId &&
          file.uploadClient === "admin" &&
          file.bucket === "media" &&
          file.incomingBucket === "media" &&
          file.status === "stored" &&
          file.sizeBytes === BigInt(VIDEO_FACTS.sizeBytes) &&
          file.mime === "video/mp4" &&
          ["sample_video", "final_episode"].includes(file.category) &&
          production.source === "manual_upload" &&
          production.kind === (file.category === "sample_video" ? "sample" : "final") &&
          jobs.length === 1 &&
          jobs[0]?.state === "succeeded" &&
          jobs[0].dedupeKey === `promote:${id}` &&
          info.durationMs === VIDEO_FACTS.durationMs &&
          info.width === VIDEO_FACTS.width &&
          info.height === VIDEO_FACTS.height,
      );
      const token = file.objectKey.split("/").at(-1);
      guard(
        token &&
          /^[0-9a-f-]{36}\.mp4$/.test(token) &&
          file.objectKey === `${file.category}/${file.storeId}/${token}`,
      );
      const signed = await runtime.media.signRead({ fileId: id, audience: "staff" });
      const url = local(signed.url, ["http:"]);
      guard(
        url.origin === "http://127.0.0.1:9100" &&
          url.pathname === `/lyx-local-media/${file.objectKey}`,
      );
      const response = await fetch(url);
      guard(
        response.ok && digest(new Uint8Array(await response.arrayBuffer())) === VIDEO_FACTS.sha256,
      );
      refs.push(file.objectKey, `incoming/${id}/${token}`);
    }
    guard(new Set(refs).size === 4);
    for (const key of refs)
      guard((await runtime.providers.storage.delete({ bucket: "media", key })).ok);
    process.stdout.write("W120 本链两个正式对象及两个 incoming 对象已清理\n");
  } finally {
    await runtime.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, runId, ...ids] = process.argv.slice(2);
  guard(mode === "--cleanup-run" && runId);
  await cleanupRun(runId, ids);
}
