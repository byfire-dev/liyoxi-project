import type { PortalRoute } from "../../lib/routes";
import type { PortalRuntime } from "../../lib/runtime";
import { VerificationPage } from "./VerificationPage";

export function createVerificationRoutes(runtime: PortalRuntime): readonly PortalRoute[] {
  return [
    {
      path: "/v",
      owner: "W6-12",
      access: "public",
      render: () => <VerificationPage client={runtime.client} />,
    },
  ];
}
