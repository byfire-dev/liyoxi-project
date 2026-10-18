/** Transport facts only. Domain handlers additionally check required outputs and current provenance. */
export function decideMediaConvergence(
  states: readonly string[],
): "pending" | "succeeded" | "failed" | "canceled" {
  if (
    states.length === 0 ||
    states.some((state) => ["queued", "running", "submitting", "submitted"].includes(state))
  )
    return "pending";
  if (
    states.some(
      (state) => !["succeeded", "failed", "canceled"].includes(state) || state === "failed",
    )
  )
    return "failed";
  return states.every((state) => state === "succeeded") ? "succeeded" : "canceled";
}
export function systemProduceId(fileId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(fileId))
    throw new TypeError("ProduceID只接受小写UUIDv7");
  return `lyx:${fileId}`;
}
