import { account } from "@/lib/account-runtime";
import { newIdempotencyKey, request } from "@/lib/runtime";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { createInvoiceApi } from "./api";
import { createInvoiceModel } from "./model";
import { invoiceFiles } from "./document";
export const invoiceContext = () => {
  const c = useContextStore.getState();
  const role = account
    .snapshot()
    .me?.memberships.find((m) => m.stores.some((s) => s.storeId === c.currentStoreId))?.role;
  return JSON.stringify([
    useSessionStore.getState().accessToken,
    c.currentStoreId,
    c.contextRev,
    role ?? null,
  ]);
};
export function invoiceModel() {
  const scene = () =>
    process.env.TARO_ENV === "h5"
      ? (globalThis as { __LYX_BILLING_SHOT__?: string }).__LYX_BILLING_SHOT__
      : undefined;
  let offline: Promise<typeof request> | undefined;
  const call: typeof request = async (path, options) => {
    const name = scene();
    if (name?.startsWith("invoice-")) {
      offline ??= import("../../../../shots/invoice-fixtures").then((m) =>
        m.offlineInvoiceRequest(name),
      );
      return (await offline)(path, options);
    }
    return request(path, options);
  };
  return createInvoiceModel({
    api: createInvoiceApi(call),
    context: invoiceContext,
    key: () => newIdempotencyKey("invoice_apply"),
    prepare: () => account.start(),
    role: () =>
      account
        .snapshot()
        .me?.memberships.find((m) =>
          m.stores.some((s) => s.storeId === useContextStore.getState().currentStoreId),
        )?.role ?? null,
    files: {
      download: async (url, signal) =>
        scene()?.startsWith("invoice-")
          ? { statusCode: 200, tempFilePath: "invoice-shot.pdf" }
          : invoiceFiles.download(url, signal),
      open: async (path, format, name) => {
        if (scene()?.startsWith("invoice-")) {
          if (format !== "pdf") throw new Error("DOCUMENT_UNSUPPORTED");
          return;
        }
        return invoiceFiles.open(path, format, name);
      },
      remove: async (path) => {
        if (!scene()?.startsWith("invoice-")) await invoiceFiles.remove(path);
      },
    },
  });
}
