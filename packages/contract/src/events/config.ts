// config 模块发出的事件的载荷（docs/api/x01-events-jobs.md 第 3 节 site_notice.* 两行；14 分组 第 2.6 节）。
// 载荷规则见 x01 第 2.3 节 P1–P7。建立与撤回均由调用方事务中的 notices 发出。
import { IdSchema, InstantSchema } from "../common/index.js";
import { SITE_NOTICE_KIND } from "../enums/index.js";
import { zodEnum } from "../enums/zod.js";
import { z } from "../zod.js";

/** site_notice.announced：notices.announce 新建了一条公告（14:528），聚合 site_notice；不是状态迁移 */
export const siteNoticeAnnouncedPayload = z.strictObject({
  v: z.literal(1),
  siteNoticeId: IdSchema,
  kind: zodEnum(SITE_NOTICE_KIND),
  /** 被公告的变更行 */
  refId: IdSchema,
  effectiveAt: InstantSchema,
});

/** site_notice.withdrawn：真实撤回公告；只带固定业务引用，不携带正文。 */
export const siteNoticeWithdrawnPayload = z.strictObject({
  v: z.literal(1),
  siteNoticeId: IdSchema,
  kind: zodEnum(SITE_NOTICE_KIND),
  refId: IdSchema,
});

export const payloads = {
  "site_notice.announced": siteNoticeAnnouncedPayload,
  "site_notice.withdrawn": siteNoticeWithdrawnPayload,
} as const;
