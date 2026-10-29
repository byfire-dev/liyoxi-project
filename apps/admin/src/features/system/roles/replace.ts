import type { AppServices } from "../../../app/services";
import { accessResult, AccessFailure } from "../staff-access";
import type { RoleBody } from "./model";

/** Owned by the stable workspace, not the editor keyed by lockVersion. */
export async function replaceRole(
  services: Pick<AppServices, "api">,
  roleKey: string,
  body: RoleBody,
  key: string,
  workspace: {
    current: () => boolean;
    conflict: () => Promise<void>;
    saved: () => Promise<void>;
  },
): Promise<boolean | undefined> {
  try {
    await accessResult(
      await services.api.client.PUT("/api/v1/admin/roles/{roleKey}", {
        params: { path: { roleKey } },
        body,
        headers: { "Idempotency-Key": key },
      }),
    );
  } catch (error) {
    if (!workspace.current()) return;
    if (error instanceof AccessFailure && error.failure.symbol === "VERSION_CONFLICT") {
      await workspace.conflict();
      return;
    }
    throw error;
  }
  if (!workspace.current()) return;
  await workspace.saved();
  return workspace.current() ? true : undefined;
}
