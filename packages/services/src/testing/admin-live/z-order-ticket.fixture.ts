import { calendarDate, addDays } from "@liyoxi/shared/time";
import { DramaSnapshotSchema } from "@liyoxi/contract";
import { createIdentityContext } from "../../kernel/index.js";
import { createTickets, prepareTicketAssignees } from "../../delivery/index.js";
import { createPublish } from "../../publish/index.js";
import { createSla } from "../../sla/index.js";
import { issueActivationCode, base32Decode, hotp, totpStep } from "../../staff/index.js";
import { loadKeyring, openField } from "../../security/index.js";
import type { AdminLiveFixture } from "./context.js";
/** 只在隔离live数据库：工厂准备订单/已知快照，实际createTickets产生工单和方案。复用旧员工避免改变原staff验收。 */
const fixture: AdminLiveFixture = async ({ make, runtime }) => {
  const manager = await runtime.tx.run((tx) =>
    tx.staff.findFirstOrThrow({
      where: { name: "演练交付", staffRoleKey: "delivery_manager", status: "active" },
    }),
  );
  const phone = openField(loadKeyring(runtime.env), "staff.phone_enc", manager.phoneEnc);
  const password = "Liyoxi-2026-ok",
    meta = { ip: "127.0.0.1", userAgent: "lyxtest W119 live" };
  const issued = await runtime.tx.run((tx) =>
    issueActivationCode(tx, {
      staffId: manager.id,
      purpose: "activate",
      delivery: "manual",
      createdByStaffId: null,
      now: runtime.clock.now(),
    }),
  );
  const active = await runtime.staffAuth.activate({ phone, activationCode: issued.code });
  if (!active.ticket) throw new Error("演练员工激活票据缺失");
  const set = await runtime.staffAuth.setPassword({
    ticket: active.ticket,
    newPassword: password,
    meta,
  });
  if (!set.ticket) throw new Error("演练员工绑定票据缺失");
  const enrolled = await runtime.staffAuth.enrollTotp({ ticket: set.ticket });
  const signed = await runtime.staffAuth.confirmTotp({
    ticket: enrolled.ticket,
    code: hotp(base32Decode(enrolled.secret), totpStep(runtime.clock.now())),
    meta,
  });
  const admin = await runtime.tx.run((tx) =>
    tx.staff.findFirstOrThrow({ where: { staffRoleKey: "super_admin", status: "active" } }),
  );
  const version = await runtime.tx.run((tx) =>
    tx.agreementVersion.findFirst({ where: { agreementKey: "custom_license", status: "active" } }),
  );
  if (!version)
    await make.agreementVersion({
      createdByStaffId: admin.id,
      effectiveAt: new Date(runtime.clock.now().getTime() - 60_000),
    });
  const orders = [];
  for (const [index, status] of ["pending_start", "producing", "ended"].entries()) {
    const merchant = await make.subscribedMerchant(),
      name = `订单演练门店${index + 1}`;
    await runtime.tx.run((tx) =>
      tx.store.update({ where: { id: merchant.store.id }, data: { name } }),
    );
    const order = await make.dramaOrder({
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      subscriptionTermId: merchant.term.id,
      status,
      totalChargePoints: 1200,
      itemCount: 1,
    });
    const drama = await make.drama({
      title: `订单演练短剧${index + 1}`,
      totalEpisodes: 12,
      dramaClass: "class_1",
      createdByStaffId: admin.id,
    });
    const snapshot = DramaSnapshotSchema.parse({
      dramaId: drama.id,
      title: drama.title,
      totalEpisodes: drama.totalEpisodes,
      dramaClass: drama.dramaClass,
      genreCodes: drama.genreCodes,
      permits: [],
      licenseEndDate: addDays(calendarDate(runtime.clock.now()), 365),
      posterFileId: null,
      allowedPlacements: drama.allowedPlacements,
      isAiGenerated: drama.isAiGenerated,
    });
    const item = await make.orderItem({
      dramaOrderId: order.id,
      dramaId: drama.id,
      phase: status,
      episodeCount: 12,
      listPricePoints: 1200,
      chargePoints: 1200,
      dramaSnapshot: snapshot,
    });
    let ticket: { deliveryTicketIds: string[] } | undefined;
    if (status === "producing") {
      const ctx = createIdentityContext({
        actor: { type: "system", job: "lyxtest.w119_fixture" },
        entityId: order.entityId,
        storeId: order.storeId,
      });
      ticket = await runtime.tx.run(async (tx) => {
        await prepareTicketAssignees(tx, order.id);
        return createTickets(
          tx,
          { ...runtime, sla: createSla({ clock: runtime.clock, assembly: runtime.assembly }) },
          ctx,
          { dramaOrderId: order.id },
        );
      });
    }
    orders.push({
      id: order.id,
      orderNo: order.orderNo,
      name,
      status,
      itemId: item.id,
      ticketId: ticket?.deliveryTicketIds[0] ?? null,
    });
  }
  const publish = createPublish(runtime),
    accounts = [];
  for (let index = 1; index <= 2; index++) {
    const merchant = await make.merchant({ verified: true }),
      name = `账号演练门店${index}`;
    await runtime.tx.run((tx) =>
      tx.store.update({ where: { id: merchant.store.id }, data: { name } }),
    );
    const file = await make.fileObject({
      category: "channel_screenshot",
      bucket: "asset",
      scopeType: "store",
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      uploadActorType: "merchant",
      uploadActorId: merchant.user.id,
      uploadClient: "weapp",
    });
    const card = await publish.bind(
      {
        ctx: createIdentityContext({
          actor: { type: "merchant", id: merchant.user.id, client: "weapp", role: "owner" },
          entityId: merchant.entity.id,
          storeId: merchant.store.id,
        }),
        membership: {
          memberId: merchant.owner.id,
          entityId: merchant.entity.id,
          storeId: merchant.store.id,
          role: "owner",
          storeMode: "active",
        },
      },
      {
        platform: "douyin",
        accountName: `账号演练${index}`,
        accountUid: `lyx_demo_${index}`,
        accountType: "none",
        screenshotFileIds: [file.id],
      },
    );
    const round = await runtime.tx.run((tx) =>
      tx.channelAccountSubmission.findFirstOrThrow({
        where: { channelAccountId: card.channelAccountId },
        orderBy: { roundNo: "desc" },
      }),
    );
    accounts.push({ id: round.id, name: `账号演练${index}`, storeName: name, fileId: file.id });
  }
  return {
    orders,
    accounts,
    manager: {
      id: manager.id,
      name: manager.name,
      phone,
      password,
      recoveryCode: signed.recoveryCodes[0],
    },
  };
};
export default fixture;
