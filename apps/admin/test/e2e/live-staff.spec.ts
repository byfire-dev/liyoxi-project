// W1-02②：生产后台连真实 API，复用登录态与专属库的员工造数。
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  DeliveryTicketDetailSchema,
  IdSchema,
  StaffListItemSchema,
  adminPage,
  z,
} from "@liyoxi/contract";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";
import { ensureLiveStepUp } from "./live-step-up";

interface StaffFixture {
  staff: { id: string; name: string; roleKey: string; status: string; phoneLast4: string }[];
  newStaff: { name: string; phone: string };
}
interface StaffActor {
  staffId: string;
  name: string;
  roleKey: string;
  status: string;
}
interface W609StaffFixture {
  runId: string;
  scope: { entityId: string; storeId: string };
  live: { orderId: string; itemId: string; ticketId: string };
  offline: { orderId: string; itemId: string; ticketId: string }[];
  staffManifest: unknown;
}
const StaffActorSchema = StaffListItemSchema.pick({
  staffId: true,
  name: true,
  roleKey: true,
  status: true,
}).strict();
const W609StaffManifestSchema = z.strictObject({
  manager: StaffActorSchema,
  publisher: StaffActorSchema,
  creators: z.array(
    z.strictObject({ orderItemId: IdSchema, dramaId: IdSchema, staff: StaffActorSchema }),
  ),
});
async function w609StaffActors(page: Page, fixture: W609StaffFixture): Promise<StaffActor[]> {
  // 独立期望来自本轮夹具的已建行清单，再用工单关联复核；不从员工列表反推。
  expect(fixture.offline).toHaveLength(3);
  const deliveries = [fixture.live, ...fixture.offline];
  expect(new Set(deliveries.map((item) => item.ticketId)).size).toBe(deliveries.length);
  const manifest = W609StaffManifestSchema.parse(fixture.staffManifest);
  expect(manifest.manager).toMatchObject({
    name: `W609交付-${fixture.runId}`,
    roleKey: "delivery_manager",
    status: "active",
  });
  expect(manifest.publisher).toMatchObject({
    name: `W609发布-${fixture.runId}`,
    roleKey: "publisher",
    status: "active",
  });
  expect(manifest.creators.map((item) => item.orderItemId).sort()).toEqual(
    deliveries.map((item) => item.itemId).sort(),
  );
  const assigned = [manifest.manager, manifest.publisher];
  const creators = manifest.creators.map((item) => item.staff);
  for (const actor of creators)
    expect(actor).toMatchObject({ roleKey: "content_ops", status: "active" });
  for (const item of deliveries) {
    const creator = manifest.creators.find((row) => row.orderItemId === item.itemId)!;
    const response = await page.request.get(`/api/v1/admin/delivery-tickets/${item.ticketId}`);
    expect(response.status()).toBe(200);
    const ticket = DeliveryTicketDetailSchema.parse((await response.json()).data);
    expect(ticket).toMatchObject({
      deliveryTicketId: item.ticketId,
      orderItemId: item.itemId,
      order: { orderId: item.orderId },
      store: { storeId: fixture.scope.storeId, entityId: fixture.scope.entityId },
      orderItem: { orderItemId: item.itemId, dramaId: creator.dramaId },
      deliveryManager: manifest.manager,
      publisher: manifest.publisher,
    });
  }
  expect(assigned).toHaveLength(2);
  expect(new Set(creators.map((actor) => actor.staffId)).size).toBe(deliveries.length);
  const actors = [...assigned, ...creators];
  expect(new Set(actors.map((actor) => actor.staffId)).size).toBe(actors.length);
  return actors;
}
const pageItemCount = (total: number, pageSize: number, page: number) =>
  Math.min(pageSize, Math.max(0, total - (page - 1) * pageSize));
async function shot(page: Page, name: string) {
  await noHorizontalScroll(page, name);
  mkdirSync("dist/e2e-shots", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `dist/e2e-shots/${name}.png`, animations: "disabled" });
  await page.setViewportSize({ width: 1366, height: 768 });
}
async function select(page: Page, label: string, value: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  // antd 的 option 仅用于读屏；可见选项用既有样例相同的 title 定位。
  await page.getByTitle(value, { exact: true }).click();
  await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
}

