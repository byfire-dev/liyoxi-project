import { z } from "zod";
// Internal archival evidence only; no HTTP exposure and no live business row values.
export const LegacyEvidenceSchema = z
  .object({
    account: z
      .object({
        addon_available_qty: z.number().int().safe(),
        created_at: z.string(),
        current_subscription_term_id: z.string(),
        entity_id: z.string(),
        next_due_at: z.string(),
        plan_available_qty: z.number().int().safe(),
        sub_status: z.string(),
        updated_at: z.string(),
      })
      .passthrough(),
    activationOutbox: z.array(
      z
        .object({
          aggregate_id: z.string(),
          aggregate_type: z.string(),
          created_at: z.string(),
          dedupe_key: z.string(),
          entity_id: z.string(),
          event_type: z.string(),
          id: z.string(),
          occurred_at: z.string(),
          payload: z
            .object({
              endsAt: z.string(),
              entityId: z.string(),
              planId: z.string(),
              sourceBillingOrderId: z.string(),
              startsAt: z.string(),
              termId: z.string(),
              v: z.number().int().safe(),
            })
            .passthrough(),
          seq: z.union([z.string().regex(/^[0-9]+$/), z.number().int().safe()]),
        })
        .passthrough(),
    ),
    baselineSha: z.string(),
    entity: z.object({ created_at: z.string(), id: z.string() }).passthrough(),
    entries: z.array(
      z
        .object({
          biz_date: z.string(),
          created_at: z.string(),
          entity_id: z.string(),
          from_bucket: z.string(),
          id: z.string(),
          ledger_operation_id: z.string(),
          lot_kind: z.string(),
          occurred_at: z.string(),
          plan_id: z.string().nullable(),
          point_hold_id: z.string().nullable(),
          point_lot_id: z.string(),
          qty: z.number().int().safe(),
          seq: z.union([z.string().regex(/^[0-9]+$/), z.number().int().safe()]),
          to_bucket: z.string(),
        })
        .passthrough(),
    ),
    event: z
      .object({
        actor_type: z.string(),
        billing_order_id: z.string(),
        biz_date: z.string(),
        client: z.string().nullable(),
        created_at: z.string(),
        entity_id: z.string(),
        from_plan_id: z.null(),
        from_plan_revision_id: z.null(),
        id: z.string(),
        occurred_at: z.string(),
        payload: z.unknown(),
        seq: z.union([z.string().regex(/^[0-9]+$/), z.number().int().safe()]),
        subscription_term_id: z.string(),
        to_plan_id: z.string(),
        to_plan_revision_id: z.string(),
        type: z.string(),
      })
      .passthrough(),
    events: z.array(
      z
        .object({
          actor_type: z.string(),
          billing_order_id: z.string(),
          biz_date: z.string(),
          client: z.string().nullable(),
          created_at: z.string(),
          entity_id: z.string(),
          from_plan_id: z.null(),
          from_plan_revision_id: z.null(),
          id: z.string(),
          occurred_at: z.string(),
          payload: z.unknown(),
          seq: z.union([z.string().regex(/^[0-9]+$/), z.number().int().safe()]),
          subscription_term_id: z.string(),
          to_plan_id: z.string(),
          to_plan_revision_id: z.string(),
          type: z.string(),
        })
        .passthrough(),
    ),
    grants: z.array(
      z
        .object({
          created_at: z.string(),
          due_at: z.string(),
          due_date: z.string(),
          entity_id: z.string(),
          granted_at: z.string().nullable(),
          id: z.string(),
          month_no: z.number().int().safe(),
          plan_id: z.string(),
          plan_revision_id: z.string(),
          point_lot_id: z.string().nullable(),
          points: z.number().int().safe(),
          status: z.string(),
          subscription_term_id: z.string(),
          updated_at: z.string(),
          value_fen: z.number().int().safe(),
        })
        .passthrough(),
    ),
    guardCounts: z
      .object({
        dailyRows: z.number().int().safe(),
        extensions: z.number().int().safe(),
        refundRequests: z.number().int().safe(),
        refundTxns: z.number().int().safe(),
        valuationRows: z.number().int().safe(),
      })
      .passthrough(),
    lots: z.array(
      z
        .object({
          adjusted_out_qty: z.number().int().safe(),
          available_qty: z.number().int().safe(),
          biz_date: z.string(),
          consumed_qty: z.number().int().safe(),
          converted_out_qty: z.number().int().safe(),
          cost_basis_fen: z.number().int().safe(),
          created_at: z.string(),
          entity_id: z.string(),
          expired_qty: z.number().int().safe(),
          expires_at: z.string().nullable(),
          granted_at: z.string(),
          held_qty: z.number().int().safe(),
          id: z.string(),
          kind: z.string(),
          origin_point_ledger_entry_id: z.null(),
          origin_point_lot_id: z.null(),
          original_qty: z.number().int().safe(),
          plan_id: z.string().nullable(),
          plan_revision_id: z.string().nullable(),
          revoked_qty: z.number().int().safe(),
          source_id: z.string(),
          source_no: z.number().int().safe(),
          source_type: z.string(),
          subscription_term_id: z.string().nullable(),
          updated_at: z.string(),
        })
        .passthrough(),
    ),

    operations: z.array(
      z
        .object({
          addon_delta_qty: z.number().int().safe(),
          biz_date: z.string(),
          created_at: z.string(),
          entity_id: z.string(),
          held_after_qty: z.number().int().safe(),
          id: z.string(),
          occurred_at: z.string(),
          op_key: z.string(),
          op_type: z.string(),
          plan_delta_qty: z.number().int().safe(),
          ref_id: z.string(),
          ref_type: z.string(),
          seq: z.union([z.string().regex(/^[0-9]+$/), z.number().int().safe()]),
          spendable_after_qty: z.number().int().safe(),
        })
        .passthrough(),
    ),
    orders: z.array(
      z
        .object({
          amount_fen: z.number().int().safe(),
          applied_at: z.string(),
          channel: z.string(),
          content_snapshot: z.unknown(),
          created_at: z.string(),
          entity_id: z.string(),
          fulfilled_at: z.string(),
          fulfillment_result: z.unknown(),
          fulfillment_status: z.string(),
          id: z.string(),
          paid_amount_fen: z.number().int().safe(),
          paid_at: z.string(),
          paid_payment_txn_id: z.string(),
          refunded_amount_fen: z.number().int().safe(),
          source: z.string(),
          status: z.string(),
          type: z.string(),
          updated_at: z.string(),
        })
        .passthrough(),
    ),
    payments: z.array(
      z
        .object({
          amount_fen: z.number().int().safe(),
          applied_at: z.string(),
          billing_order_id: z.string(),
          channel: z.string(),
          channel_amount_fen: z.number().int().safe(),
          channel_success_at: z.string(),
          created_at: z.string(),
          entity_id: z.string(),
          id: z.string(),
          refunded_fen: z.number().int().safe(),
          status: z.string(),
          updated_at: z.string(),
        })
        .passthrough(),
    ),
    sourceSha: z.string(),
    terms: z.array(
      z
        .object({
          activated_at: z.string(),
          anchor_day: z.number().int().safe(),
          created_at: z.string(),
          discount_bp: z.number().int().safe(),
          end_date: z.string(),
          ended_at: z.null(),
          ends_at: z.string(),
          entity_id: z.string(),
          extended_days: z.number().int().safe(),
          has_monthly_report: z.boolean(),
          id: z.string(),
          initial_plan_revision_id: z.string(),
          max_members: z.number().int().safe(),
          max_stores: z.number().int().safe(),
          monthly_equiv_fen: z.number().int().safe(),
          monthly_points: z.number().int().safe(),
          months: z.number().int().safe(),
          origin: z.string(),
          plan_id: z.string(),
          plan_revision_id: z.string(),
          price_total_fen: z.number().int().safe(),
          production_model: z.string(),
          refund_request_id: z.null(),
          refund_rule: z.null(),
          refunded_at: z.null(),
          schedule_priority: z.string(),
          source_billing_order_id: z.string(),
          start_date: z.string(),
          starts_at: z.string(),
          status: z.string(),
          term_no: z.number().int().safe(),
          updated_at: z.string(),
        })
        .passthrough(),
    ),
    valuationPolicy: z
      .object({
        created_at: z.string(),
        rule: z
          .object({ costBasis: z.string(), remainder: z.string(), rounding: z.string() })
          .passthrough(),
        version_no: z.number().int().safe(),
      })
      .passthrough(),
  })
  .passthrough();
export type LegacyEvidence = z.infer<typeof LegacyEvidenceSchema>;
