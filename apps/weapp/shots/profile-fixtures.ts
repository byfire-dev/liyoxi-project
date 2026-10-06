import type { components } from "@liyoxi/contract/types/merchant";
import { ApiError, type RequestLayer } from "../src/lib/request";
import type {
  Basic,
  Media,
  Service,
  OwnerQualification,
  Overview,
  Doc,
  Data,
  Body,
} from "../src/sub/profile/private/api";
import { makeMe } from "./account-fixtures";
const ID = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-10-06T00:00:00.000Z";
const LATER = "2026-10-07T09:00:00.000Z";
const ref = (code: string, name: string) => ({ code, name });
const PICTURE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#E8DDD0"/><path d="M0 90 50 40 85 70 120 25 160 90" fill="#7A8D69"/><rect x="42" y="66" width="74" height="54" fill="#D6B78A"/><text x="80" y="94" text-anchor="middle" font-size="14" fill="#4A433B">门店实拍</text></svg>')}`;
const file = (number: number): NonNullable<components["schemas"]["MediaFileView"]> => ({
  fileId: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
  kind: "image",
  url: PICTURE,
  expiresAt: LATER,
  coverUrl: null,
  durationMs: null,
  displayWidth: 160,
  displayHeight: 120,
  moderationState: "pass",
});
const completeness: components["schemas"]["Completeness"] = {
  pct: 100,
  requiredFilled: 17,
  requiredTotal: 17,
  steps: [1, 2, 3, 4].map((step) => ({ step, state: "completed", missing: [] })),
};
export const basic: Basic = {
  viewerRole: "owner",
  brandName: "邻里咖啡",
  logo: file(10),
  storeName: "邻里咖啡 · 福田店",
  industry: ref("food", "餐饮"),
  category: ref("coffee", "咖啡饮品"),
  address: {
    province: ref("guangdong", "广东省"),
    city: ref("shenzhen", "深圳市"),
    district: ref("futian", "福田区"),
    zone: null,
    detail: "邻里路16号一层",
    poiName: null,
    latitude: null,
    longitude: null,
  },
  businessHours: [{ start: "09:00", end: "22:00" }],
  storeTel: "0755-12345678",
  avgSpendFen: 4500,
  brandIntro: "社区里的温暖咖啡店，现磨咖啡与每日手作点心",
  reviewFieldsLocked: false,
  reviewRequiredOnChange: false,
  lastEditedAt: NOW,
  completeness,
  pendingChange: null,
  lockVersion: 1,
};
export const media: Media = {
  viewerRole: "owner",
  groups: {
    door: [file(11)].map((file, i) => ({
      mediaItemId: file.fileId,
      mediaKind: "image",
      position: i + 1,
      isCopied: false,
      file,
    })),
    interior: [file(12), file(13), file(14)].map((file, i) => ({
      mediaItemId: file.fileId,
      mediaKind: "image",
      position: i + 1,
      isCopied: false,
      file,
    })),
    product: [],
    promo: [],
  },
  lockVersion: 1,
  completeness,
};
export const service: Service = {
  viewerRole: "owner",
  serviceItems: [
    {
      serviceItemId: ID,
      position: 1,
      name: "手作拿铁",
      priceFen: 2800,
      originalPriceFen: 3200,
      image: file(15),
      intro: "醇香咖啡配鲜奶",
    },
    {
      serviceItemId: file(16).fileId,
      position: 2,
      name: "轻食下午茶",
      priceFen: 4800,
      originalPriceFen: null,
      image: file(16),
      intro: "每日手作，温暖新鲜",
    },
  ],
  sellingPoints: [ref("fresh", "每日现做"), ref("neighbour", "社区好店")],
  promoText: "到店出示视频，享下午茶优惠",
  groupBuyText: "双人咖啡下午茶套餐",
  sellingNote: "适合朋友小聚与午后休闲",
  lockVersion: 1,
  completeness,
};
const license: Doc = {
  qualificationDocId: file(20).fileId,
  docType: "business_license",
  permitType: null,
  scope: "entity",
  origin: "uploaded",
  fileId: file(21).fileId,
  ocrStatus: "unavailable",
  ocrWarnings: [],
  hasSubmittedFields: true,
  holderName: "邻里咖啡有限公司",
  certNoMask: "9144**********123X",
  principalNameMask: "林**",
  principalRole: "legal_rep",
  subjectType: "enterprise",
  validStartDate: "2020-01-01",
  validEndDate: null,
  isLongTerm: true,
  expiryState: "none",
  displayFields: [{ key: "address", label: "注册地址", value: "广东省深圳市福田区邻里路16号" }],
  verdict: null,
  isEffective: false,
  uploadedAt: NOW,
};
const permit: Doc = {
  ...license,
  qualificationDocId: file(22).fileId,
  docType: "industry_permit",
  permitType: ref("food_business", "食品经营许可证"),
  scope: "store",
  fileId: file(23).fileId,
  certNoMask: "JY********1234",
  principalNameMask: null,
  principalRole: null,
  subjectType: null,
  validEndDate: "2028-05-20",
  isLongTerm: false,
  displayFields: [{ key: "businessItems", label: "经营项目", value: "热食类食品制售" }],
};
export const qualification: OwnerQualification = {
  viewerRole: "owner",
  storeQualificationStatus: "unsubmitted",
  isChangeInReview: false,
  isFinalRejected: false,
  entity: {
    verificationStatus: "unsubmitted",
    name: null,
    entityType: null,
    usccMask: null,
    legalRepNameMask: null,
    verifiedAt: null,
  },
  openRound: {
    qualificationSubmissionId: ID,
    kind: "initial",
    phase: "draft",
    roundNo: null,
    isResubmit: false,
    claimedEntityType: "enterprise",
    declarationConfirmedAt: null,
    declarationVersion: null,
    changedFields: [],
    proposed: null,
    contactSnapshot: null,
    submittedAt: null,
    dueAt: null,
    closedAt: null,
    outcome: null,
    decidedAt: null,
    isDecidedBySystem: false,
    rejectReasons: [],
    decisionNote: null,
    systemRejectCode: null,
    finalRejectedAt: null,
    docs: [license, permit],
    lockVersion: 1,
  },
  lastClosedRound: null,
  effectiveDocs: [],
  requiredPermits: [{ permitType: ref("food_business", "食品经营许可证"), isProvided: true }],
  contact: {
    name: "林店长",
    phoneMask: "138****8000",
    phoneVerifyState: "login",
    phoneVerifiedAt: NOW,
    loginPhoneMask: "138****8000",
    isSmsVerifyAvailable: false,
    lockVersion: 1,
  },
  declaration: { currentVersion: "1" },
  actions: ["submit"],
};
export const overview: Overview = {
  viewerRole: "owner",
  store: {
    storeId: ID,
    name: basic.storeName,
    isPrimary: true,
    qualificationStatus: "unsubmitted",
    isChangeInReview: false,
    isFinalRejected: false,
    industry: basic.industry,
    category: basic.category,
  },
  completeness,
  entityName: null,
  steps: {
    basic: { state: "completed" },
    media: { state: "completed", doorCount: 1, interiorCount: 3, productCount: 0, promoCount: 0 },
    service: { state: "completed", serviceItemCount: 2, sellingPointCount: 2, hasPromoText: true },
    qualification: {
      state: "completed",
      docTypes: [license, permit].map((d) => ({ docType: d.docType, permitType: d.permitType })),
    },
  },
  qualification: { status: "unsubmitted", submittedAt: null, dueAt: null, lastDecidedAt: null },
  assets: { total: 0, recent7dCount: 0, recent: [] },
  members: { ownerDisplayName: "林店长", clerkCount: 0, preview: [], pendingInvitationCount: 0 },
  ads: { confirmedCount: 0, pendingConfirmCount: 0, producingCount: 0, revisingCount: 0 },
};
const dictItem = (
  code: string,
  name: string,
  parentCode: string | null = null,
  ext: Record<string, unknown> = {},
) => ({
  code,
  name,
  parentCode,
  ext,
  description: null,
  tags: [],
  position: 1,
  isSelectable: true,
});
export const dicts: Data<"m.dictItem.list"> = {
  items: [
    {
      typeKey: "industry",
      name: "行业品类",
      structure: "tree",
      versionNo: 1,
      items: [
        dictItem("food", "餐饮", null, { open: true }),
        dictItem("coffee", "咖啡饮品", "food", { open: true }),
      ],
    },
    {
      typeKey: "region",
      name: "行政区划",
      structure: "tree",
      versionNo: 1,
      items: [
        dictItem("guangdong", "广东省", null, { level: 1, opened: true }),
        dictItem("shenzhen", "深圳市", "guangdong", { level: 2, opened: true }),
        dictItem("futian", "福田区", "shenzhen", { level: 3, opened: true }),
      ],
    },
    {
      typeKey: "store_selling_point",
      name: "门店卖点",
      structure: "flat",
      versionNo: 1,
      items: [
        dictItem("fresh", "每日现做", null, { categoryCodes: [] }),
        dictItem("neighbour", "社区好店", null, { categoryCodes: ["coffee"] }),
      ],
    },
    {
      typeKey: "permit_type",
      name: "许可证类型",
      structure: "flat",
      versionNo: 1,
      items: [
        dictItem("food_business", "食品经营许可证", null, {
          fields: [
            { key: "operatorName", label: "经营者名称", sensitive: false, format: "text" },
            { key: "certNo", label: "许可证编号", sensitive: true, format: "cert_no" },
            { key: "premises", label: "经营场所", sensitive: false, format: "text" },
            { key: "businessItems", label: "经营项目", sensitive: false, format: "text" },
            { key: "validTo", label: "有效期至", sensitive: false, format: "date" },
          ],
        }),
      ],
    },
  ],
};
/** 只给本域离线渲染。未知请求抛错，不能悄悄走网络。 */
export function offlineProfile(scene: string) {
  const calls: {
    path: string;
    method: string;
    data: unknown;
    idempotencyKey: string | undefined;
  }[] = [];
  let created = scene !== "profile-not-started";
  const b = structuredClone(basic),
    m = structuredClone(media),
    s = structuredClone(service),
    q = structuredClone(qualification),
    o = structuredClone(overview);
  if (scene === "review-normal") {
    q.storeQualificationStatus = "pending";
    q.openRound!.phase = "in_review";
    q.openRound!.submittedAt = NOW;
    q.openRound!.dueAt = LATER;
    q.openRound!.roundNo = 1;
    q.openRound!.contactSnapshot = {
      name: "林店长",
      phoneMask: "138****8000",
      phoneVerifyState: "login",
    };
    q.actions = [];
  }
  if (scene === "review-rejected") {
    q.storeQualificationStatus = "rejected";
    q.lastClosedRound = {
      ...q.openRound!,
      phase: "closed",
      roundNo: 1,
      submittedAt: NOW,
      decidedAt: LATER,
      closedAt: LATER,
      outcome: "rejected",
      rejectReasons: [ref("blurred", "证照不清晰")],
      decisionNote: "请重新拍摄食品经营许可证，确保文字清晰",
      docs: q.openRound!.docs.map((doc) => ({
        ...doc,
        verdict: doc.docType === "industry_permit" ? "rejected" : "approved",
      })),
    };
    q.openRound = null;
    q.actions = [];
  }
  const conflicts = new Set<string>(),
    replays = new Set<string>();
  const control = {
    conflict: (path: string) => conflicts.add(path),
    replay: (path: string) => replays.add(path),
    replaceStore() {
      Object.assign(b, structuredClone(basic), {
        brandName: "新门店品牌",
        storeName: "新门店",
        lockVersion: 11,
      });
      Object.assign(m, structuredClone(media), { lockVersion: 11 });
      m.groups.door = [{ ...m.groups.door[0]!, file: file(21) }];
      Object.assign(s, structuredClone(service), { lockVersion: 11 });
      s.serviceItems[0]!.name = "新门店服务";
      Object.assign(q, structuredClone(qualification));
      q.contact.name = "新门店联系人";
      q.contact.lockVersion = 11;
    },
    lockBasic() {
      b.reviewFieldsLocked = true;
    },
  };
  const call: RequestLayer["request"] = async <T>(
    path: string,
    options?: Parameters<RequestLayer["request"]>[1],
  ) => {
    calls.push({
      path,
      method: options?.method ?? "GET",
      data: structuredClone(options?.data),
      idempotencyKey: options?.idempotencyKey,
    });
    let response: unknown;
    const body = options?.data as Record<string, unknown> | undefined;
    if (body && conflicts.delete(path)) {
      if (path === "/m/store-profile/basic" && b.viewerRole === "owner") b.lockVersion++;
      if (path === "/m/store-profile/media" && m.viewerRole === "owner") m.lockVersion++;
      if (path === "/m/store-profile/service" && s.viewerRole === "owner") s.lockVersion++;
      if (path === "/m/store-profile/contact") q.contact.lockVersion++;
      throw new ApiError({
        error: "VERSION_CONFLICT",
        message: "版本冲突",
        status: 409,
        requestId: "offline",
      });
    }
    if (path.startsWith("/m/dict-items?")) {
      const types = new URL(`http://offline${path}`).searchParams.get("typeKey")!.split(",");
      response = { items: dicts.items.filter((item) => types.includes(item.typeKey)) };
    } else if (path === "/m/entities") {
      created = true;
      response = {
        entity: { entityId: ID, name: null, verificationStatus: "unsubmitted" },
        store: {
          storeId: ID,
          name: null,
          isPrimary: true,
          lifecycle: "active",
          qualificationStatus: "unsubmitted",
        },
        role: "owner",
        memberId: ID,
      };
    } else if (path === "/m/store-profile") response = o;
    else if (path === "/m/store-profile/basic") {
      if (body) {
        b.brandName = typeof body.brandName === "string" ? body.brandName.trim() : null;
        if ("storeName" in body) b.storeName = body.storeName as string | null;
        if (b.viewerRole === "owner") b.lockVersion++;
      }
      response = b;
    } else if (path === "/m/store-profile/media") {
      if (body && m.viewerRole === "owner") {
        m.lockVersion++;
        const update = body as Body<"m.storeProfile.media.update">;
        for (const group of ["door", "interior", "product", "promo"] as const) {
          const files = update.groups?.[group];
          if (files)
            m.groups[group] = files.map(({ fileId }, i) => ({
              mediaItemId: fileId,
              mediaKind: "image",
              position: i + 1,
              isCopied: false,
              file: { ...file(11), fileId },
            }));
        }
      }
      response = m;
    } else if (path === "/m/store-profile/service") {
      if (body && s.viewerRole === "owner") {
        s.lockVersion++;
        const update = body as Body<"m.storeProfile.service.update">;
        if (update.serviceItems)
          s.serviceItems = update.serviceItems.map((item, i) => ({
            serviceItemId: item.serviceItemId ?? file(50 + i).fileId,
            position: i + 1,
            name: item.name,
            priceFen: item.priceFen,
            originalPriceFen: item.originalPriceFen ?? null,
            intro: item.intro ?? null,
            image: item.imageFileId ? { ...file(15), fileId: item.imageFileId } : null,
          }));
        s.promoText = update.promoText ?? null;
        s.groupBuyText = update.groupBuyText ?? null;
        s.sellingNote = update.sellingNote ?? null;
        if (update.sellingPointCodes)
          s.sellingPoints = update.sellingPointCodes.map((code) =>
            ref(
              code,
              dicts.items
                .find((d) => d.typeKey === "store_selling_point")!
                .items.find((d) => d.code === code)?.name ?? code,
            ),
          );
      }
      response = s;
    } else if (path === "/m/store-profile/contact") {
      q.contact.name = body!.name as string;
      q.contact.lockVersion++;
      response = q.contact;
    } else if (path === "/m/store-profile/qualification/submit") {
      if (scene === "cert-normal" && q.declaration.currentVersion === "1") {
        q.declaration.currentVersion = "2";
        throw new ApiError({
          error: "DECLARATION_REQUIRED",
          message: "声明已更新",
          status: 409,
          requestId: "offline",
          details: { currentVersion: "2" },
        });
      }
      if (scene === "cert-missing")
        throw new ApiError({
          error: "STORE_PROFILE_INCOMPLETE",
          message: "请补充门店必填资料",
          status: 409,
          requestId: "offline",
          details: { missing: [{ step: 2, item: "interior_photos", permitType: null }] },
        });
      q.storeQualificationStatus = "pending";
      q.openRound!.phase = "in_review";
      q.openRound!.submittedAt = NOW;
      q.actions = [];
      response = q;
    } else if (path === "/m/store-profile/qualification") {
      if (body) {
        q.openRound ??= {
          ...qualification.openRound!,
          isResubmit: Boolean(q.lastClosedRound),
          docs:
            q.lastClosedRound?.docs
              .filter((doc) => doc.verdict !== "rejected")
              .map((doc) => ({ ...doc, origin: "carried" })) ?? [],
        };
        if (body.claimedEntityType)
          q.openRound.claimedEntityType = body.claimedEntityType as "enterprise";
        q.openRound.lockVersion++;
        q.actions = ["submit"];
      }
      response = q;
    } else throw new Error(`建档离线场景未登记调用：${path}`);
    if (body && replays.delete(path)) {
      // 本域三条重放按真实协议去掉签名字段，GET 仍给当前完整视图。
      const redact = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(redact);
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
              key,
              ["url", "expiresAt", "coverUrl"].includes(key) ? null : redact(child),
            ]),
          );
        return value;
      };
      return { ...(redact(response) as object), replayed: true } as T;
    }
    return structuredClone(response) as T;
  };
  return {
    call,
    calls,
    control,
    me: () => {
      const me = makeMe();
      if (!created) me.memberships = [];
      else me.memberships[0]!.stores = [me.memberships[0]!.stores[0]!];
      return me;
    },
  };
}
