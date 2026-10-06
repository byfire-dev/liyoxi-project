import type { AdminLiveFixture } from "./context.js";

const fixture: AdminLiveFixture = async ({ make, runtime }) => {
  const groups = await runtime.tx.run((tx) =>
    tx.staffGroup.findMany({ where: { isDefault: true } }),
  );
  const definitions = [
    {
      name: "演练交付",
      staffRoleKey: "delivery_manager",
      status: "active",
      isLead: false,
      wecomBindStatus: "none",
    },
    {
      name: "演练客服",
      staffRoleKey: "cs",
      status: "active",
      isLead: true,
      wecomBindStatus: "invited",
    },
    {
      name: "演练渠道",
      staffRoleKey: "channel_ops",
      status: "pending",
      isLead: false,
      wecomBindStatus: "none",
    },
    {
      name: "演练剪辑",
      staffRoleKey: "editor",
      status: "disabled",
      isLead: false,
      wecomBindStatus: "unbound",
    },
  ];
  // 加上 bootstrap 管理员共11行，足够验证10条分页的第二页，不依赖其他页面造数。
  for (let index = 1; index <= 6; index++) {
    definitions.push({
      name: `演练分页${index}`,
      staffRoleKey: "cs",
      status: "active",
      isLead: false,
      wecomBindStatus: "none",
    });
  }
  const staff = [];
  for (const definition of definitions) {
    const group = groups.find((item) => item.staffRoleKey === definition.staffRoleKey);
    if (!group) throw new Error("员工 live fixture 缺少种子默认组");
    const row = await make.staff({
      ...definition,
      staffGroupId: group.id,
      lastLoginAt: definition.status === "disabled" ? runtime.clock.now() : null,
      disabledAt: definition.status === "disabled" ? runtime.clock.now() : null,
      disabledReason: definition.status === "disabled" ? "other" : null,
    });
    staff.push({
      id: row.id,
      name: row.name,
      roleKey: row.staffRoleKey,
      status: row.status,
      phoneLast4: row.phoneLast4,
    });
  }
  // 工厂假号是139前缀，bootstrap是13800138001；这个专属本轮空库的188假号不与两者相交。
  return { staff, newStaff: { name: "演练新增", phone: "18800009991" } };
};
export default fixture;
