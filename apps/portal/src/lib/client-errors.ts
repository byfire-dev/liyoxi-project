import { cleanClientStacktrace } from "@liyoxi/shared/telemetry";

import { safeRequestId } from "./api-errors";

const categories = ["network", "api", "not_found", "exception", "unhandled_rejection"] as const;
export interface PortalClientError {
  readonly category: (typeof categories)[number];
  readonly status?: number;
  readonly requestId?: string;
  readonly stacktrace?: ReturnType<typeof cleanClientStacktrace>;
}
export type PortalClientErrorSink = (event: PortalClientError) => void | Promise<void>;

function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** Sole allowlist before an optional writer. Unknown input and delivery failures are never retained. */
export function createPortalErrorReporter(sink?: PortalClientErrorSink) {
  return (input: unknown): void => {
    if (!sink) return;
    try {
      const category = own(input, "category");
      if (!categories.includes(category as PortalClientError["category"])) return;
      const requestId = safeRequestId(own(input, "requestId"));
      const rawStatus = own(input, "status");
      const status =
        typeof rawStatus === "number" &&
        Number.isInteger(rawStatus) &&
        rawStatus >= 400 &&
        rawStatus <= 599
          ? rawStatus
          : undefined;
      const stacktrace = cleanClientStacktrace(own(input, "stacktrace"), "portal");
      const event: PortalClientError = {
        category: category as PortalClientError["category"],
        ...(requestId ? { requestId } : {}),
        ...(status ? { status } : {}),
        ...(stacktrace ? { stacktrace } : {}),
      };
      const work = sink(Object.freeze(event));
      if (work)
        void work.catch(() => {
          /* Reporting must not recurse or retain its failure. */
        });
    } catch {
      /* The optional sink owns delivery failure; never recurse. */
    }
  };
}
