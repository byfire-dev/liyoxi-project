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
export { DramaUsagePort } from "./ports.js";
export type { DramaUsage } from "./ports.js";
export { createContentMaintenance } from "./maintenance.js";
export type { ContentMaintenance } from "./maintenance.js";
export { seedDemoContent, DEMO_DRAMAS, DEMO_DICT_ITEMS } from "./demo-seed.js";
export type { ContentDemoDeps } from "./demo-seed.js";

export { matchedFields, normalizeSearch } from "./search.js";
export type { SearchField, SearchableDrama } from "./search.js";
export { readUploadDramaFacts } from "./upload-facts.js";
export type { UploadDramaFacts } from "./upload-facts.js";
export { commitUploadMasters } from "./upload-masters.js";
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
export {
  adminDramaDetail,
  copyrightRevisionView,
  adminTrailerView,
  adminMediaReadiness,
  adminEpisodeView,
  adminDramaEpisodes,
  adminPermitView,
  adminDramaPermits,
  adminDramas,
  adminDramaSummary,
} from "./admin-read.js";
export type { ContentAdminReadDeps } from "./admin-read.js";
export { listDramasLicenseEndingOn } from "./reminder.js";
export { readTemplatePriceCandidates } from "./price-candidates.js";
export { readMaterialMasters, readProductionMasterVersion } from "./material-facts.js";
