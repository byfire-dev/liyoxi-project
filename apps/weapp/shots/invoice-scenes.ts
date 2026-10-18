export const INVOICE_SCENES = [
  { name: "invoice-empty", route: "sub/billing/invoices/index" },
  { name: "invoice-apply-error", route: "sub/billing/invoices/index" },
  { name: "invoice-pending", route: "sub/billing/invoices/index" },
  { name: "invoice-issued", route: "sub/billing/invoices/index" },
] as const;