test("员工筛选、分页URL与新增manual一次性激活码，同步双提交只建一行", async ({ page }) => {
  const context = liveContext();
  const fixtures = (
    context.fixtures as {
      fixtures: {
        staff: StaffFixture;
        w513: {
          editor: { staffId: string };
          publisher: { staffId: string };
          aftersales: { finance: { staffId: string } };
        };
        w418: {
          approvals: { requesterStaffId: string };
          invoices: { reviewerStaffId: string };
        };
        w514: { editor: { staffId: string } };
        w609: W609StaffFixture;
      };
    }
  ).fixtures;
  const fixture = fixtures.staff;
  expect(fixture.staff).toHaveLength(10);
  const existingAddedActors = [
    {
      staffId: fixtures.w514.editor.staffId,
      name: "W514广告剪辑师",
      roleKey: "editor",
      status: "active",
    },
    {
      staffId: fixtures.w418.approvals.requesterStaffId,
      name: "W418隔离审批发起人",
      roleKey: "super_admin",
      status: "active",
    },
    {
      staffId: fixtures.w418.invoices.reviewerStaffId,
      name: "W418红冲关联退款复核人",
      roleKey: "super_admin",
      status: "active",
    },
    {
      staffId: fixtures.w513.editor.staffId,
      name: "W513交付剪辑师",
      roleKey: "editor",
      status: "active",
    },
    {
      staffId: fixtures.w513.publisher.staffId,
      name: "W513交付发布员",
      roleKey: "publisher",
      status: "active",
    },
    {
      staffId: fixtures.w513.aftersales.finance.staffId,
      name: "W513取消审批财务",
      roleKey: "finance",
      status: "active",
    },
  ];
  expect(new Set(existingAddedActors.map((actor) => actor.staffId)).size).toBe(6);
  // 保留原14人与W513/W514/W418六人的精确基数，再计本轮W609独立名单。
  const originalStaffCount = 1 + fixture.staff.length + 2 + 1;
  expect(originalStaffCount).toBe(14);
  expect(originalStaffCount + existingAddedActors.length).toBe(20);
  const w609Actors = await w609StaffActors(page, fixtures.w609);
  const addedActors = [...existingAddedActors, ...w609Actors];
  expect(new Set(addedActors.map((actor) => actor.staffId)).size).toBe(addedActors.length);
  const expectedStaffCount = originalStaffCount + addedActors.length;
  const errors = recordErrors(page);
  const firstList = page.waitForRequest(
    (request) =>
      request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/admin/staff",
  );
  await page.goto("/sys/staff?sort=unsupported&roleKey=unknown&page=0&pageSize=13&uiOnly=x");
  const firstRequest = await firstList;
  const firstQuery = new URL(firstRequest.url()).searchParams;
  expect(firstQuery.get("page")).toBe("1");
  expect(firstQuery.get("pageSize")).toBe("20");
  for (const key of ["roleKey", "sort", "uiOnly"]) expect(firstQuery.has(key)).toBe(false);
  const firstResponse = await firstRequest.response();
  expect(firstResponse).not.toBeNull();
  expect(firstResponse!.status()).toBe(200);
  const initialStaff = adminPage(StaffListItemSchema).parse((await firstResponse!.json()).data);
  expect(initialStaff.total).toBe(expectedStaffCount);
  expect(initialStaff.page).toBe(1);
  expect(initialStaff.pageSize).toBe(20);
  expect(initialStaff.items).toHaveLength(pageItemCount(expectedStaffCount, 20, 1));
  await expect(page.getByRole("heading", { name: "员工账号", exact: true })).toBeVisible();
  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveCount(8);
  await expect(table.getByRole("columnheader", { name: /手机号.*已脱敏/ })).toBeVisible();
  await expect(table).toContainText("****");
  const allStaff = [...initialStaff.items];
  let currentStaff = initialStaff;
  const initialPageCount = Math.ceil(expectedStaffCount / 20);
  for (let pageNo = 1; pageNo <= initialPageCount; pageNo++) {
    if (pageNo > 1) {
      const nextList = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "GET" &&
          url.pathname === "/api/v1/admin/staff" &&
          url.searchParams.get("page") === String(pageNo) &&
          url.searchParams.get("pageSize") === "20"
        );
      });
      await page.getByRole("button", { name: "下一页", exact: true }).click();
      const response = await nextList;
      expect(response.status()).toBe(200);
      currentStaff = adminPage(StaffListItemSchema).parse((await response.json()).data);
      allStaff.push(...currentStaff.items);
    }
    expect(currentStaff.total).toBe(expectedStaffCount);
    expect(currentStaff.page).toBe(pageNo);
    expect(currentStaff.pageSize).toBe(20);
    expect(currentStaff.items).toHaveLength(pageItemCount(expectedStaffCount, 20, pageNo));
    await expect(table.getByRole("row")).toHaveCount(currentStaff.items.length + 1);
    for (const actor of currentStaff.items) {
      await expect(table.getByText(actor.name, { exact: true })).toHaveCount(1);
      await expect(table.getByText(actor.name, { exact: true })).toBeVisible();
    }
  }
  expect(allStaff).toHaveLength(expectedStaffCount);
  expect(new Set(allStaff.map((actor) => actor.staffId)).size).toBe(expectedStaffCount);
  for (const actor of addedActors) {
    expect(fixture.staff.map((item) => item.id)).not.toContain(actor.staffId);
    expect(allStaff.filter((item) => item.staffId === actor.staffId)).toEqual([
      expect.objectContaining({ ...actor }),
    ]);
  }
  for (let pageNo = initialPageCount; pageNo > 1; pageNo--) {
    await page.getByRole("button", { name: "上一页", exact: true }).click();
    await expect(page.getByLabel(`第 ${pageNo - 1} 页`, { exact: true })).toBeVisible();
  }
  await expect(table.getByText("演练交付", { exact: true })).toBeVisible();
  await expect(table.getByText("演练渠道", { exact: true })).toBeVisible();
  await expect(table.getByText("已禁用", { exact: true })).toBeVisible();
  await select(page, "每页条数", "10 条");
  await expect(table.getByRole("row")).toHaveCount(11);
  await shot(page, "staff-01-list");

  await select(page, "全部角色", "交付经理");
  await expect(page).toHaveURL(/roleKey=delivery_manager/);
  const addedManagers = w609Actors.filter((actor) => actor.roleKey === "delivery_manager");
  await expect(table.getByRole("row")).toHaveCount(3 + addedManagers.length);
  await expect(table.getByText("演练交付", { exact: true })).toBeVisible();
  await expect(table.getByText("W215原交付经理", { exact: true })).toBeVisible();
  for (const actor of addedManagers)
    await expect(table.getByText(actor.name, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重置筛选", exact: true }).click();
  await select(page, "全部状态", "已禁用");
  await expect(page).toHaveURL(/status=disabled/);
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByText("演练剪辑", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重置筛选", exact: true }).click();
  const keyword = page.getByRole("searchbox", { name: "搜索姓名或手机号后 4 位" });
  await keyword.fill(fixture.staff[0]!.phoneLast4);
  await keyword.press("Enter");
  await expect(page).toHaveURL(new RegExp(`q=${fixture.staff[0]!.phoneLast4}`));
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByText(fixture.staff[0]!.name, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重置筛选", exact: true }).click();
  await expect(page).toHaveURL(/pageSize=10/);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(table.getByRole("row")).toHaveCount(pageItemCount(expectedStaffCount, 10, 2) + 1);
  await page.reload();
  await expect(page.getByLabel("第 2 页", { exact: true })).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(pageItemCount(expectedStaffCount, 10, 2) + 1);
  const smallPageCount = Math.ceil(expectedStaffCount / 10);
  for (let pageNo = 3; pageNo <= smallPageCount; pageNo++) {
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`page=${pageNo}(?:&|$)`));
    await expect(table.getByRole("row")).toHaveCount(
      pageItemCount(expectedStaffCount, 10, pageNo) + 1,
    );
  }
  for (let pageNo = smallPageCount; pageNo > 1; pageNo--) {
    await page.getByRole("button", { name: "上一页", exact: true }).click();
    await expect(page.getByLabel(`第 ${pageNo - 1} 页`, { exact: true })).toBeVisible();
  }
  await noHorizontalScroll(page, "员工分页");

  await page.getByRole("button", { name: "＋ 新增员工", exact: true }).click();
  const form = page.getByRole("form", { name: "新增员工", exact: true });
  await form.getByRole("textbox", { name: "姓名", exact: true }).fill(fixture.newStaff.name);
  await form.getByRole("textbox", { name: "手机号", exact: true }).fill(fixture.newStaff.phone);
  await select(page, "角色", "交付经理");
  await expect(form.getByRole("textbox", { name: "数据范围", exact: true })).toHaveValue(
    "本人负责",
  );
  await expect(form.getByText("11/11", { exact: true })).toBeVisible();
  await expect(form.getByRole("checkbox", { name: "立即启用并生成激活码" })).toBeChecked();
  await shot(page, "staff-02-create");
  let creates = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/admin/staff")
      creates++;
  });
  // 两次同一事件循环的真实表单提交，验证React渲染禁用按钮前的同步锁。
  await ensureLiveStepUp(page);
  await form.evaluate((element) => {
    (element as HTMLFormElement).requestSubmit();
    (element as HTMLFormElement).requestSubmit();
  });
  const code = page.getByRole("dialog", { name: "员工激活码", exact: true }).locator("code");
  await expect(code).toHaveText(/^[A-Z0-9]{8}$/);
  await shot(page, "staff-03-activation");
  expect(creates).toBe(1);
  await page.getByRole("button", { name: "我已记下，关闭", exact: true }).click();
  await expect(code).toHaveCount(0);
  await expect(page).toHaveURL(`${context.origin}/sys/staff`);
  // 原名单完整保留；新员工按工号排序位于默认20条分页的末页，不扩大pageSize。
  const createdStaffCount = expectedStaffCount + 1;
  const createdPageCount = Math.ceil(createdStaffCount / 20);
  for (let pageNo = 2; pageNo <= createdPageCount; pageNo++) {
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`page=${pageNo}(?:&|$)`));
  }
  await expect(table.getByRole("row")).toHaveCount(
    pageItemCount(createdStaffCount, 20, createdPageCount) + 1,
  );
  const row = table.getByRole("row").filter({ hasText: fixture.newStaff.name });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("待激活");
  await expect(row.getByRole("button")).toHaveCount(1);
  await row.getByRole("button", { name: "查看 / 操作", exact: true }).click();
  const details = page.getByRole("dialog", { name: "员工详情", exact: true });
  await expect(details).toContainText(fixture.newStaff.name);
  await expect(details.getByRole("button", { name: "编辑员工", exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "禁用员工", exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "启用员工", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  const response = await page.request.get(
    `/api/v1/admin/staff?q=${fixture.newStaff.phone.slice(-4)}`,
  );
  expect(response.status()).toBe(200);
  const result = (await response.json()).data;
  expect(result.total).toBe(1);
  expect(result.items[0]).toMatchObject({
    name: fixture.newStaff.name,
    status: "active",
    isActivated: false,
    actions: [
      "update",
      "unlock",
      "handover",
      "reissue-activation-code",
      "disable",
      "reset-password",
      "reset-mfa",
      "bind-wecom",
      "invite-wecom",
    ],
  });
  await page.getByRole("button", { name: "＋ 新增员工", exact: true }).click();
  await expect(form.getByRole("textbox", { name: "姓名", exact: true })).toHaveValue("");
  await expect(form.getByRole("textbox", { name: "手机号", exact: true })).toHaveValue("");
  await expect(page.getByText(/^[A-Z0-9]{8}$/)).toHaveCount(0);
  await form.getByRole("button", { name: "取消", exact: true }).click();
  await noHorizontalScroll(page, "员工创建完成");
  expect(errors).toEqual([]);
});

// W223 后置：原员工验收全部完成后才创建自己的只读员工；不污染旧数量/筛选事实。
import { registerFlowOpsReadonlyTest } from "./w223-flow-ops-readonly";
registerFlowOpsReadonlyTest();

import { registerW206CreatedActivationTest } from "./w206-created-activation";
registerW206CreatedActivationTest();

// W216 own identities are created only after the original staff cases and existing postlude.
import { registerAgreementPermissionsTest } from "./w216-agreements-readonly";
registerAgreementPermissionsTest();
