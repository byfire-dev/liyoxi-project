import type { UploadOptions } from "./weapp-artifact.mjs";
export const REVIEW_TAG: RegExp;
export interface ReviewUploadOptions extends UploadOptions {
  tag: string;
  enabled: string;
  freeze: string;
}
export function uploadReviewArtifacts(
  options: ReviewUploadOptions,
  upload: (options: {
    project: string;
    appid: string;
    key: string;
    version: string;
  }) => Promise<void>,
): Promise<{
  status: string;
  source: string;
  tag: string;
  version: string;
  clientVersion: string;
  robot: number;
}>;
