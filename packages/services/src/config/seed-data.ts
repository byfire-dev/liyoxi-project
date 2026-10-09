// config 的种子数据（W0-21）：22 类字典与初始项、9 套清单模板的首版、站点配置初始版。
// 开关不在这里：直接取契约的 FLAGS。参数值不播种：库里没有的键取代码默认值（14 分组 第 2.3 节）。
// 出处：14 分组 第 2.1、2.4、2.8 节；清单条目取 D3 第 10.2、11–15 节与后台原型（任务书 第 2 节）。
// 这里的值是上线初始值，之后由后台维护；现有行不覆盖，仅从未运营的空卖点类型允许安全补齐。
import type {
  ChecklistItem,
  EnumValue,
  CHECKLIST_TEMPLATE_CODE,
  DICT_TYPE_DISABLE_POLICY,
  DICT_TYPE_STRUCTURE,
  HomeRecommendConfig,
  MallConfig,
  PermitTypeExt,
} from "@liyoxi/contract";

// ---------- 字典类型 ----------

export interface DictTypeSeed {
  readonly typeKey: string;
  readonly name: string;
  readonly structure: EnumValue<typeof DICT_TYPE_STRUCTURE>;
  readonly maxDepth: number;
  /** 顺序生成编码的前缀与位数；不按顺序生成的（国标码、系统枚举）为空 */
  readonly code: { readonly prefix: string; readonly width: number } | null;
  readonly isSystem: boolean;
  readonly canCreate: boolean;
  readonly disablePolicy: EnumValue<typeof DICT_TYPE_DISABLE_POLICY>;
  readonly isMerchantVisible: boolean;
}

interface TypeOptions {
  /** 两级或三级的树；不写即平铺 */
  tree?: 2 | 3;
  /** 小程序可读 */
  merchant?: boolean;
  policy?: DictTypeSeed["disablePolicy"];
  /** 系统枚举：真相在代码，后台不能新增与停用 */
  system?: boolean;
  /** 不可新增（按国标导入） */
  noCreate?: boolean;
}

function dictType(
  typeKey: string,
  name: string,
  prefix: string | null,
  options: TypeOptions = {},
): DictTypeSeed {
  const system = options.system === true;
  return {
    typeKey,
    name,
    structure: options.tree ? "tree" : "flat",
    maxDepth: options.tree ?? 1,
    code: prefix === null ? null : { prefix, width: 2 },
    isSystem: system,
    canCreate: !system && options.noCreate !== true,
    disablePolicy: options.policy ?? (system ? "never" : "free"),
    isMerchantVisible: options.merchant === true,
  };
}

/**
 * 22 类，顺序照 14 分组 第 2.1 节的播种表。文档只写“顺序”的类型，前缀是本包定的（两个大写字母，各不相同）。
 */
export const DICT_TYPE_SEEDS: readonly DictTypeSeed[] = [
  dictType("industry", "行业品类", "C", { tree: 2, merchant: true, policy: "block_if_referenced" }),
  dictType("region", "行政区划", null, {
    tree: 3,
    merchant: true,
    policy: "block_if_referenced",
    noCreate: true,
  }),
  dictType("genre", "题材", "G", { merchant: true }),
  dictType("selling_tag", "卖点标签", "T", { merchant: true }),
  dictType("reject_reason", "驳回原因", "R"),
  dictType("ticket_type", "工单类型", "K", { merchant: true }),
  dictType("ticket_withdraw_reason", "工单撤回原因", "TW", { merchant: true }),
  dictType("ticket_transfer_reason", "工单分配与转派原因", "TT"),
  dictType("extend_reason", "补偿延长原因", "EX"),
  dictType("patrol_issue", "巡检异常类型", "PI"),
  dictType("custom_focus", "定制重点", "CF", { merchant: true }),
  dictType("asset_tag", "素材标签", "AT", { merchant: true }),
  dictType("ad_promo_point", "广告宣传重点", "AP", { merchant: true }),
  dictType("reissue_reason", "补发原因", "RI"),
  dictType("store_selling_point", "门店核心卖点", "SP", { merchant: true }),
  dictType("permit_type", "行业许可证类型", "PT", {
    merchant: true,
    policy: "block_if_referenced",
  }),
  dictType("account_change_reason", "账号变更原因", "AC"),
  dictType("refund_reason", "退款申请原因", "RF"),
  dictType("express_company", "快递公司", "EC"),
  dictType("bank", "付款行", "BK"),
  dictType("plan_tier", "套餐版本", null, { merchant: true, system: true }),
  dictType("point_type", "积分类型", null, { tree: 2, merchant: true, system: true }),
];

// ---------- 字典项 ----------

