// 工厂的对外形状（W0-25）：一张表一个方法，(覆盖的字段?) => 插入的那一行。
// 覆盖字段的类型取 Prisma 的 …CreateManyInput：只有这张表自己的标量列，外键写 …Id。
import type {
  AgreementConsent,
  AgreementVersion,
  BillingAccount,
  BillingOrder,
  DeliveryTicket,
  Drama,
  DramaEpisode,
  DramaOrder,
  Entity,
  EntityMember,
  FileObject,
  MerchantUser,
  OrderItem,
  PaymentTxn,
  PointHold,
  Prisma,
  Staff,
  Store,
  StoreMember,
  SubscriptionTerm,
} from "@liyoxi/db";

/** 带明文手机号的写法：工厂替你做成三件套 */
interface WithPhone {
  /** 手机号明文；不给用假号。给了它就不用再给 phoneEnc 等几列 */
  phone?: string;
}

export type MerchantUserInput = Partial<Prisma.MerchantUserCreateManyInput> & WithPhone;
export type EntityInput = Partial<Prisma.EntityCreateManyInput> & {
  /** 统一社会信用代码明文；认证通过的主体不给用假号 */
  uscc?: string;
  /** 法定代表人或经营者姓名明文 */
  legalRepName?: string;
};
export type StoreInput = Partial<Prisma.StoreCreateManyInput>;
export type EntityMemberInput = Partial<Prisma.EntityMemberCreateManyInput>;
export type StoreMemberInput = Partial<Prisma.StoreMemberCreateManyInput>;
export type StaffInput = Partial<Prisma.StaffCreateManyInput> & WithPhone;
export type FileObjectInput = Partial<Prisma.FileObjectCreateManyInput>;
export type BillingAccountInput = Partial<Prisma.BillingAccountCreateManyInput>;
export type PaymentTxnInput = Partial<Prisma.PaymentTxnCreateManyInput>;
export type BillingOrderInput = Partial<Prisma.BillingOrderCreateManyInput>;
export type SubscriptionTermInput = Partial<Prisma.SubscriptionTermCreateManyInput>;
export type PointHoldInput = Partial<Prisma.PointHoldCreateManyInput>;
export type DramaInput = Partial<Prisma.DramaCreateManyInput>;
export type DramaEpisodeInput = Partial<Prisma.DramaEpisodeCreateManyInput>;
export type AgreementVersionInput = Partial<Prisma.AgreementVersionCreateManyInput>;
export type AgreementConsentInput = Partial<Prisma.AgreementConsentCreateManyInput> & WithPhone;
export type DramaOrderInput = Partial<Prisma.DramaOrderCreateManyInput>;
export type OrderItemInput = Partial<Prisma.OrderItemCreateManyInput>;
export type DeliveryTicketInput = Partial<Prisma.DeliveryTicketCreateManyInput>;

/** 一张表一个工厂。键是工厂名，值是它插的表（FACTORY_TABLES 与它一一对应） */
export interface TableFactories {
  merchantUser(input?: MerchantUserInput): Promise<MerchantUser>;
  entity(input?: EntityInput): Promise<Entity>;
  store(input?: StoreInput): Promise<Store>;
  entityMember(input?: EntityMemberInput): Promise<EntityMember>;
  storeMember(input?: StoreMemberInput): Promise<StoreMember>;
  staff(input?: StaffInput): Promise<Staff>;
  fileObject(input?: FileObjectInput): Promise<FileObject>;
  billingAccount(input?: BillingAccountInput): Promise<BillingAccount>;
  paymentTxn(input?: PaymentTxnInput): Promise<PaymentTxn>;
  billingOrder(input?: BillingOrderInput): Promise<BillingOrder>;
  subscriptionTerm(input?: SubscriptionTermInput): Promise<SubscriptionTerm>;
  pointHold(input?: PointHoldInput): Promise<PointHold>;
  drama(input?: DramaInput): Promise<Drama>;
  dramaEpisode(input?: DramaEpisodeInput): Promise<DramaEpisode>;
  agreementVersion(input?: AgreementVersionInput): Promise<AgreementVersion>;
  agreementConsent(input?: AgreementConsentInput): Promise<AgreementConsent>;
  dramaOrder(input?: DramaOrderInput): Promise<DramaOrder>;
  orderItem(input?: OrderItemInput): Promise<OrderItem>;
  deliveryTicket(input?: DeliveryTicketInput): Promise<DeliveryTicket>;
}

/** 商家的起步数据：一位老板、他的主体、首家门店、老板的成员关系、计费账户 */
export interface MerchantScenario {
  readonly user: MerchantUser;
  readonly entity: Entity;
  readonly store: Store;
  readonly owner: EntityMember;
  readonly billingAccount: BillingAccount;
}

/** 已认证、已开通套餐的商家：起步数据之外多一期生效的订阅，计费账户指着它 */
export interface SubscribedMerchantScenario extends MerchantScenario {
  readonly term: SubscriptionTerm;
}

export interface MerchantScenarioOptions {
  /** 为真时主体已认证、门店资质已通过；缺省都是未提交 */
  verified?: boolean;
}

/** 组合：一次造好几张表上互相对得上的行。不是“一张表一个”的那一类 */
export interface ScenarioFactories {
  merchant(options?: MerchantScenarioOptions): Promise<MerchantScenario>;
  subscribedMerchant(): Promise<SubscribedMerchantScenario>;
}

export interface Factories extends TableFactories, ScenarioFactories {}

/** 工厂名 → 表名。加工厂：types.ts 的 TableFactories 加一个方法，这里加一行，用例清单跟着多一条 */
export const FACTORY_TABLES = {
  merchantUser: "merchant_user",
  entity: "entity",
  store: "store",
  entityMember: "entity_member",
  storeMember: "store_member",
  staff: "staff",
  fileObject: "file_object",
  billingAccount: "billing_account",
  paymentTxn: "payment_txn",
  billingOrder: "billing_order",
  subscriptionTerm: "subscription_term",
  pointHold: "point_hold",
  drama: "drama",
  dramaEpisode: "drama_episode",
  agreementVersion: "agreement_version",
  agreementConsent: "agreement_consent",
  dramaOrder: "drama_order",
  orderItem: "order_item",
  deliveryTicket: "delivery_ticket",
} as const satisfies Record<keyof TableFactories, string>;
