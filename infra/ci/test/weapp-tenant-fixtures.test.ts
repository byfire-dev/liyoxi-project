import { join } from "node:path";
import { expect, it } from "vitest";
import {
  IdSchema,
  InvitationCardSchema,
  InvitationCreateBodySchema,
  InvitationPreviewSchema,
  MemberListSchema,
  MemberUpdateBodySchema,
  MembershipResultSchema,
  StoreCreateBodySchema,
  StoreListSchema,
  StoreProfileOverviewSchema,
} from "../../../packages/contract/src/index.js";
import { repoRoot, run } from "./helpers.js";

it("W214同源六页夹具与实际输入产物符合正式schema，端侧保持不触达Zod", () => {
  // NodeNext infra不递归编译端侧；脚本静态import同源数据，CLI只按现有weapp配置加载。
  const result = run(
    process.execPath,
    [
      join(repoRoot, "packages/services/node_modules/tsx/dist/cli.mjs"),
      "--tsconfig",
      join(repoRoot, "apps/weapp/tsconfig.json"),
      join(repoRoot, "infra/ci/weapp-tenant-fixtures.mjs"),
    ],
    repoRoot,
  );
  expect(result.status, result.stderr).toBe(0);
  const decoded: unknown = JSON.parse(result.stdout);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
    throw new Error("invalid fixture snapshot");
  const values = decoded as Record<string, unknown>;
  const targetStoreId = IdSchema.parse(values.targetStoreId),
    entityId = IdSchema.parse(values.entityId);
  expect(StoreListSchema.parse(values.ownerStores).viewerRole).toBe("owner");
  expect(StoreListSchema.parse(values.clerkStores).viewerRole).toBe("clerk");
  expect(MemberListSchema.parse(values.ownerMembers).viewerRole).toBe("owner");
  expect(MemberListSchema.parse(values.clerkMembers).viewerRole).toBe("clerk");
  expect(StoreProfileOverviewSchema.parse(values.clerkProfile).viewerRole).toBe("clerk");
  expect(StoreCreateBodySchema.parse(values.createDefault)).toEqual({
    name: "新门店",
    addressDetail: "广东省深圳市福田区邻里路18号",
    industryCode: "food",
    categoryCode: "coffee",
  });
  expect(StoreCreateBodySchema.parse(values.createCopied)).toMatchObject({
    copyFromStoreId: targetStoreId,
    copyOptions: ["service", "media"],
  });
  expect(MemberUpdateBodySchema.safeParse({ storeIds: [] }).success).toBe(false);
  expect(
    MemberUpdateBodySchema.safeParse({ storeIds: [targetStoreId, targetStoreId] }).success,
  ).toBe(false);
  expect(InvitationCardSchema.parse(values.invitation).storeId).toBe(targetStoreId);
  expect(InvitationCreateBodySchema.parse(values.invitationBody)).toEqual({
    clientRequestId: entityId,
    remarkName: "晚班",
    targetPhone: "13900009000",
  });
  if (!Array.isArray(values.previews)) throw new Error("invalid invitation previews");
  const statuses = ["pending", "accepted", "revoked", "expired"];
  expect(values.previews).toHaveLength(statuses.length);
  for (const [index, preview] of values.previews.entries())
    expect(InvitationPreviewSchema.parse(preview).status).toBe(statuses[index]);
  expect(MembershipResultSchema.parse(values.membership).storeId).toBe(targetStoreId);
  expect(MembershipResultSchema.parse(values.abandoned).abandonedEntityId).toBe(entityId);
});
