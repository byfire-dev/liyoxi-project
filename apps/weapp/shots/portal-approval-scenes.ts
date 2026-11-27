export const PORTAL_APPROVAL_SCENES = [
  "portal-approve-pair",
  "portal-approve-rejected",
  "portal-approve-mismatch",
  "portal-approve-approved",
  "portal-approve-expired",
].map((name) => ({ name, route: "sub/publish/portal-approve/index" }));
