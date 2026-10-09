export { createContent } from "./service.js";
export type { Content, ContentDeps } from "./service.js";
export { DramaPricePort } from "./ports.js";
export type { DramaPrices, DramaPrice } from "./ports.js";
export type {
  BasicInput,
  CommercialInput,
  CopyrightInput,
  PermitInput,
  RolesInput,
} from "./inputs.js";
export { bindContent } from "./binding.js";
export { registration } from "./register.js";
export { seedDemoContent, DEMO_DRAMAS } from "./demo-seed.js";
export type { ContentDemoDeps } from "./demo-seed.js";

export { matchedFields, normalizeSearch } from "./search.js";
export type { SearchField, SearchableDrama } from "./search.js";
export {
  readMasterProductionFacts,
  readTrailerMediaFacts,
  setTrailerTarget,
  installTrailerCurrent,
} from "./media-facts.js";

export { createContentCopyright } from "./copyright.js";
export type { ContentCopyright } from "./copyright.js";
export { createContentLicense } from "./license-expiry.js";
export type { ContentLicense } from "./license-expiry.js";
export { adminDramaDetail, copyrightRevisionView } from "./admin-read.js";
export type { ContentAdminReadDeps } from "./admin-read.js";
export { listDramasLicenseEndingOn } from "./reminder.js";
