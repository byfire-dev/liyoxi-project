import { createPortalTicketFlow } from "../features/auth/api";
import { createPortalSessionStore } from "../features/session/model";
import { createPortalClient } from "./api";

/** Created by the application entry, outside React effect replay. No request runs on creation. */
export function createPortalRuntime(options: Parameters<typeof createPortalClient>[0] = {}) {
  const client = createPortalClient(options);
  const session = createPortalSessionStore(client, { now: options.now });
  const tickets = createPortalTicketFlow(client);
  let disposed = false;
  return {
    client,
    session,
    tickets,
    dispose() {
      if (disposed) return;
      disposed = true;
      tickets.dispose();
      session.dispose();
      client.dispose();
    },
  };
}
export type PortalRuntime = ReturnType<typeof createPortalRuntime>;