export interface DictItemSeed {
  readonly dictTypeKey: string;
  readonly code: string;
  readonly parentCode: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly ext: Readonly<Record<string, unknown>>;
  /** 同级内的顺序，从 0 起 */
  readonly position: number;
}

type ItemInput = string | { name: string; description?: string; ext?: Record<string, unknown> };

/** 按顺序生成编码的一组项：前缀、位数取类型的登记，序号从 start 起 */
function sequential(typeKey: string, items: readonly ItemInput[], start = 1): DictItemSeed[] {
  const type = DICT_TYPE_SEEDS.find((item) => item.typeKey === typeKey);
  if (!type?.code) throw new Error(`字典类型 ${typeKey} 不按顺序生成编码`);
  const { prefix, width } = type.code;
  return items.map((input, index) => {
    const item = typeof input === "string" ? { name: input } : input;
    return {
      dictTypeKey: typeKey,
      code: `${prefix}${String(start + index).padStart(width, "0")}`,
      parentCode: null,
      name: item.name,
      description: item.description ?? null,
      ext: item.ext ?? {},
      position: start - 1 + index,
    };
  });
}

/** 固定编码的项：代码按编码引用 */
function fixed(
  typeKey: string,
  code: string,
  name: string,
  options: { parentCode?: string; ext?: Record<string, unknown>; position?: number } = {},
): DictItemSeed {
  return {
    dictTypeKey: typeKey,
    code,
    parentCode: options.parentCode ?? null,
    name,
    description: null,
    ext: options.ext ?? {},
    position: options.position ?? 0,
  };
}

/**
 * 驳回原因各场景的项，编码从 R01 起按这里的顺序生成（14 分组 第 2.1 节）。
 * 同级不重名（uq_dict_item_sibling_name），而六个场景都有“其他”：在几个场景里都出现的名称一律带上场景名。
 */
const REJECT_REASONS: readonly (readonly [
  scene: string,
  label: string,
  names: readonly string[],
])[] = [
  [
    "store_review",
    "资质审核",
    ["证照模糊", "主体与档案不一致", "证照过期", "缺少行业许可证", "其他"],
  ],
  [
    "link_verify",
    "链接核验",
    [
      "集数不全",
      "账号与授权书不一致",
      "“广告”标识缺失",
      "许可信息被遮挡",
      "声明了原创",
      "链接无法打开",
    ],
  ],
  [
    "account_verify",
    "账号核验",
    [
      "主页截图不完整",
      "账号名称不一致",
      "账号 ID 不一致",
      "账号类型与截图不一致",
      "认证主体与商家主体不一致",
      "账号状态异常",
      "其他",
    ],
  ],
  ["point_adjust", "积分调整", ["依据不足", "数额有误", "不符合调整规则", "其他"]],
  ["transfer", "对公凭证", ["未到账", "金额不符", "户名与购买主体不一致", "凭证无法识别", "其他"]],
  ["invoice", "开票", ["开票信息有误", "重复申请", "其他"]],
  ["cancel_refund", "取消与退款", ["不符合退款规则", "金额核算有误", "说明不充分", "其他"]],
];

function rejectReasonItems(): DictItemSeed[] {
  const all = REJECT_REASONS.flatMap(([, , names]) => names);
  const shared = new Set(all.filter((name, index) => all.indexOf(name) !== index));
  const inputs = REJECT_REASONS.flatMap(([scene, label, names]) =>
    names.map((plain) => ({
      name: shared.has(plain) ? `${plain}（${label}）` : plain,
      description: label,
      ext: { scene },
    })),
  );
  return sequential("reject_reason", inputs);
}

/** 工单类型 K01–K10：ext 四个键都写全；K08 是售后类且优先级高，K09 通知客服主管 */
function ticketTypeItems(): DictItemSeed[] {
  const base = {
    defaultPriority: "mid",
    transferable: true,
    notifyLead: false,
    isAfterSales: false,
  };
  const names = [
    "交付进度",
    "广告制作",
    "内容修改",
    "发布与上线",
    "套餐与积分",
    "数据问题",
    "发票",
    "取消与退款",
    "投诉建议",
    "其他",
  ];
  return sequential(
    "ticket_type",
    names.map((name) => {
      if (name === "取消与退款") {
        return { name, ext: { ...base, defaultPriority: "high", isAfterSales: true } };
      }
      if (name === "投诉建议") return { name, ext: { ...base, notifyLead: true } };
      return { name, ext: base };
    }),
  );
}

