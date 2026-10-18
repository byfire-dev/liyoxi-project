import type { Events } from "../events/index.js";
import type { MessageItem } from "@liyoxi/contract";
import type { Params } from "../config/index.js";
import type {
  Assembly,
  Alerts,
  AppEnv,
  Clock,
  DeliveredEvent,
  RecurringRunContext,
  Tx,
  TxRunner,
} from "../kernel/index.js";
import type { Providers, ProviderLogger } from "../providers/types.js";

export interface InvoiceMailSource {
  invoiceDocId: string;
  invoiceRequestId: string;
  billingOrderId: string;
  entityId: string;
  to: string;
  toMask: string;
  targetRef: string;
  subject: string;
  text: string;
  file: { bucket: "secure"; key: string; etag: string; size: number; ext: string; mime: string };
}

export interface NotifyFact {
  bizType: string;
  bizId: string;
  entityId: string | null;
  storeId: string | null;
  status: string;
  version: number;
  name: string;
  orderId?: string;
  orderItemId?: string;
  deliveryTicketId?: string;
  excludeWechatIdentityId?: string;
  targetDate?: string;
  notifyScope?: "owner_only" | "owner_and_clerks";
  amountFen?: number;
  quantity?: number;
  balance?: number;
  occurredAt?: string;
  detail?: string;
  guardBizType?:
    | "invitation"
    | "drama_order"
    | "delivery_plan"
    | "delivery_release"
    | "channel_account"
    | "launch_task"
    | "sample"
    | "billing_order"
    | "invoice_request"
    | "store_asset"
    | "billing_account";
  guardBizId?: string;
  merchantUserIds?: string[];
  staffIds?: string[];
  summary?: string;
  summaryNoPrice?: string | null;
  link?: MessageItem["link"];
}

export interface NotificationSpec {
  sceneKey: string;
  reader: string;
  refField: string;
  category: "order" | "delivery" | "launch" | "plan_points" | "review" | "store";
  ownerOnly: boolean;
  pendingStatus?: readonly string[];
  staffLink?: (fact: NotifyFact) => { route: string; params: Record<string, string> };
  link(fact: NotifyFact): MessageItem["link"];
}

export interface NotifyTarget {
  active: boolean;
  phone?: string;
  phoneRef?: string;
  phoneMask?: string;
  wecomUserid?: string;
}

export interface NotifyDispatchDeps {
  appEnv: AppEnv;
  events?: Pick<Events, "emit">;
  invoiceMail?: (tx: Tx, id: string) => Promise<InvoiceMailSource | null>;
  tx: TxRunner;
  clock: Clock;
  assembly: Assembly;
  params: Params;
  providers: Providers;
  logger: ProviderLogger;
  alerts: Alerts;
  appid?: string;
  wxEnabled(tx: Tx, entityId: string | null): Promise<boolean>;
  smsEnabled(tx: Tx, entityId: string | null): Promise<boolean>;
  purchaseMode(
    tx: Tx,
    entityId: string,
    at: Date,
  ): Promise<"in_app" | "offline_contract" | "hidden">;
  merchantTarget(tx: Tx, userId: string): Promise<NotifyTarget | null>;
  approvalRecipients(tx: Tx, approvalId: string): Promise<string[]>;
  copyrightRecipients?(tx: Tx): Promise<string[]>;
  staffTarget(tx: Tx, staffId: string): Promise<NotifyTarget | null>;
  staffWorkAt(tx: Tx, at: Date): Promise<Date>;
  wechatTarget(tx: Tx, identityId: string, userId: string): Promise<string | null>;
  directTarget(phone: string): { phoneRef: string; phoneMask: string } | null;
}

export interface NotifyDispatcher {
  onEvent(tx: Tx, event: DeliveredEvent): Promise<number>;
  onMerchantUserDeleted(tx: Tx, event: DeliveredEvent): Promise<void>;
  deliver(ref: NotifyQueueRef): Promise<void>;
  scan(enqueue: (ref: NotifyQueueTask) => Promise<void>): Promise<number>;
  remindScan(context: RecurringRunContext): Promise<Readonly<Record<string, unknown>>>;
  close(): Promise<void>;
}

/** Internal queue references reuse the existing notify channel; no public HTTP contract changes. */
export type NotifyQueueRef = { deliveryId: string } | { fanoutId: string };
export type NotifyQueueTask =
  { deliveryId: string; attemptNo: number } | { fanoutId: string; pageKey: string };
export interface NoticeRecipient {
  id: string;
  merchantUserId: string;
  entityId: string;
}
