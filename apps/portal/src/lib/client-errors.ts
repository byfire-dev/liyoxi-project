import { cleanClientStacktrace } from "@liyoxi/shared/telemetry";

import { object, safeRequestId } from "./api-errors";

const categories = ["network", "api", "not_found", "exception", "unhandled_rejection"] as const;
export interface PortalClientError {
  readonly category: (typeof categories)[number];
  readonly status?: number;
  readonly requestId?: string;
  readonly stacktrace?: ReturnType<typeof cleanClientStacktrace>;
}
export type PortalClientErrorSink = (event: PortalClientError) => void | Promise<void>;

/** W6-12 supplies delivery. This boundary neither installs listeners nor reports fake success. */
export function createPortalErrorReporter(sink?: PortalClientErrorSink) {
  return (input: unknown): void => {
    if (!sink) return;
    const value = object(input);
    if (!value || !categories.includes(value.category as PortalClientError["category"])) return;
    const requestId = safeRequestId(value.requestId);
    const status =
      typeof value.status === "number" &&
      Number.isInteger(value.status) &&
      value.status >= 400 &&
      value.status <= 599
        ? value.status
        : undefined;
    const stacktrace = cleanClientStacktrace(value.stacktrace, "portal");
    const event: PortalClientError = {
      category: value.category as PortalClientError["category"],
      ...(requestId ? { requestId } : {}),
      ...(status ? { status } : {}),
      ...(stacktrace ? { stacktrace } : {}),
    };
    try {
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