/** 食品经营许可证的字段清单与派生列映射（14 分组 第 2.1 节 food_business 的 ext） */
const FOOD_BUSINESS_EXT: PermitTypeExt = {
  fields: [
    { key: "operatorName", label: "经营者名称", sensitive: false, format: "text" },
    { key: "certNo", label: "许可证编号", sensitive: true, format: "cert_no" },
    { key: "premises", label: "经营场所", sensitive: false, format: "text" },
    { key: "businessItems", label: "经营项目", sensitive: false, format: "text" },
    { key: "validTo", label: "有效期至", sensitive: false, format: "date" },
  ],
  holderNameKey: "operatorName",
  certNoKey: "certNo",
  certNoPattern: "^JY[0-9]{14}$",
  principalNameKey: null,
  validFromKey: null,
  validToKey: "validTo",
};

/**
 * 两个系统枚举字典的项：真相在代码，就是这张表（契约里没有对应的枚举；config.N16 对照它）。
 * plan_tier 的编码是套餐的版本码；point_type 两组，账户一组的编码同契约的 POINT_LOT_KIND。
 */
export const SYSTEM_DICT_ITEMS: readonly DictItemSeed[] = [
  fixed("plan_tier", "basic", "基础版", { position: 0 }),
  fixed("plan_tier", "pro", "专业版", { position: 1 }),
  fixed("plan_tier", "flagship", "旗舰版", { position: 2 }),
  fixed("point_type", "account", "积分账户", { position: 0 }),
  fixed("point_type", "plan", "套餐积分", { parentCode: "account", position: 0 }),
  fixed("point_type", "addon", "加购积分", { parentCode: "account", position: 1 }),
  fixed("point_type", "entry", "流水类型", { position: 1 }),
  ...(
    [
      ["grant", "发放"],
      ["purchase", "加购"],
      ["hold", "冻结"],
      ["capture", "扣减"],
      ["return", "退回"],
      ["expire", "清零"],
      ["adjust", "调整"],
    ] as const
  ).map(([code, name], index) =>
    fixed("point_type", code, name, { parentCode: "entry", position: index }),
  ),
];

/** 通用候选只供商家自行选择，不代填门店卖点；空品类集合表示适用全部品类。 */
export const STORE_SELLING_POINT_SEEDS: readonly DictItemSeed[] = sequential(
  "store_selling_point",
  ["品质服务", "环境舒适", "位置便利", "性价比高"].map((name) => ({
    name,
    ext: { categoryCodes: [] },
  })),
);

/** 全部初始项。上级排在下级前面（同类型内的自引用外键） */
export const DICT_ITEM_SEEDS: readonly DictItemSeed[] = [
  ...rejectReasonItems(),
  ...ticketTypeItems(),
  ...sequential("ticket_withdraw_reason", ["问题已解决", "不再需要", "重复提交", "其他"]),
  ...sequential("ticket_transfer_reason", ["需客服跟进", "需交付侧评估", "工作量调整", "其他"]),
  ...sequential("ad_promo_point", ["品牌露出", "优惠活动", "团购", "主推服务", "到店引导"]),
  ...sequential("reissue_reason", ["错别字", "广告版本", "AI 标识", "画面问题", "其他"]),
  ...sequential("express_company", ["顺丰速运", "中国邮政 EMS", "京东快递"]),
  ...STORE_SELLING_POINT_SEEDS,
  fixed("permit_type", "food_business", "食品经营许可证", { ext: { ...FOOD_BUSINESS_EXT } }),
  fixed("asset_tag", "brand_story", "品牌故事", { ext: { dimension: "content" } }),
  ...SYSTEM_DICT_ITEMS,
];

/** 类型播种时的下一个顺序号：已按顺序发出去的一级项个数加 1（固定编码的项不占号） */
export function nextCodeNoOf(type: DictTypeSeed): number {
  if (type.code === null) return 1;
  const { prefix, width } = type.code;
  const pattern = new RegExp(`^${prefix}[0-9]{${width}}$`);
  const issued = DICT_ITEM_SEEDS.filter(
    (item) =>
      item.dictTypeKey === type.typeKey && item.parentCode === null && pattern.test(item.code),
  );
  return issued.length + 1;
}

// ---------- 清单模板 ----------

export type ChecklistCode = EnumValue<typeof CHECKLIST_TEMPLATE_CODE>;

export interface ChecklistTemplateSeed {
  readonly code: ChecklistCode;
  readonly items: readonly ChecklistItem[];
}

function item(
  key: string,
  label: string,
  options: { allowNa?: boolean; merchantVisible?: boolean } = {},
): ChecklistItem {
  return {
    key,
    label,
    required: true,
    allowNa: options.allowNa === true,
    merchantVisible: options.merchantVisible === true,
  };
}

const shown = { merchantVisible: true };

