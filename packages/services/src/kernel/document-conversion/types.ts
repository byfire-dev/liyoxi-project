export type DocumentRole = "source" | "pdf";
export type DocumentFailureReason =
  "invalid_document" | "unsupported_document" | "too_large" | "cancelled" | "deadline_exceeded";
export interface DocumentInput {
  readonly sourceBytes: Uint8Array | null;
  readonly pdfBytes: Uint8Array | null;
}
export type DocumentConversionResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly sourceSha256: string | null;
        readonly pdfSha256: string | null;
        readonly contentHtml: string | null;
        readonly htmlSha256: string | null;
        readonly similarityBp: number | null;
        readonly pdfTextIssue: "invalid_document" | "unsupported_document" | "no_text" | null;
      };
    }
  | {
      readonly ok: false;
      readonly reason: DocumentFailureReason;
      readonly role: DocumentRole | null;
    };
export class DocumentFailure extends Error {
  constructor(
    readonly reason: DocumentFailureReason,
    readonly role: DocumentRole | null = null,
  ) {
    super(reason);
    this.name = "DocumentFailure";
  }
}
export function documentFailure(
  error: unknown,
  role: DocumentRole | null = null,
): DocumentConversionResult {
  return error instanceof DocumentFailure
    ? { ok: false, reason: error.reason, role: error.role ?? role }
    : { ok: false, reason: "invalid_document", role };
}
