import {
  AdminStoreProfileSchema,
  ProxyEditBodySchema,
  PROXY_EDITABLE_FIELDS,
  PROXY_FORBIDDEN_FIELDS,
} from "@liyoxi/contract";
import type { ProxyEditBody } from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { authorize, hasPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { record } from "../audit/index.js";
import { AppError, createThreePhaseRunner, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { ProfileDeps, WriteOptions } from "./context.js";
import { metaOf } from "./context.js";
import { currentReviewStaff } from "./admin-authorization.js";
import { scopedStore } from "./admin-read.js";
import { ensureProfile, refreshCompleteness, snapshot } from "./repo.js";
import type { ProfileSnapshot } from "./repo.js";
import { assertVersion, lockFiles, requiredMissing } from "./validate.js";
import { attachUrls, basicView, mediaView, serviceView } from "./views.js";
import { applyLogo, applyMedia, applyServices } from "./write-parts.js";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function value(s: ProfileSnapshot) {
  return {
    brandName: s.profile?.brandName ?? null,
    logoFileId: s.profile?.logoFileId ?? null,
    businessHours: s.profile?.businessHours ?? [],
    storeTel: s.profile?.storeTel ?? null,
    avgSpendFen: s.profile?.avgSpendFen ?? null,
    brandIntro: s.profile?.brandIntro ?? null,
    promoText: s.profile?.promoText ?? null,
    groupBuyText: s.profile?.groupBuyText ?? null,
    sellingPointCodes: s.profile?.sellingPointCodes ?? [],
    sellingNote: s.profile?.sellingNote ?? null,
    serviceItems: s.services.map((r) => ({
      serviceItemId: r.id,
      name: r.name,
      priceFen: r.priceFen,
      originalPriceFen: r.originalPriceFen,
      imageFileId: r.imageFileId,
      intro: r.intro,
      position: r.position,
    })),
    mediaGroups: Object.fromEntries(
      ["door", "interior", "product", "promo"].map((group) => [
        group,
        s.media
          .filter((r) => r.mediaGroup === group)
          .map((r) => ({ fileId: r.fileId, position: r.position })),
      ]),
    ),
  };
}
function texts(input: ProxyEditBody) {
  const fields: Record<string, string | null | undefined> = {
    brandName: input.brandName,
    brandIntro: input.brandIntro,
    promoText: input.promoText,
    groupBuyText: input.groupBuyText,
    sellingNote: input.sellingNote,
  };
  for (const [i, item] of (input.serviceItems ?? []).entries()) {
    fields[`serviceItems.${i}.name`] = item.name;
    fields[`serviceItems.${i}.intro`] = item.intro;
  }
  return Object.entries(fields).filter(
    (r): r is [string, string] => typeof r[1] === "string" && r[1].length > 0,
  );
}

export function createAdminStoreProfile(deps: ProfileDeps) {
  async function access(
    tx: Tx,
    previous: StaffContext,
    id: string,
    input?: ProxyEditBody,
    lock = false,
  ) {
    if (lock) await lockRows(tx, "staff", [previous.staff.id], "share");
    let staff = await currentReviewStaff(tx, previous, deps.clock.now());
    if (input)
      authorize(
        staff,
        { module: { module: "merchant", need: "view" }, permission: "merchant.profile.proxy_edit" },
        deps.clock.now(),
      );
    let store = await scopedStore(tx, staff, id);
    if (lock) {
      // owner变更与门店停用必须先于档案锁固定；商家原入口同样先锁store130。
      await lockRows(tx, "entity", [store.entityId], "share");
      await lockRows(tx, "store", [id]);
      staff = await currentReviewStaff(tx, previous, deps.clock.now());
      authorize(
        staff,
        { module: { module: "merchant", need: "view" }, permission: "merchant.profile.proxy_edit" },
        deps.clock.now(),
      );
      store = await scopedStore(tx, staff, id);
      await ensureProfile(tx, id, deps.clock.now());
    }
    const s = await snapshot(tx, id);
    if (input) {
      if (store.lifecycle !== "active" || s.store.entity.lifecycle !== "active")
        throw new AppError("STATE_NOT_ALLOWED", { details: { reason: "store_archived" } });
      assertVersion(s.profile?.lockVersion ?? 0, input.lockVersion);
    }
    return { staff, s };
  }
  async function owner(tx: Tx, entityId: string) {
    return tx.entityMember.findFirst({
      where: { entityId, role: "owner", status: "active", merchantUser: { status: "active" } },
      select: { id: true, merchantUserId: true },
    });
  }
  async function projection(tx: Tx, staff: StaffContext, s: ProfileSnapshot) {
    if ([...s.files.values()].some((file) => file.entityId !== s.store.entityId))
      throw new AppError("NOT_FOUND");
    const basic = await basicView(tx, s),
      media = await mediaView(tx, s),
      service = await serviceView(tx, s),
      p = s.profile;
    let name: string | null = null;
    if (p?.lastEditActorType === "staff" && p.lastEditActorId)
      name =
        (await tx.staff.findUnique({ where: { id: p.lastEditActorId }, select: { name: true } }))
          ?.name ?? null;
    else if (p?.lastEditActorType === "merchant" && p.lastEditActorId) {
      const member = await tx.entityMember.findFirst({
        where: { entityId: s.store.entityId, merchantUserId: p.lastEditActorId },
        include: { merchantUser: { select: { displayName: true } } },
      });
      name = member?.displayName ?? member?.merchantUser.displayName ?? null;
    }
    return AdminStoreProfileSchema.parse({
      ...basic,
      ...service,
      storeId: s.store.id,
      media: media.groups,
      copiedFromStoreId: p?.copiedFromStoreId ?? null,
      lastEditedAt: p?.lastEditedAt?.toISOString() ?? null,
      lastEditor: p?.lastEditActorType ? { actorType: p.lastEditActorType, name } : null,
      lockVersion: p?.lockVersion ?? 0,
      proxyEditableFields: [...PROXY_EDITABLE_FIELDS],
      actions:
        hasPermission(staff, "merchant.profile.proxy_edit") &&
        s.store.lifecycle === "active" &&
        s.store.entity.lifecycle === "active"
          ? ["update"]
          : [],
    });
  }
  async function decorate(
    staff: StaffContext,
    id: string,
    dto: Awaited<ReturnType<typeof projection>>,
    replayed = false,
  ) {
    return attachUrls(deps, dto, replayed, {
      audience: "staff",
      assertAccess: (fileId, coverFileId) =>
        deps.tx.run(async (tx) => {
          const { s } = await access(tx, staff, id);
          const refs = [
            ...(s.profile?.logoFileId === fileId
              ? [{ refType: "store_profile", refId: id, role: "logo" }]
              : []),
            ...s.media
              .filter((r) => r.fileId === fileId)
              .map((r) => ({ refType: "store_profile_media", refId: r.id, role: "main" })),
            ...s.services
              .filter((r) => r.imageFileId === fileId)
              .map((r) => ({ refType: "store_service_item", refId: r.id, role: "image" })),
          ];
          if (
            !refs.length ||
            s.files.get(fileId)?.entityId !== s.store.entityId ||
            !(await tx.fileRef.findFirst({
              where: { fileId, entityId: s.store.entityId, storeId: id, state: "live", OR: refs },
            }))
          )
            throw new AppError("NOT_FOUND");
          if (coverFileId) {
            const info = await tx.mediaInfo.findUnique({
              where: { fileId },
              select: { coverFileId: true },
            });
            const cover = await tx.fileObject.findUnique({
              where: { id: coverFileId },
              select: { entityId: true, status: true, moderationState: true },
            });
            if (
              info?.coverFileId !== coverFileId ||
              cover?.entityId !== s.store.entityId ||
              cover.status !== "stored" ||
              cover.moderationState === "block"
            )
              throw new AppError("NOT_FOUND");
          }
        }),
    });
  }
  return {
    async get(staff: StaffContext, id: string) {
      const dto = await deps.tx.run(async (tx) => {
        const current = await access(tx, staff, id);
        return projection(tx, current.staff, current.s);
      });
      return decorate(staff, id, dto);
    },
    async update(
      previous: StaffContext,
      identity: IdentityContext,
      id: string,
      raw: unknown,
      options: WriteOptions = {},
    ) {
      if (
        identity.actor.type !== "staff" ||
        identity.actor.client !== "admin" ||
        identity.actor.id !== previous.staff.id ||
        identity.entityId !== null ||
        identity.storeId !== null
      )
        throw new AppError("PERMISSION_DENIED");
      const parsed = ProxyEditBodySchema.safeParse(raw);
      if (!parsed.success) throw new AppError("VALIDATION_FAILED");
      const input = parsed.data,
        forbidden = PROXY_FORBIDDEN_FIELDS.filter((key) => Object.hasOwn(input, key));
      if (forbidden.length)
        throw new AppError("FIELD_NOT_PROXY_EDITABLE", { details: { fields: forbidden } });
      // 回执重放不重检旧版本，但必须按此刻员工权限与门店范围重新授权。
      await deps.tx.run(async (tx) => {
        const current = await access(tx, previous, id);
        authorize(
          current.staff,
          {
            module: { module: "merchant", need: "view" },
            permission: "merchant.profile.proxy_edit",
          },
          deps.clock.now(),
        );
      });
      const content = texts(input);
      const dto = await createThreePhaseRunner(deps).run(
        {
          claim: async (tx) => {
            const { s } = await access(tx, previous, id, input),
              boss = await owner(tx, s.store.entityId),
              wx =
                content.length && boss
                  ? await deps.proxyOpenid?.(tx, boss.merchantUserId, deps.clock.now())
                  : null;
            if (content.length && !wx) throw new AppError("PROVIDER_UNAVAILABLE");
            return { ownerId: boss?.id ?? null, wx: wx ?? null };
          },
          external: async (intent) => {
            const rejected = [];
            for (const [field, content] of texts(input)) {
              await deps.tx.run(async (tx) => {
                const { s } = await access(tx, previous, id, input),
                  boss = await owner(tx, s.store.entityId),
                  current = boss
                    ? await deps.proxyOpenid?.(tx, boss.merchantUserId, deps.clock.now())
                    : null;
                if (
                  boss?.id !== intent.ownerId ||
                  !current ||
                  !intent.wx ||
                  current.wechatIdentityId !== intent.wx.wechatIdentityId ||
                  current.openid !== intent.wx.openid
                )
                  throw new AppError("PRECONDITION_CHANGED");
              });
              const result = await deps.wechat.checkText({
                openid: intent.wx!.openid,
                scene: "profile",
                content,
              });
              if (!result.ok) throw new AppError("PROVIDER_UNAVAILABLE");
              if (result.value.verdict !== "pass") rejected.push(field);
            }
            if (rejected.length)
              throw new AppError("CONTENT_REJECTED", { details: { fields: rejected } });
          },
          settle: async (tx, _outcome, intent) => {
            const { staff, s: before } = await access(tx, previous, id, input, true),
              now = deps.clock.now(),
              boss = await owner(tx, before.store.entityId);
            if ((boss?.id ?? null) !== intent.ownerId) throw new AppError("PRECONDITION_CHANGED");
            if (content.length) {
              const wx = boss ? await deps.proxyOpenid?.(tx, boss.merchantUserId, now) : null;
              if (
                !wx ||
                !intent.wx ||
                wx.wechatIdentityId !== intent.wx.wechatIdentityId ||
                wx.openid !== intent.wx.openid
              )
                throw new AppError("PRECONDITION_CHANGED");
            }
            const entityId = before.store.entityId,
              scope = {
                ctx: identity,
                entityId,
                storeId: id,
                checkFile: async (handle: Tx, fileId: string, categories: readonly string[]) => {
                  const file = await handle.fileObject.findUnique({ where: { id: fileId } });
                  const refuse = (reason: string): never => {
                    throw new AppError("FILE_NOT_USABLE", {
                      details: { fileIds: [fileId], reason },
                    });
                  };
                  if (!file || file.status !== "stored") return refuse("not_stored");
                  if (file.moderationState === "block") refuse("blocked");
                  if (!categories.includes(file.category)) refuse("category_mismatch");
                  if (
                    file.uploadActorType !== "staff" ||
                    file.uploadActorId !== staff.staff.id ||
                    file.scopeType !== "store" ||
                    file.entityId !== entityId ||
                    file.storeId !== id
                  )
                    refuse("scope_mismatch");
                  return file;
                },
              };
            // 一次预锁全部文件，再进三个共用应用段，不能分组引入file行锁倒序。
            await lockFiles(tx, [
              ...before.files.keys(),
              input.logoFileId,
              ...Object.values(input.mediaGroups ?? {}).flatMap((items) =>
                items.map((r) => r.fileId),
              ),
              ...(input.serviceItems ?? []).map((r) => r.imageFileId),
            ]);
            await applyLogo(tx, deps, scope, before.profile!.logoFileId, input, now);
            if (input.mediaGroups)
              await applyMedia(tx, deps, scope, before, input.mediaGroups, now);
            await applyServices(tx, deps, scope, before, input, now);
            const data: Prisma.StoreProfileUpdateInput = {};
            for (const key of [
              "brandName",
              "logoFileId",
              "businessHours",
              "storeTel",
              "avgSpendFen",
              "brandIntro",
              "promoText",
              "groupBuyText",
              "sellingPointCodes",
              "sellingNote",
            ] as const)
              if (input[key] !== undefined) Object.assign(data, { [key]: input[key] });
            await tx.storeProfile.update({ where: { storeId: id }, data });
            const after = await snapshot(tx, id),
              oldValue = value(before),
              newValue = value(after),
              fields = PROXY_EDITABLE_FIELDS.filter((key) => !same(oldValue[key], newValue[key]));
            if (!fields.length) throw new AppError("PROXY_EDIT_NO_CHANGE");
            const hasSubmitted = !!(await tx.qualificationSubmission.findFirst({
              where: { storeId: id, submittedAt: { not: null } },
              select: { id: true },
            }));
            for (const step of [1, 2, 3]) requiredMissing(before, after, step, true, hasSubmitted);
            await tx.storeProfile.update({
              where: { storeId: id },
              data: {
                lastEditedAt: now,
                lastEditActorType: "staff",
                lastEditActorId: staff.staff.id,
                lastEditClient: "admin",
                lockVersion: { increment: 1 },
                updatedAt: now,
              },
            });
            await refreshCompleteness(tx, id, now);
            await record(tx, identity.actor, metaOf(identity), {
              stream: "ops",
              category: "profile_edit",
              action: "profile.store.proxy_edit",
              summary: "代改门店档案",
              target: { type: "store_profile", id },
              entityId,
              storeId: id,
              onBehalfOfEntityId: entityId,
              reason: { code: input.reasonCode, text: input.note },
              before: oldValue,
              after: newValue,
              fields,
            });
            await deps.events.emit(tx, identity, {
              entityId,
              storeId: id,
              type: "store.profile.changed",
              aggregate: { type: "store", id },
              payload: { v: 1, storeId: id, entityId, fields, source: "staff_proxy" },
            });
            return projection(tx, staff, await snapshot(tx, id));
          },
        },
        options,
      );
      return decorate(previous, id, dto, options.idem?.replayed ?? false);
    },
  };
}
