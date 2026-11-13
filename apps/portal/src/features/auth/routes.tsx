import type { PortalRoute } from "../../lib/routes";
import type { PortalRuntime } from "../../lib/runtime";
import { LandingPage } from "../landing/LandingPage";
import { LoginPage } from "./LoginPage";

export function createAuthRoutes(runtime: PortalRuntime): readonly PortalRoute[] {
  return [
    { path: "/", owner: "W6-10", access: "public", render: () => <LoginPage runtime={runtime} /> },
    { path: "/a", owner: "W6-10", access: "public", render: () => <LandingPage /> },
  ];
}
