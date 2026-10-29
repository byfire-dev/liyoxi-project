import { billingRefundHookHandlers } from "./billing-refund-hook.js";
import { billingInvoiceHandlers } from "./billing-invoices.js";
import { billingWechatHookHandlers } from "./billing-wechat-hooks.js";
import { billingChannelReadHandlers } from "./billing-channel-read.js";
import { billingPointPackHandlers } from "./billing-point-packs.js";
import { adminBillingPointPackHandlers } from "./admin/billing-point-packs.js";
import { adminBillingSubscriptionHandlers } from "./admin/billing-subscriptions.js";
import { adminBillingAdjustmentHandlers } from "./admin/billing-adjustments.js";
import { billingLedgerHandlers } from "./billing-ledger.js";
import { adminAgreementHandlers } from "./admin/agreements.js";
import { adminDramaHandlers } from "./admin/dramas.js";
import { adminDramaPricingHandlers } from "./admin/drama-pricing.js";
import { ciHookHandlers } from "./hooks/ci.js";
import { asrHookHandlers } from "./hooks/asr.js";
import { adminMediaJobHandlers } from "./admin/media-jobs.js";
import { analyticsEventHandlers } from "./analytics-events.js";
import { wechatHookHandlers } from "./hooks/wechat.js";
import { subscribeResultHandlers } from "./subscribe-results.js";
import { clientErrorHandlers } from "./client-errors.js";
import { adminClientErrorHandlers } from "./admin/client-errors.js";
import { adminFlowOpsHandlers } from "./admin/flow-ops.js";
import { adminDictTypeHandlers } from "./admin/dict-types.js";
import { adminDictItemHandlers } from "./admin/dict-items.js";
import { adminParamValueHandlers } from "./admin/param-values.js";
import { adminFeatureFlagHandlers } from "./admin/feature-flags.js";
import { adminChecklistTemplateHandlers } from "./admin/checklist-templates.js";
import { adminCalendarDayHandlers } from "./admin/calendar-days.js";
import { orderHandlers } from "./order.js";
import { adminOrderCancelExecuteHandlers } from "./admin/order-cancel-execute.js";
import { publishHandlers } from "./publish.js";
import { deliveryHandlers } from "./delivery.js";
import { adminDeliveryM5Handlers } from "./admin/delivery-m5.js";
import { deliveryDownloadHandlers } from "./delivery-download.js";
// 全部处理器的清单（W0-22）。各域的接口包：在本目录下建自己的文件（一条契约路由配一个 defineHandler），
// 在这里加一行展开。探活不在这里，在 ../probes.ts。
import { adminProfileHandlers } from "./admin/profile.js";
import { adminFollowUpHandlers } from "./admin/follow-ups.js";
import { adminEntityHandlers } from "./admin/entities.js";
import { adminEntityQuotaHandlers } from "./admin/entity-quota.js";
import { adminEntityCloseHandlers } from "./admin/entity-close.js";
import { adminIdentityHandlers } from "./admin/identity.js";
import { profileHandlers } from "./profile.js";
import { mallHandlers } from "./mall.js";
import { merchantFileHandlers } from "./files.js";
import { mediaAssetHandlers } from "./media-assets.js";
import { adminMediaAssetHandlers } from "./admin/media-assets.js";
import { adminFileHandlers } from "./admin/files.js";
import { adminPurgeRunHandlers } from "./admin/purge-runs.js";
import { adminUploadBatchHandlers } from "./admin/upload-batches.js";
import type { HandlerEntry } from "../routing/define.js";

import { adminApprovalHandlers } from "./admin/approvals.js";
import { adminAuthHandlers } from "./admin/auth.js";
import { adminStaffHandlers } from "./admin/staff.js";
import { adminPiiRevealHandlers } from "./admin/pii-reveals.js";
import { adminAuditLogHandlers } from "./admin/audit-logs.js";
import { adminRoleHandlers } from "./admin/roles.js";
import { agreementHandlers } from "./agreements.js";
import { merchantViewHandlers } from "./merchant-views.js";
import { sessionHandlers } from "./sessions.js";
import { agreementConsentHandlers } from "./agreement-consents.js";
import { entityHandlers } from "./entities.js";
import { storeHandlers } from "./stores.js";
import { meHandlers } from "./me.js";
import { memberHandlers } from "./members.js";
import { invitationHandlers } from "./invitations.js";
import { dictItemHandlers } from "./dict-items.js";
import { billingHandlers } from "./billing.js";
import { adminBillingHandlers } from "./admin/billing.js";
import { adminBillingCatalogHandlers } from "./admin/billing-catalog.js";
import { messageHandlers } from "./messages.js";
import { notifySettingHandlers } from "./notify-settings.js";

import { siteHandlers } from "./admin/site.js";

export const HANDLERS: readonly HandlerEntry[] = [
  ...adminAgreementHandlers,
  ...siteHandlers,
  ...ciHookHandlers,
  ...asrHookHandlers,
  ...adminMediaJobHandlers,
  ...wechatHookHandlers,
  ...analyticsEventHandlers,
  ...subscribeResultHandlers,
  ...clientErrorHandlers,
  ...adminClientErrorHandlers,
  ...adminDramaHandlers,
  ...adminDramaPricingHandlers,
  ...adminFlowOpsHandlers,
  ...orderHandlers,
  ...adminOrderCancelExecuteHandlers,
  // W1-03：协议清单与版本正文（两条公开路由）
  ...agreementHandlers,
  ...mallHandlers,
  ...merchantFileHandlers,
  ...mediaAssetHandlers,
  ...adminMediaAssetHandlers,
  ...adminFileHandlers,
  ...adminPurgeRunHandlers,
  ...adminUploadBatchHandlers,
  // W1-04：静默登录、手机号登录、退出、当前账号
  ...sessionHandlers,
  // W1-01a：后台登录、激活、再验证、当前员工、退出（九条）
  ...adminAuthHandlers,
  ...merchantViewHandlers,
  ...adminApprovalHandlers,
  ...adminDictTypeHandlers,
  ...adminDictItemHandlers,
  ...adminParamValueHandlers,
  ...adminFeatureFlagHandlers,
  ...adminChecklistTemplateHandlers,
  ...adminCalendarDayHandlers,
  ...adminStaffHandlers,
  ...adminRoleHandlers,
  ...adminAuditLogHandlers,
  ...adminPiiRevealHandlers,
  ...agreementConsentHandlers,
  ...entityHandlers,
  ...storeHandlers,
  ...meHandlers,
  ...memberHandlers,
  ...invitationHandlers,
  ...dictItemHandlers,
  ...billingChannelReadHandlers,
  ...billingPointPackHandlers,
  ...adminBillingPointPackHandlers,
  ...adminBillingSubscriptionHandlers,
  ...adminBillingAdjustmentHandlers,
  ...billingLedgerHandlers,
  ...billingWechatHookHandlers,
  ...billingRefundHookHandlers,
  ...billingHandlers,
  ...billingInvoiceHandlers,
  ...adminBillingHandlers,
  ...adminBillingCatalogHandlers,
  ...profileHandlers,
  ...publishHandlers,
  ...deliveryHandlers,
  ...adminDeliveryM5Handlers,
  ...deliveryDownloadHandlers,
  ...adminProfileHandlers,
  ...adminFollowUpHandlers,
  ...adminEntityHandlers,
  ...adminEntityQuotaHandlers,
  ...adminEntityCloseHandlers,
  ...adminIdentityHandlers,
  ...messageHandlers,
  ...notifySettingHandlers,
];
