export const MESSAGE_SCENES = [
  "messages-owner",
  "messages-clerk",
  "messages-category",
  "messages-more",
  "messages-all-read",
  "messages-empty",
  "messages-no-store",
  "messages-unavailable",
  "messages-loading",
  "messages-error",
].map((name) => ({ name, route: "sub/service/messages/index" }));
