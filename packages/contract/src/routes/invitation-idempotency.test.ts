import { describe, expect, it } from "vitest";

import { routeCatalog } from "./index.js";
import { mInvitationCreate } from "./m02-tenant/invitations.js";

describe("邀请请求映射的自然键登记", () => {
  it("保留原创建键并登记全部请求的映射唯一键，仍沿原成员能力边界", () => {
    const route = routeCatalog.find((item) => item.operationId === "m.invitation.create");
    expect(route).toMatchObject({
      operationId: "m.invitation.create",
      method: "POST",
      path: "/m/invitations",
      xAuth: "member",
      capability: "member.manage",
      clerkView: "none",
      xIdempotent: "natural",
      idempotentBy: [
        "uq_invitation_inviter_member_id_client_request_id",
        "uq_invitation_request_inviter_client",
      ],
    });
    expect(mInvitationCreate["x-idempotent"]).toBe("natural");
    expect(mInvitationCreate["x-idempotent-by"]).toEqual(route?.idempotentBy);
  });
});
