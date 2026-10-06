import { ADMIN_MODULE_KEYS } from "@liyoxi/contract/authz";
import type { components } from "@liyoxi/contract/types/admin";
import { useSyncExternalStore } from "react";

import type { AccessSnapshot } from "../../lib/permissions";

export type StaffMe = components["schemas"]["StaffMe"];
export type AuthNext = components["schemas"]["AuthNext"];
export type TotpEnrollment = components["schemas"]["TotpEnrollment"];

export type MeAccess = Pick<StaffMe, "roleName" | "moduleLevels" | "permissions" | "flags"> & {
  staff: Pick<StaffMe["staff"], "staffId" | "name" | "isLead"> & { roleKey: unknown };
  dataScope: unknown;
};
export function accessFromMe(me: MeAccess): AccessSnapshot {
  return {
    staff: {
      id: me.staff.staffId,
      name: me.staff.name,
      roleKey: typeof me.staff.roleKey === "string" ? me.staff.roleKey : "",
      roleName: me.roleName,
    },
    isLead: me.staff.isLead,
    moduleLevels: Object.fromEntries(
      ADMIN_MODULE_KEYS.map((key) => [key, me.moduleLevels[key] ?? "n"]),
    ),
    actions: me.permissions,
    dataScope: me.dataScope === "all" ? "all" : me.dataScope === "group" ? "group" : "own",
    releases: Object.fromEntries(
      Object.entries(me.flags)
        .filter(([key]) => key.startsWith("release."))
        .map(([key, value]) => [key, value === true]),
    ),
  };
}

/** 只允许站内地址；反斜线与双斜线会被浏览器解释为站外 URL。 */
export function safeRedirect(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    return "/";
  const parsed = new URL(value, "https://admin.invalid");
  if (parsed.origin !== "https://admin.invalid" || /^\/login(?:\/|$)/.test(parsed.pathname))
    return "/";
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function nextPath(next: AuthNext["next"]): string {
  return {
    mfa: "/login/mfa",
    set_password: "/login/set-password",
    enroll_totp: "/login/enroll-totp",
    login: "/login",
  }[next];
}

let ticket: AuthNext | null = null;
const listeners = new Set<() => void>();
export const authTicket = {
  get: () => ticket,
  set(value: AuthNext | null) {
    ticket = value;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
export function useAuthTicket(): AuthNext | null {
  return useSyncExternalStore(authTicket.subscribe, authTicket.get, authTicket.get);
}
export function liveTicket(
  value: AuthNext | null,
  purpose: AuthNext["next"],
  now = Date.now(),
): string | null {
  return value?.next === purpose &&
    value.ticket &&
    value.ticketExpiresAt &&
    Date.parse(value.ticketExpiresAt) > now
    ? value.ticket
    : null;
}

export interface StepUpController {
  request(): Promise<boolean>;
  settle(accepted: boolean): void;
  get(): boolean;
  subscribe(listener: () => void): () => void;
}
export function createStepUpController(): StepUpController {
  let promise: Promise<boolean> | null = null;
  let resolve: ((accepted: boolean) => void) | null = null;
  const subscribers = new Set<() => void>();
  const emit = () => {
    for (const listener of subscribers) listener();
  };
  return {
    request() {
      if (!promise) {
        promise = new Promise<boolean>((done) => {
          resolve = done;
        });
        emit();
      }
      return promise;
    },
    settle(accepted) {
      const done = resolve;
      promise = null;
      resolve = null;
      emit();
      done?.(accepted);
    },
    get: () => promise !== null,
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  };
}
