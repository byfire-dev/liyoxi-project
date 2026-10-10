import type { BoundMediaDeps } from "../context.js";
import type { MediaAssetsDeps } from "./types.js";
export type AssetDeps = BoundMediaDeps & { readonly assets: MediaAssetsDeps };
