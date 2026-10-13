import type {
  ContactPatch,
  QualificationDocCreateBody,
  QualificationDocPatch,
  QualificationDraftPatch,
  QualificationDiscardBody,
  QualificationSubmitBody,
  StoreProfileBasicPatch,
  StoreProfileMediaPatch,
  StoreProfileServicePatch,
} from "@liyoxi/contract";
import { storeScope } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError, createThreePhaseRunner } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { createAdminProfile } from "./admin.js";
import { assignDeliveryManager } from "./assign-manager.js";
import type { ProfileDeps, ProfileViewer, WriteOptions } from "./context.js";
import { createDoc, docPrecheck, updateDoc } from "./documents.js";
import { saveDraft } from "./draft.js";
import { discardDraft, removeDocument } from "./draft-lifecycle.js";
import { assertProfileComplete, industryOpen, storeGate, storeLocation } from "./gate.js";
import { withQualificationCall } from "./qualification-kind.js";
import { overview, assetOverviewActor } from "./read.js";
import { snapshot } from "./repo.js";
import { submitQualification } from "./submit.js";
import { assertOwner, assertVersion, checkContent, validateBasics } from "./validate.js";
import { attachUrls, basicView, mediaView, qualificationView, serviceView } from "./views.js";
import { saveBasic, saveMedia, saveService } from "./write.js";
import { createContactCode, updateContact } from "./contact.js";
import { recognitionInput, recognitionIntent } from "./recognition.js";
import { qualificationRecords, qualificationDocumentUrl } from "./qualification-read.js";
import type { CursorQuerySchema, z } from "@liyoxi/contract";

