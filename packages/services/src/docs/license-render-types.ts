import type { LicenseLetterSnapshot } from "./license-facts.js";
import type { LicenseRenderIssue } from "./license-render-result.js";

export type LicensePdfRenderResult =
  | { readonly ok: true; readonly value: { readonly pdf: Uint8Array } }
  | { readonly ok: false; readonly reason: "missing_glyph"; readonly issue: LicenseRenderIssue }
  | {
      readonly ok: false;
      readonly reason: "unconfigured" | "unavailable" | "rejected" | "aborted" | "closed";
    };
export interface LicensePdfRenderer {
  readonly configured: boolean;
  render(input: {
    readonly snapshot: LicenseLetterSnapshot;
    readonly templateVersion: string;
    readonly contentFingerprint: string;
    readonly signal?: AbortSignal;
  }): Promise<LicensePdfRenderResult>;
  close(): Promise<void>;
}
