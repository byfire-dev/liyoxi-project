import { createRoute } from "@tanstack/react-router";

import { ActivationPage, EnrollmentPage, LoginPage, MfaPage } from "../../features/auth/pages";
import { rootRoute } from "../__root";

const search = (value: Record<string, unknown>) => ({
  redirect: typeof value.redirect === "string" ? value.redirect : undefined,
});
export const authRoutes = [
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    validateSearch: search,
    staticData: { pageKey: "base.login" },
    component: LoginPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/login/mfa",
    validateSearch: search,
    staticData: { pageKey: "base.mfa" },
    component: MfaPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/login/set-password",
    validateSearch: search,
    staticData: { pageKey: "base.first_password" },
    component: ActivationPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/login/enroll-totp",
    validateSearch: search,
    staticData: { pageKey: "base.enroll_totp" },
    component: EnrollmentPage,
  }),
] as const;
