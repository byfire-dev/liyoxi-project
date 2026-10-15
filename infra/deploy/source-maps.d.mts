export function init(base: string): Promise<string>;
export function split(
  component: string,
  repo: string,
  output: string,
  build: string,
): Promise<unknown>;
export function finalize(
  root: string,
  source: string,
  tag: string,
): Promise<{ components: number; upload: "unimplemented" }>;
export function verify(
  root: string,
  source: string,
  tag: string,
): Promise<{ components: number; upload: "unimplemented" }>;
export function cleanup(root: string): Promise<void>;
