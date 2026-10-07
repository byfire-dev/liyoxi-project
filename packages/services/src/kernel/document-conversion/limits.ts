export const DOCUMENT_LIMITS = {
  fileBytes: 20 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024,
  entryBytes: 8 * 1024 * 1024,
  entries: 256,
  ratio: 100,
  pages: 100,
  codepoints: 250_000,
  htmlBytes: 1024 * 1024,
  deadlineMs: 10_000,
  heapMb: 128,
  stackMb: 4,
} as const;
