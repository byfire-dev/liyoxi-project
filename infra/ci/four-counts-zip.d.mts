export interface ZipQueueEntry {
  readonly category: string;
  readonly module: string;
  readonly name: string;
  readonly milestone: string;
}

export function zipPackageHandlerPresent(item: ZipQueueEntry, root: string): boolean | null;