export function createProfile(deps: ProfileDeps) {
  const read = async <T>(
    viewer: ProfileViewer,
    view: (tx: Tx, s: Awaited<ReturnType<typeof snapshot>>) => Promise<T>,
  ) =>
    attachUrls(
      deps,
      await deps.tx.run(async (tx) => view(tx, await snapshot(tx, viewer.membership.storeId))),
    );
  const write = async <T>(
    viewer: ProfileViewer,
    fn: (tx: Tx) => Promise<T>,
    options: WriteOptions = {},
  ) => {
    assertOwner(viewer);
    const raw = await deps.tx.run(fn, options);
    return attachUrls(
      deps,
      { ...raw, replayed: options.idem?.replayed ?? false },
      options.idem?.replayed,
    );
  };
  const checkedWrite = async <T>(
    viewer: ProfileViewer,
    version: number,
    fields: Record<string, string | null | undefined>,
    fn: (tx: Tx) => Promise<T>,
    options: WriteOptions = {},
  ) => {
    assertOwner(viewer);
    const raw = await createThreePhaseRunner(deps).run(
      {
        claim: async (tx) => {
          const s = await snapshot(tx, viewer.membership.storeId);
          if (s.store.lifecycle !== "active" || s.store.entity.lifecycle !== "active")
            throw new AppError("STORE_ARCHIVED");
          assertVersion(s.profile?.lockVersion ?? 0, version);
        },
        external: () => checkContent(deps, viewer, fields),
        settle: (tx) => fn(tx),
      },
      options,
    );
    return attachUrls(
      deps,
      { ...raw, replayed: options.idem?.replayed ?? false },
      options.idem?.replayed,
    );
  };
  const qview = async (tx: Tx, viewer: ProfileViewer) =>
    qualificationView(
      tx,
      deps,
      await snapshot(tx, viewer.membership.storeId),
      viewer.principal.merchantUserId,
    );
  async function decisionRound(tx: Tx, id: string, staff?: StaffContext) {
    const round = await tx.qualificationSubmission.findFirst({
      where: { id, ...(staff ? { store: storeScope(staff.scope) } : {}) },
    });
    if (!round || !round.approvalRequestId) throw new AppError("NOT_FOUND");
    return round;
  }
  return {
    admin: createAdminProfile(deps),
    get: async (viewer: ProfileViewer) => {
      const value = await deps.tx.run((tx) => overview(tx, deps, viewer));
      if (!deps.media.assets) return value;
      const recent = [];
      for (const row of value.assets.recent)
        recent.push(await deps.media.assets.decorate(assetOverviewActor(viewer), row));
      return { ...value, assets: { ...value.assets, recent } };
    },
    basic: (viewer: ProfileViewer) => read(viewer, basicView),
    media: (viewer: ProfileViewer) => read(viewer, mediaView),
    service: (viewer: ProfileViewer) => read(viewer, serviceView),
    qualification: (viewer: ProfileViewer) => deps.tx.run((tx) => qview(tx, viewer)),
    qualificationHistory: (viewer: ProfileViewer, query: z.input<typeof CursorQuerySchema>) =>
      deps.tx.run((tx) => qualificationRecords(tx, deps, viewer, query)),
    documentUrl: (viewer: ProfileViewer, id: string) => qualificationDocumentUrl(deps, viewer, id),
    async updateBasic(
      viewer: ProfileViewer,
      input: StoreProfileBasicPatch,
      options?: WriteOptions,
    ) {
      assertOwner(viewer);
      return checkedWrite(
        viewer,
        input.lockVersion,
        {
          brandName: input.brandName,
          storeName: input.storeName,
          "address.detail": input.address?.detail,
          brandIntro: input.brandIntro,
        },
        async (tx) => basicView(tx, await saveBasic(tx, deps, viewer, input)),
        options,
      );
    },
    updateMedia: (viewer: ProfileViewer, input: StoreProfileMediaPatch, options?: WriteOptions) =>
      write(viewer, async (tx) => mediaView(tx, await saveMedia(tx, deps, viewer, input)), options),
    async updateService(
      viewer: ProfileViewer,
      input: StoreProfileServicePatch,
      options?: WriteOptions,
    ) {
      assertOwner(viewer);
      const texts: Record<string, string | null | undefined> = {
        promoText: input.promoText,
        groupBuyText: input.groupBuyText,
        sellingNote: input.sellingNote,
      };
      for (const [i, item] of (input.serviceItems ?? []).entries()) {
        texts[`serviceItems.${i}.name`] = item.name;
        texts[`serviceItems.${i}.intro`] = item.intro;
      }
      return checkedWrite(
        viewer,
        input.lockVersion,
        texts,
        async (tx) => serviceView(tx, await saveService(tx, deps, viewer, input)),
        options,
      );
    },
    updateQualification: (
      viewer: ProfileViewer,
      input: QualificationDraftPatch,
      options?: WriteOptions,
    ) =>
      write(
        viewer,
        async (tx) => {
          await saveDraft(tx, deps, viewer, input);
          return qview(tx, viewer);
        },
        options,
      ),
    async updateContact(viewer: ProfileViewer, input: ContactPatch, options?: WriteOptions) {
      return updateContact(deps, viewer, input, options);
    },
    createContactCode: (viewer: ProfileViewer, phone: string, options?: WriteOptions) =>
      createContactCode(deps, viewer, phone, options),
    submit: (viewer: ProfileViewer, input: QualificationSubmitBody, options?: WriteOptions) =>
      write(
        viewer,
        async (tx) => {
          await submitQualification(tx, deps, viewer, input);
          return qview(tx, viewer);
        },
        options,
      ),
    async createDocument(
      viewer: ProfileViewer,
      input: QualificationDocCreateBody,
      options: WriteOptions = {},
    ) {
      assertOwner(viewer);
      const raw = await createThreePhaseRunner(deps).run(
        {
          claim: async (tx) => {
            await docPrecheck(tx, viewer, input);
            return recognitionIntent(tx, deps, viewer, input);
          },
          external: async () =>
            deps.media.ocr ? deps.media.ocr.recognize(recognitionInput(viewer, input)) : null,
          settle: (tx, ocrResultId, intent) =>
            createDoc(tx, deps, viewer, input, { ocrResultId, intent }),
        },
        options,
      );
      return {
        ...raw,
        ...(options.idem?.replayed ? { recognized: null, submitted: null } : {}),
        replayed: options.idem?.replayed ?? false,
      };
    },
    updateDocument: (
      viewer: ProfileViewer,
      id: string,
      input: QualificationDocPatch,
      options?: WriteOptions,
    ) => write(viewer, (tx) => updateDoc(tx, deps, viewer, id, input), options),
    removeDocument: (viewer: ProfileViewer, id: string, options?: WriteOptions) =>
      write(viewer, (tx) => removeDocument(tx, deps, viewer, id), options),
    discardQualification: (
      viewer: ProfileViewer,
      input: QualificationDiscardBody,
      options?: WriteOptions,
    ) =>
      write(
        viewer,
        async (tx) => {
          await discardDraft(tx, deps, viewer, input);
          return qview(tx, viewer);
        },
        options,
      ),
    storeGate: (storeId: string) => deps.tx.run((tx) => storeGate(tx, storeId)),
    assertProfileComplete: (storeId: string) =>
      deps.tx.run((tx) => assertProfileComplete(tx, storeId)),
    industryOpen: (storeId: string) => deps.tx.run((tx) => industryOpen(tx, storeId)),
    storeLocation: (storeId: string) => deps.tx.run((tx) => storeLocation(tx, storeId)),
    async validateStoreBasics(viewer: ProfileViewer, input: StoreProfileBasicPatch) {
      await checkContent(deps, viewer, {
        storeName: input.storeName,
        "address.detail": input.address?.detail,
      });
      await deps.tx.run((tx) => validateBasics(tx, input, null, true));
    },
    assignDeliveryManager: (
      tx: Tx,
      ctx: IdentityContext,
      input: Parameters<typeof assignDeliveryManager>[3],
    ) => assignDeliveryManager(tx, deps, ctx, input),
    approve: (
      ctx: IdentityContext,
      id: string,
      input: {
        staff?: StaffContext;
        lockVersion: number;
        confirm: { roundNo: number };
        mode?: "normal" | "override";
        overrideReason?: string;
        confirmChecks?: readonly string[];
      },
      options?: WriteOptions,
    ) =>
      deps.tx.run(async (tx) => {
        const round = await decisionRound(tx, id, input.staff);
        return withQualificationCall(
          tx,
          deps,
          ctx,
          () =>
            deps.approval.approve(tx, ctx, {
              approvalId: round.approvalRequestId!,
              staff: input.staff,
              lockVersion: input.lockVersion,
              confirmChecks: input.confirmChecks,
              note: input.mode === "override" ? input.overrideReason : undefined,
              ...(input.mode === "override"
                ? {
                    audit: {
                      stream: "activity" as const,
                      category: "review" as const,
                      action: "approval.request.approve",
                      summary: "放行资质审核",
                      target: { type: "approval_request", id: round.approvalRequestId! },
                      entityId: round.entityId,
                      storeId: round.storeId,
                      reason: { code: "override", text: input.overrideReason },
                      meta: {
                        approvalStatus: "approved",
                        approvalKind: "qualification",
                        rule: "override",
                      },
                    },
                  }
                : {}),
              args: input,
            }),
          input.staff,
        );
      }, options),
    reject: (
      ctx: IdentityContext,
      id: string,
      input: {
        staff?: StaffContext;
        reasonCodes: readonly string[];
        note: string;
        confirm?: {
          roundNo?: number;
          pendingStartOrderCount?: number;
          pendingAssignAdCount?: number;
          heldPoints?: number;
        };
        rejectedDocIds?: readonly string[];
        isFinal?: boolean;
      },
      options?: WriteOptions,
    ) =>
      deps.tx.run(async (tx) => {
        const round = await decisionRound(tx, id, input.staff);
        return withQualificationCall(tx, deps, ctx, () =>
          deps.approval.reject(tx, ctx, {
            approvalId: round.approvalRequestId!,
            staff: input.staff,
            note: input.note,
            reasonCodes: input.reasonCodes,
            args: input,
          }),
        );
      }, options),
  };
}
export type Profile = ReturnType<typeof createProfile>;
