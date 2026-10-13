export const SETTINGS_SCENES = [
  "settings-owner",
  "settings-clerk",
  "settings-guest",
  "settings-name-saved",
  "settings-delete-blocked",
  "settings-notice-retry",
  "settings-phone-unavailable",
  "settings-identities",
].map((name) => ({ name, route: "sub/service/settings/index" }));
