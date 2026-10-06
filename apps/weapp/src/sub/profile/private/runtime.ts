import { account } from "../../../lib/account-runtime";
import { request } from "../../../lib/runtime";
import { useContextStore } from "../../../stores/context";
import { useSessionStore } from "../../../stores/session";
import { createProfileApi } from "./api";

let ready: Promise<{ api: ReturnType<typeof createProfileApi>; reloadMe(): Promise<void> }> | null =
  null;
/** 本域离线替身仅在明确 H5 样张启用，生产始终使用中央 request。 */
export function profileRuntime() {
  ready ??= (async () => {
    await account.start();
    if (process.env.TARO_ENV === "h5") {
      const scene = (globalThis as { __LYX_PROFILE_SHOT__?: string }).__LYX_PROFILE_SHOT__;
      if (scene) {
        const { offlineProfile } = await import("../../../../shots/profile-fixtures");
        const fixture = offlineProfile(scene);
        const { profileAuthorizationProbe } =
          await import("../../../../shots/profile-authorization");
        const authorization = profileAuthorizationProbe();
        (globalThis as { __LYX_PROFILE_CALLS__?: typeof fixture.calls }).__LYX_PROFILE_CALLS__ =
          fixture.calls;
        const reloadMe = async () => {
          const me = fixture.me();
          useSessionStore.getState().setSession("lyxm_offline_profile", me);
          useContextStore.getState().switchStore(me.memberships[0]?.stores[0]?.storeId ?? null);
        };
        await reloadMe();
        (
          globalThis as {
            __LYX_PROFILE_CONTROL__?: typeof fixture.control & {
              authorization: typeof authorization;
              switchStore(): void;
              logout(): void;
            };
          }
        ).__LYX_PROFILE_CONTROL__ = {
          ...fixture.control,
          authorization,
          switchStore() {
            fixture.control.replaceStore();
            const current = useContextStore.getState();
            current.switchStore(
              current.currentStoreId === "00000000-0000-4000-8000-000000000099"
                ? "00000000-0000-4000-8000-000000000098"
                : "00000000-0000-4000-8000-000000000099",
            );
          },
          logout() {
            useSessionStore.getState().clear();
          },
        };
        return { api: createProfileApi(fixture.call, profileContext), reloadMe };
      }
    }
    return { api: createProfileApi(request, profileContext), reloadMe: () => account.reloadMe() };
  })();
  return ready;
}
export function profileContext(): string {
  const { currentStoreId, contextRev } = useContextStore.getState();
  return `${useSessionStore.getState().accessToken ?? ""}|${currentStoreId ?? ""}|${contextRev}`;
}
