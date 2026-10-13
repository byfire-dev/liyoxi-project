import { hasActiveWecomContact } from "../identity/index.js";
import { implementAdminProfileFacts } from "../profile/index.js";
import { readStoreManagerContact } from "../staff/index.js";

// L4只装配两个拥有者公口，避免staff/profile/identity之间增加同层同步依赖。
export const profileAdminStaffFacts = implementAdminProfileFacts("staff", async (tx, q) => ({
  isWecomAdded:
    q.ownerId !== null && q.managerId !== null
      ? await hasActiveWecomContact(tx, q.ownerId, q.managerId)
      : false,
  managerContact:
    q.managerId === null
      ? null
      : await readStoreManagerContact(tx, {
          storeId: q.storeId,
          managerId: q.managerId,
          now: q.now,
        }),
}));
