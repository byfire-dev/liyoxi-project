export interface UploadInput {
  root: string;
  source: string;
  tag: string;
  token?: string;
  configuration?: string;
}
export interface UploadConfig {
  organization: string;
  projects: Record<"api" | "worker" | "admin" | "portal" | "weapp", string>;
}
export function uploadConfiguration(raw: unknown): UploadConfig;
export function uploadArguments(component: string, tag: string): string[];
export function downloadVerified(
  lock: { url: string; sha256: string },
  file: string,
  fetcher?: typeof fetch,
): Promise<void>;
export interface CommandOptions {
  cwd: string;
  env: Record<string, string>;
  timeout: number;
}
export function uploadMaps(
  input: UploadInput,
  adapters?: {
    testPlatform?: "linux-x64";
    install?: typeof downloadVerified;
    run?: (file: string, args: string[], options: CommandOptions) => Promise<string>;
  },
): Promise<{
  status: "unconfigured" | "uploaded";
  uploadedComponents: number;
  pairs?: number;
  source?: string;
  tag?: string;
  cli?: string;
}>;
