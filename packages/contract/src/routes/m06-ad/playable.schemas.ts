// m06 §2.8 公共唯一结构；路由仍由后续里程碑落地。
import { z } from "../../zod.js";
import { IdSchema, InstantSchema, orNull } from "../../common/index.js";
const n = z.int().nonnegative();
export const PlayableSourceSchema = z
  .strictObject({
    quality: z.enum(["sd", "hd", "source"]),
    url: z.string(),
    width: n,
    height: n,
    bitrateKbps: orNull(n),
  })
  .openapi("PlayableSource");
export const PlayableSchema = z
  .strictObject({
    playableId: IdSchema,
    kind: z.enum(["trailer", "sample", "ad"]),
    durationMs: orNull(n),
    width: orNull(n),
    height: orNull(n),
    posterUrl: orNull(z.string()),
    sources: z.array(PlayableSourceSchema),
    expiresAt: orNull(InstantSchema),
    autoplay: z.boolean(),
    muted: z.boolean(),
  })
  .openapi("Playable");
