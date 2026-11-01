import { DramaSnapshotSchema } from "@liyoxi/contract";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { createIdentityContext, isAppError } from "../../kernel/index.js";
import { createTickets, prepareTicketAssignees } from "../../delivery/index.js";
import { createSla } from "../../sla/index.js";
import { base32Decode, hotp, issueActivationCode, totpStep } from "../../staff/index.js";
import { loadKeyring, openField } from "../../security/index.js";
import { assertDeliveryLiveEnvironment } from "./delivery-known-media.js";
import { sampleStaffContext } from "../approval.js";
import { prepareDeliveryLiveFixture } from "./zz-delivery-flow.fixture.js";
import type { AdminLiveFixture } from "./context.js";

/** Independent identity inputs only; actual activation/password/TOTP produce three real staff sessions. */
const fixture: AdminLiveFixture = async ({ runtime, make }) => {
  let phase = "scope";
  try {
    const live = assertDeliveryLiveEnvironment(runtime.env),
      { runId } = live,
      startedAt = runtime.clock.now().toISOString();
    if (runtime.providers.storage.status !== "fake") throw new Error("W513仅接受隔离本地替身环境");
    // An ordinary historical producing input. Cancellation is prepared only on demand by the
    // scoped W513 CLI, so every other live file keeps its original initial approval collection.
    phase = "historical_ticket_inputs";
    const admin = await runtime.tx.run((tx) =>
      tx.staff.findFirstOrThrow({ where: { staffRoleKey: "super_admin", status: "active" } }),
    );
    const merchant = await make.subscribedMerchant();
    await runtime.tx.run((tx) =>
      tx.store.update({
        where: { id: merchant.store.id },
        data: { name: `W513暂停门店-${runId}` },
      }),
    );
    const order = await make.dramaOrder({
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      placedByUserId: merchant.user.id,
      subscriptionTermId: merchant.term.id,
      status: "producing",
      totalChargePoints: 100,
      itemCount: 1,
    });
    const drama = await make.drama({
      title: `W513暂停短剧-${runId}`,
      totalEpisodes: 2,
      dramaClass: "class_1",
      isAiGenerated: false,
      createdByStaffId: admin.id,
    });
    const item = await make.orderItem({
      dramaOrderId: order.id,
      dramaId: drama.id,
      phase: "producing",
      episodeCount: 2,
      listPricePoints: 100,
      chargePoints: 100,
      dramaSnapshot: DramaSnapshotSchema.parse({
        dramaId: drama.id,
        title: drama.title,
        totalEpisodes: 2,
        dramaClass: drama.dramaClass,
        genreCodes: drama.genreCodes,
        permits: [],
        licenseEndDate: addDays(calendarDate(runtime.clock.now()), 365),
        posterFileId: null,
        allowedPlacements: drama.allowedPlacements,
        isAiGenerated: false,
      }),
    });
    const deps = { ...runtime, sla: createSla(runtime) };
    phase = "create_tickets";
    const created = await runtime.tx.run(async (tx) => {
      await prepareTicketAssignees(tx, order.id);
      return createTickets(
        tx,
        deps,
        createIdentityContext({
          actor: { type: "system", job: "lyxtest.w513_fixture" },
          entityId: merchant.entity.id,
          storeId: merchant.store.id,
        }),
        { dramaOrderId: order.id },
      );
    });
    const ticketId = created.deliveryTicketIds[0]!;
    const paused = await runtime.tx.run((tx) =>
      tx.deliveryTicket.findUniqueOrThrow({ where: { id: ticketId } }),
    );
    const manager = await runtime.tx.run((tx) =>
      tx.staff.findFirstOrThrow({
        where: { name: "演练交付", staffRoleKey: "delivery_manager", status: "active" },
      }),
    );
    const actors = [];
    for (const role of ["editor", "publisher", "finance"] as const) {
      const group = await runtime.tx.run((tx) =>
        tx.staffGroup.findFirstOrThrow({ where: { staffRoleKey: role, isDefault: true } }),
      );
      const row = await make.staff({
        name:
          role === "editor"
            ? "W513交付剪辑师"
            : role === "publisher"
              ? "W513交付发布员"
              : "W513取消审批财务",
        staffRoleKey: role,
        staffGroupId: group.id,
        // In-service status is separate from credentials/activatedAt, produced below by real activation.
        status: "active",
      });
      const phone = openField(loadKeyring(runtime.env), "staff.phone_enc", row.phoneEnc),
        password = "Liyoxi-W513-2026-ok";
      const meta = { ip: "127.0.0.1", userAgent: `lyxtest W513 ${runId}` };
      const issued = await runtime.tx.run((tx) =>
        issueActivationCode(tx, {
          staffId: row.id,
          purpose: "activate",
          delivery: "manual",
          createdByStaffId: null,
          now: runtime.clock.now(),
        }),
      );
      phase = `activate_${role}`;
      const active = await runtime.staffAuth.activate({ phone, activationCode: issued.code });
      if (!active.ticket) throw new Error("W513缺少真实激活票据");
      phase = `password_${role}`;
      const set = await runtime.staffAuth.setPassword({
        ticket: active.ticket,
        newPassword: password,
        meta,
      });
      if (!set.ticket) throw new Error("W513缺少真实绑定票据");
      phase = `totp_${role}`;
      const enrolled = await runtime.staffAuth.enrollTotp({ ticket: set.ticket });
      const signed = await runtime.staffAuth.confirmTotp({
        ticket: enrolled.ticket,
        code: hotp(base32Decode(enrolled.secret), totpStep(runtime.clock.now())),
        meta,
      });
      const current = await runtime.tx.run((tx) =>
        tx.staff.findUniqueOrThrow({ where: { id: row.id } }),
      );
      if (current.status !== "active" || !signed.recoveryCodes?.length)
        throw new Error("W513员工实际激活未完成");
      const acting = await runtime.tx.run((tx) =>
        sampleStaffContext(tx, admin.id, { stepUpAt: runtime.clock.now() }),
      );
      phase = `pools_${role}`;
      if (role !== "finance")
        await runtime.staffManagement.replacePools(
          acting,
          createIdentityContext({ actor: { type: "staff", id: admin.id, client: "admin" } }),
          row.id,
          { memberships: [{ pool: role }], lockVersion: current.lockVersion },
        );
      actors.push({
        staffId: row.id,
        name: row.name,
        roleKey: role,
        status: current.status,
        phone,
        password,
        recoveryCodes: signed.recoveryCodes,
      });
    }
    phase = "delivery_flow_inputs";
    const flow = await prepareDeliveryLiveFixture(
      { runtime, make },
      { prefix: "W513工单", loginPrefix: "w513" },
    );
    // P2 gets a distinct empty merchant scope. No order, pending approval or ledger success is
    // seeded here: the new spec explicitly asks its owned CLI to prepare real order writers.
    phase = "aftersales_identity_inputs";
    const aftersalesMerchant = await make.merchant({ verified: true });
    await runtime.tx.run(async (tx) => {
      await tx.entity.update({
        where: { id: aftersalesMerchant.entity.id },
        data: { name: `W513售后主体-${runId}` },
      });
      await tx.store.update({
        where: { id: aftersalesMerchant.store.id },
        data: { name: `W513售后门店-${runId}`, deliveryManagerId: manager.id },
      });
    });
    return {
      flow,
      editor: actors[0],
      publisher: actors[1],
      aftersales: {
        finance: actors[2],
        scope: {
          ...live,
          startedAt,
          entityId: aftersalesMerchant.entity.id,
          storeId: aftersalesMerchant.store.id,
          merchantUserId: aftersalesMerchant.user.id,
          memberId: aftersalesMerchant.owner.id,
          requesterId: admin.id,
          financeId: actors[2]!.staffId,
        },
      },
      paused: {
        ticketId,
        ticketNo: paused.ticketNo,
        scope: {
          ...live,
          startedAt,
          entityId: merchant.entity.id,
          storeId: merchant.store.id,
          orderId: order.id,
          itemId: item.id,
          ticketId,
          uploaderId: admin.id,
          managerId: manager.id,
        },
      },
    };
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ evt: "w513.fixture.failed", phase, symbol: isAppError(error) ? error.error : "non_application" })}\n`,
    );
    throw error;
  }
};
export default fixture;
