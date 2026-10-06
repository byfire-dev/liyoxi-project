import type { Target } from "../ci/probe-during-deploy.mjs";
export interface Inventory {
  schemaVersion: number;
  version: string;
  apps: Record<
    "admin" | "portal",
    {
      index: string;
      build: string;
      entry: string[];
      assets: Array<{ path: string; sha256: string; bytes: number }>;
    }
  >;
}
export function capture(tag: string, image: string, shared: string, records: string): Inventory;
export function load(tag: string, records: string): Inventory;
export function targets(
  inventory: Inventory,
  hosts: { admin: string; portal: string },
  base?: string,
  entries?: boolean,
): Target[];
export function main(
  args: string[],
  paths?: { image: string; shared: string; records: string },
): Promise<void>;
