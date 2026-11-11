import { createPortalTicketFlow } from "../features/auth/api";
import { createPortalSessionStore } from "../features/session/model";
import { createPortalClient } from "./api";
import { createPortalClientReporting } from "./client-reporting";

type RuntimeOptions = Parameters<typeof createPortalClient>[0] & {
  reporting?: { dsn: string; build: string; origin?: string };
};

/** Created by the application entry, outside React effect replay. No request runs on creation. */
export function createPortalRuntime(options: RuntimeOptions = {}) {
  const client = createPortalClient(options);
  const session = createPortalSessionStore(client, { now: options.now });
  const tickets = createPortalTicketFlow(client);
  const clientReporting = createPortalClientReporting({
    client,
    dsn: options.reporting?.dsn ?? "",
    build: options.reporting?.build ?? "",
    origin: options.reporting?.origin,
    now: options.now,
  });
  let disposed = false;
  return {
    client,
    session,
    tickets,
    clientReporting,
    dispose() {
      if (disposed) return;
      disposed = true;
      clientReporting.dispose();
      tickets.dispose();
      session.dispose();
      client.dispose();
    },
  };
}
export type PortalRuntime = ReturnType<typeof createPortalRuntime>;
