export interface UploadOptions {
  source: string;
  manifestSha256: string;
  appid: string;
  apiBaseUrl: string;
  imageId: string;
  artifacts: string;
  releaseEnv: string;
  releaseLog: string;
  key: string;
}
export function uploadArtifacts(
  options: UploadOptions,
  upload: (args: string[]) => Promise<void>,
): Promise<{ status: string; source: string; version: string; robot: number }>;
