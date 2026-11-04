import { randomUUID } from "node:crypto";
import { request } from "node:http";
import {
  AgreementListSchema,
  InvitationCardSchema,
  MeViewSchema,
  MembershipResultSchema,
  PhoneLoginResultSchema,
  PortalTicketDecisionSchema,
  PortalTicketPreviewSchema,
  PortalSessionItemSchema,
  envelope,
} from "@liyoxi/contract";
import { isErrorSymbol } from "@liyoxi/contract/errors";
import type { ErrorSymbol } from "@liyoxi/contract/errors";
import type { PortalLiveActor, PortalLiveFixture } from "@liyoxi/services/testing";
import { z } from "zod";

export interface PortalActorScope {
  entityId: string;
  storeId: string;
}
export type PortalMerchantResult<T> =
  | { httpStatus: 200; error: null; data: T }
  | { httpStatus: number; error: ErrorSymbol; data: null };
type Credential = { token: string; userId: string; scope?: PortalActorScope };
const errorView = z.object({ error: z.string() });

/** Loopback socket HTTP only. Credentials and full responses never leave this closure. */
export function createPortalLiveMerchant(
  port: number,
  fixture: Pick<PortalLiveFixture, "primePhoneLogin">,
) {
  const credentials = new Map<PortalLiveActor, Credential>();
  const active = new Set<AbortController>();
  let closed = false;
  async function call<T>(
    method: "GET" | "POST",
    path: string,
    schema: z.ZodType<T>,
    input: { actor?: PortalLiveActor; store?: boolean; key?: string; body?: unknown } = {},
  ): Promise<PortalMerchantResult<T>> {
    if (closed) throw new Error("MERCHANT_TRANSPORT_CLOSED");
    const controller = new AbortController();
    active.add(controller);
    const credential = input.actor ? credentials.get(input.actor) : undefined;
    if ((input.actor && !credential) || (input.store && !credential?.scope)) {
      active.delete(controller);
      throw new Error("MERCHANT_IDENTITY_NOT_READY");
    }
    const body = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body));
    try {
      const result = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port,
            method,
            path,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
            headers: {
              Host: `api.localhost:${port}`,
              "User-Agent": "LYX portal shell local verification",
              "X-Client-Version": "1.4.0",
              Accept: "application/json",
              ...(credential ? { Authorization: `Bearer ${credential.token}` } : {}),
              ...(input.store ? { "X-Store-Id": credential!.scope!.storeId } : {}),
              ...(input.key ? { "Idempotency-Key": input.key } : {}),
              ...(body
                ? { "Content-Type": "application/json", "Content-Length": body.byteLength }
                : {}),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.byteLength;
              if (size > 256 * 1024) {
                response.destroy();
                req.destroy();
                reject(new Error("HTTP_RESPONSE_TOO_LARGE"));
              } else chunks.push(chunk);
            });
            response.on("error", () => reject(new Error("HTTP_RESPONSE_FAILED")));
            response.on("end", () => {
              try {
                resolve({
                  status: response.statusCode ?? 0,
                  body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
                });
              } catch {
                reject(new Error("HTTP_RESPONSE_INVALID"));
              }
            });
          },
        );
        req.on("error", () => reject(new Error("HTTP_REQUEST_FAILED")));
        req.end(body);
      });
      if (result.status === 200) {
        const parsed = envelope(schema).safeParse(result.body);
        if (!parsed.success) throw new Error("HTTP_RESPONSE_INVALID");
        return { httpStatus: 200, error: null, data: parsed.data.data };
      }
      const parsed = errorView.safeParse(result.body);
      if (!parsed.success || !isErrorSymbol(parsed.data.error))
        throw new Error("HTTP_RESPONSE_INVALID");
      return { httpStatus: result.status, error: parsed.data.error, data: null };
    } finally {
      active.delete(controller);
    }
  }
  function success<T>(result: PortalMerchantResult<T>): T {
    if (result.error !== null)
      throw new Error(`MERCHANT_HTTP_${result.httpStatus}_${result.error}`);
    return result.data;
  }
  const actors = (): Record<PortalLiveActor, PortalActorScope> => {
    const scope = (actor: PortalLiveActor) => {
      const value = credentials.get(actor)?.scope;
      if (!value) throw new Error("MERCHANT_IDENTITY_NOT_READY");
      return { ...value };
    };
    return { owner: scope("owner"), clerk: scope("clerk"), otherOwner: scope("otherOwner") };
  };
  return {
    async prepare() {
      if (credentials.size) throw new Error("MERCHANT_ALREADY_PREPARED");
      const agreements = success(
        await call("GET", "/api/v1/m/agreements?scene=login", AgreementListSchema),
      );
      const consents = ["user", "privacy"].map((agreementKey) => {
        const current = agreements.items.find(
          (row) => row.agreementKey === agreementKey,
        )?.currentVersion;
        if (!current) throw new Error("LOGIN_AGREEMENTS_NOT_READY");
        return { agreementKey, agreementVersionId: current.agreementVersionId };
      });
      for (const actor of ["owner", "clerk", "otherOwner"] as const) {
        const login = success(
          await call("POST", "/api/v1/m/sessions/phone-login", PhoneLoginResultSchema, {
            body: { ...fixture.primePhoneLogin(actor), consents },
          }),
        );
        credentials.set(actor, { token: login.token, userId: login.me.user.merchantUserId });
      }
      for (const actor of ["owner", "otherOwner"] as const) {
        const member = success(
          await call("POST", "/api/v1/m/entities", MembershipResultSchema, {
            actor,
            key: randomUUID(),
            body: {},
          }),
        );
        if (member.role !== "owner") throw new Error("OWNER_MEMBERSHIP_MISMATCH");
        credentials.get(actor)!.scope = { entityId: member.entityId, storeId: member.storeId };
      }
      const invitation = success(
        await call("POST", "/api/v1/m/invitations", InvitationCardSchema, {
          actor: "owner",
          store: true,
          body: { clientRequestId: randomUUID(), remarkName: "安全壳店员" },
        }),
      );
      const member = success(
        await call(
          "POST",
          `/api/v1/m/invitations/${invitation.invitationId}/accept`,
          MembershipResultSchema,
          {
            actor: "clerk",
            key: randomUUID(),
            body: { token: invitation.token, displayName: "安全壳店员" },
          },
        ),
      );
      credentials.get("clerk")!.scope = { entityId: member.entityId, storeId: member.storeId };
      const scopes = actors();
      if (
        member.role !== "clerk" ||
        scopes.clerk.entityId !== scopes.owner.entityId ||
        scopes.clerk.storeId !== scopes.owner.storeId ||
        scopes.otherOwner.entityId === scopes.owner.entityId ||
        scopes.otherOwner.storeId === scopes.owner.storeId
      )
        throw new Error("MEMBERSHIP_SCOPE_MISMATCH");
      for (const actor of ["owner", "clerk", "otherOwner"] as const) {
        const me = success(await call("GET", "/api/v1/m/me", MeViewSchema, { actor }));
        if (me.user.merchantUserId !== credentials.get(actor)!.userId)
          throw new Error("MERCHANT_IDENTITY_MISMATCH");
      }
      return scopes;
    },
    actors,
    /** Private producer input from real HTTP identities; never part of ready IPC. */
    previewScopes() {
      const scopes = actors();
      const scope = (actor: PortalLiveActor) => {
        const credential = credentials.get(actor);
        if (closed || !credential) throw new Error("MERCHANT_IDENTITY_MISSING");
        return { ...scopes[actor], merchantUserId: credential.userId };
      };
      return { owner: scope("owner"), clerk: scope("clerk"), otherOwner: scope("otherOwner") };
    },
    actorForUser(userId: string): PortalLiveActor | undefined {
      return [...credentials].find(([, credential]) => credential.userId === userId)?.[0];
    },
    lookup(actor: PortalLiveActor, code: string) {
      return call(
        "GET",
        `/api/v1/m/portal-tickets/lookup?${new URLSearchParams({ code })}`,
        PortalTicketPreviewSchema,
        { actor, store: true },
      );
    },
    decide(
      actor: PortalLiveActor,
      ticketId: string,
      key: string,
      decision: { decision: "approve"; pairDigits: string } | { decision: "reject" },
    ) {
      return call(
        "POST",
        `/api/v1/m/portal-tickets/${ticketId}/${decision.decision}`,
        PortalTicketDecisionSchema,
        {
          actor,
          store: true,
          key,
          ...(decision.decision === "approve" ? { body: { pairDigits: decision.pairDigits } } : {}),
        },
      );
    },
    revoke(actor: PortalLiveActor, sessionId: string, key: string) {
      return call(
        "POST",
        `/api/v1/m/portal-sessions/${sessionId}/revoke`,
        PortalSessionItemSchema,
        { actor, store: true, key },
      );
    },
    close() {
      closed = true;
      for (const controller of active) controller.abort();
      active.clear();
      credentials.clear();
    },
  };
}
export type PortalLiveMerchant = ReturnType<typeof createPortalLiveMerchant>;
