// Preprod backport: expose only the supported controlled finance settings page.
import { financeSettingsRoute } from "../finance/settings";
export const financeRoutes = [financeSettingsRoute] as const;
