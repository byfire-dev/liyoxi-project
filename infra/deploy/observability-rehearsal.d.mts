// 原生Node演练助手的静态测试边界；不扩展生产配置或Provider协议。
export const ERROR_HOST: string;
export const WRONG_HOST: string;
export function assertProject(project: string): void;
export function publicDsn(index: number): string;
export function upstreamDsn(index: number): string;
interface ErrorRequestOptions {
  method: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs?: number;
}
type ErrorRequest = (
  host: string,
  path: string,
  options: ErrorRequestOptions,
) => Promise<{ status: number }>;
export function waitForGatewayReady(
  request: ErrorRequest,
  host: string,
  phase: "default" | "configured",
): Promise<void>;
export function envelope(index: number, eventId: string): string;
export function receive(project: string): void;
export function verifyReceipts(
  records: unknown,
  options: {
    project: string;
    dimension: string;
    eventIds: readonly string[];
    alerts: boolean;
  },
): {
  dimension: string;
  envelopes: number;
  targetRobots: number;
  backgroundRobots: number;
  total: number;
};
interface Trust {
  environment: { NODE_EXTRA_CA_CERTS: string };
  volumes: string[];
}
export function receiverOverlay(input: { home: string; project: string; image: string }): {
  services: {
    api: Trust;
    worker: Trust;
    receiver: { networks: { default: { aliases: string[] } } };
  };
};
export function runObservability(options: {
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  config: { tag: string; images: { server: string } };
  hosts: { api: string; admin: string };
  flags: { errors: boolean; alerts: boolean };
  request: ErrorRequest;
  step: (...args: string[]) => void;
  run: (args: string[], options: object) => { status: number; stdout: string; stderr: string };
  bootstrap: (args: string[], env: NodeJS.ProcessEnv) => void;
}): Promise<void>;
