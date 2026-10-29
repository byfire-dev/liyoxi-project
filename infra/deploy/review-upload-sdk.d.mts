export function uploadReview(
  options: { project: string; appid: string; key: string; version: string },
  env?: NodeJS.ProcessEnv,
): Promise<void>;