/** 样片质检 6 项（D3 第 10.2 节）；向商家展示前 4 项 */
const QC_SAMPLE: readonly ChecklistItem[] = [
  item("picture_audio", "画面清晰、音画同步", shown),
  item("ad_placement", "广告位置与时长符合方案，“广告”标识清晰", shown),
  item("title_permit", "片头剧名及许可信息完整、未被遮挡", shown),
  item("subtitle_brand", "字幕与品牌信息同档案一致", shown),
  item("custom_content", "定制内容与方案一致，与其他门店成片有明显差异"),
  item("ai_label", "AI 生成提示标识清晰可见", { allowNa: true }),
];

/** 9 套模板的首版，都以启用状态写入（14 分组 第 2.8 节；config.N20 要求每个编码恰有一个启用版本） */
export const CHECKLIST_TEMPLATE_SEEDS: readonly ChecklistTemplateSeed[] = [
  { code: "qc.sample", items: QC_SAMPLE },
  // 单集质检：样片的第 1、2、3、4、6 项
  { code: "qc.episode", items: QC_SAMPLE.filter((entry) => entry.key !== "custom_content") },
  {
    code: "qc.package",
    items: [
      item("episodes_complete", "成片包集数完整"),
      item("files_match_list", "文件按集对应发布清单"),
    ],
  },
  {
    code: "delivery.precheck",
    items: [
      item("episodes_match_order", "集数完整且与订购剧目一致"),
      item("files_named_by_episode", "文件按集命名并与发布清单一一对应"),
      item("publish_list_filled", "合集名称、每集标题、话题与简介已填写"),
      item("account_matches_license", "发布账号与授权书一致"),
    ],
  },
  {
    code: "launch.verify",
    items: [
      item("episodes_match_links", "集数与回填一致", shown),
      item("account_matches_license", "发布账号与授权书一致", shown),
      item("ad_label_visible", "“广告”标识可见", shown),
      item("no_original_claim", "未声明原创", shown),
      item("launch_date_matches", "实际上线日期与平台显示的发布时间一致", shown),
    ],
  },
  {
    code: "patrol.check",
    items: [
      item("collection_accessible", "合集可正常访问", shown),
      item("episodes_complete", "集数完整，与订购剧目一致", shown),
      item("not_deleted_or_private", "无删除或“仅自己可见”", shown),
      item("no_platform_warning", "无审核中、限流或违规提示", shown),
      item("ad_label_and_permit", "“广告”标识与片头许可信息完整", shown),
    ],
  },
  {
    code: "takedown.check",
    items: [
      item("not_publicly_accessible", "作品已不可公开访问（以游客身份抽查合集及全部剧集）"),
      item("evidence_captured", "已截图留证（账号主页与合集页）"),
    ],
  },
  {
    code: "takedown.absence_check",
    items: [
      item("no_work_on_account", "该账号主页与合集中无本剧作品"),
      item("evidence_captured", "已截图留证（账号主页与合集页）"),
    ],
  },
  {
    // 文档没有给条目（a06 待确认第 1 项）：按账号核验比对表的六项写
    code: "account.verify",
    items: [
      item("screenshot_complete", "主页截图完整、清晰"),
      item("account_name_matches", "账号名称与提交一致"),
      item("account_id_matches", "账号 ID 与提交一致"),
      item("account_type_matches", "账号类型与截图一致"),
      item("cert_subject_matches", "认证主体与商家主体一致"),
      item("account_status_normal", "账号状态正常"),
    ],
  },
];

// ---------- 站点配置初始版 ----------

/** 商城配置初始版：只有固定的“全部”分类，题材与行业两项筛选，五种排序都开 */
export const MALL_CONFIG_SEED: MallConfig = {
  categories: [{ key: "all", name: "全部", genreCodes: [], visible: true, fixed: true }],
  hotWords: [],
  filters: {
    genre: true,
    industry: true,
    episodes: false,
    price: false,
    episodeBands: [],
    priceBands: [],
  },
  sorts: ["composite", "heat", "price_asc", "price_desc", "newest"],
  defaultSort: "composite",
  weights: { heat: 40, sales30d: 30, freshness: 20, manual: 10 },
};

/** 首页推荐位初始版：数量与新剧范围取 14 分组 第 4.3 节写的默认值，没有置顶 */
export const HOME_RECOMMEND_CONFIG_SEED: HomeRecommendConfig = {
  recommendCount: 6,
  pins: [],
  defaultTab: "hot",
  newDays: 30,
};

/** 两份配置各播一份已发布的修订，修订号 1（config.N9 的后半句靠它成立） */
export const SITE_CONFIG_SEEDS = [
  { configKey: "mall", content: MALL_CONFIG_SEED },
  { configKey: "home_recommend", content: HOME_RECOMMEND_CONFIG_SEED },
] as const;
