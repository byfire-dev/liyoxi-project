import { expect, test as base, type BrowserContext, type Route } from "@playwright/test";
import { PortalDownloadBodySchema, PortalOrderItemListQuerySchema } from "@liyoxi/contract";
import { createFixtures, ITEM_ID, ORIGIN, POLL_SECRET } from "./fixtures";
import { createFixtureMedia } from "./media-server";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type DownloadKind = "episode" | "zip" | "publish_list";
type HeldAction = "release" | "episode" | "zip";
type Hold = {
  requested: Promise<void>;
  completed: Promise<void>;
  release: () => void;
  wait: Promise<void>;
  arrive: () => void;
  finish: () => void;
};
export class PortalMock {
  readonly fixtures: ReturnType<typeof createFixtures>;
  readonly unexpected: string[] = [];
  readonly pageErrors: string[] = [];
  readonly downloads: Array<{ kind: DownloadKind; retry?: boolean; episodeNo?: number }> = [];
  readonly listQueries: Array<{ cursor?: string; limit: number; tab: string }> = [];
  readonly sequence: string[] = [];
  authenticated = false;
  approved = false;
  zipStates: Array<"ready" | "building" | "failed"> = ["building", "ready"];
  publishFileState: "ready" | "none" = "ready";
  private gates = new Map<HeldAction, Hold>();
  private pending = new Set<Hold>();

  constructor(mediaOrigin: string) {
    this.fixtures = createFixtures(mediaOrigin);
  }

  holdNext(action: HeldAction) {
    const requested = deferred(),
      released = deferred(),
      completed = deferred();
    const gate = {
      requested: requested.promise,
      completed: completed.promise,
      release: released.resolve,
      wait: released.promise,
      arrive: requested.resolve,
      finish: completed.resolve,
    };
    this.gates.set(action, gate);
    this.pending.add(gate);
    return gate;
  }
  releaseAll() {
    for (const gate of this.pending) gate.release();
  }
  private async hold(action: HeldAction) {
    const gate = this.gates.get(action);
    if (!gate) return;
    this.gates.delete(action);
    gate.arrive();
    await gate.wait;
    this.pending.delete(gate);
    return gate;
  }
  private async ok(route: Route, data: unknown) {
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { code: 0, message: "ok", data },
      });
    } catch (error) {
      // Scope changes deliberately abort in-flight fetches. All other routing errors remain failures.
      if (!route.request().failure()) throw error;
    }
  }
  async attach(context: BrowserContext) {
    context.on("page", (page) =>
      page.on("pageerror", (error) => this.pageErrors.push(error.message)),
    );
    for (const page of context.pages())
      page.on("pageerror", (error) => this.pageErrors.push(error.message));
    await context.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      if (url.origin !== ORIGIN) return this.unknown(route);
      if (path === "/api/v1/portal/sessions/current" && method === "GET") {
        this.sequence.push(this.authenticated ? "session:authorized" : "session:anonymous");
        return this.ok(route, this.authenticated ? this.fixtures.session : null);
      }
      if (path === "/api/v1/portal/sessions/current" && method === "DELETE") {
        expect(request.headers()["x-lyx-portal"]).toBe("1");
        this.authenticated = false;
        this.sequence.push("logout");
        return this.ok(route, null);
      }
      if (path === "/api/v1/portal/portal-tickets" && method === "POST") {
        expect(request.headers()["x-lyx-portal"]).toBe("1");
        expect(request.postDataJSON()).toEqual({});
        this.sequence.push("ticket:create");
        return this.ok(route, this.fixtures.ticket);
      }
      const ticketPath = `/api/v1/portal/portal-tickets/${this.fixtures.ticket.portalTicketId}`;
      if (path === ticketPath && method === "GET") {
        expect(request.headers()["x-poll-secret"]).toBe(POLL_SECRET);
        expect(url.search).toBe("");
        return this.ok(route, this.fixtures.status(this.approved));
      }
      if (path === `${ticketPath}/exchange` && method === "POST") {
        expect(request.headers()["x-lyx-portal"]).toBe("1");
        expect(request.postDataJSON()).toEqual({ pollSecret: POLL_SECRET });
        this.authenticated = true;
        this.sequence.push("exchange");
        return this.ok(route, this.fixtures.exchange);
      }
      if (!this.authenticated) return this.unknown(route);
      if (path === "/api/v1/portal/order-items" && method === "GET") {
        const query = PortalOrderItemListQuerySchema.parse(Object.fromEntries(url.searchParams));
        this.listQueries.push(query);
        this.sequence.push("items");
        expect(query.tab).toBe("all");
        expect(query.limit).toBe(20);
        if (query.cursor !== undefined) expect(query.cursor).toBe("migration-page-2");
        return this.ok(route, query.cursor ? this.fixtures.secondPage : this.fixtures.firstPage);
      }
      if (path === "/api/v1/portal/ads" && method === "GET")
        return this.ok(route, this.fixtures.ads);
      if (path === `/api/v1/portal/order-items/${ITEM_ID}/release` && method === "GET") {
        const held = await this.hold("release");
        try {
          await this.ok(route, this.fixtures.release);
        } finally {
          held?.finish();
        }
        return;
      }
      if (path === `/api/v1/portal/order-items/${ITEM_ID}/publish-list` && method === "GET")
        return this.ok(route, this.fixtures.publishList);
      if (path === `/api/v1/portal/order-items/${ITEM_ID}/download-urls` && method === "POST") {
        expect(request.headers()["x-lyx-portal"]).toBe("1");
        const body = PortalDownloadBodySchema.parse(request.postDataJSON());
        this.downloads.push(body);
        if (body.kind === "episode") expect(body.episodeNo).toBe(1);
        const held =
          body.kind === "episode" || body.kind === "zip" ? await this.hold(body.kind) : undefined;
        const state =
          body.kind === "zip"
            ? (this.zipStates.shift() ?? "ready")
            : body.kind === "publish_list"
              ? this.publishFileState
              : "ready";
        try {
          await this.ok(route, this.fixtures.download(body.kind, state));
        } finally {
          held?.finish();
        }
        return;
      }
      return this.unknown(route);
    });
  }
  private async unknown(route: Route) {
    this.unexpected.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await route.abort("blockedbyclient");
  }
}

export const test = base.extend<{ portal: PortalMock }>({
  portal: async ({ context }, use) => {
    const media = await createFixtureMedia();
    const portal = new PortalMock(media.origin);
    await portal.attach(context);
    try {
      await use(portal);
    } finally {
      portal.releaseAll();
      await media.close();
      expect(
        media.unexpected,
        "The temporary media server only serves declared fixture files",
      ).toEqual([]);
      expect(
        portal.unexpected,
        "No unknown API or fixture requests may reach a real server",
      ).toEqual([]);
      expect(portal.pageErrors, "Production pages must not throw browser exceptions").toEqual([]);
    }
  },
});
export { expect };
