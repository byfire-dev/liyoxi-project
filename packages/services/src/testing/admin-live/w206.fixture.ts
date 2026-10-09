import { uuidv7 } from "../../kernel/index.js";
import { loadKeyring, openField } from "../../security/index.js";
import type { AdminLiveFixture } from "./context.js";

/** 复用原员工，保持既有列表基数；新建一个合法门店跟进作为真实移交前置。 */
const fixture: AdminLiveFixture = async ({ runtime }) =>
  runtime.tx.run(async (tx) => {
    const admin = await tx.staff.findFirstOrThrow({
      where: { staffRoleKey: "super_admin", status: "active" },
    });
    const editor = await tx.staff.findFirstOrThrow({
      where: { name: "演练剪辑", status: "disabled" },
    });
    const cs = await tx.staff.findFirstOrThrow({ where: { name: "演练客服", staffRoleKey: "cs" } });
    const recipient = await tx.staff.findFirstOrThrow({
      where: { name: "演练分页1", staffRoleKey: "cs", status: "active" },
    });
    const manager = await tx.staff.findFirstOrThrow({
      where: { name: "演练交付", staffRoleKey: "delivery_manager" },
    });
    const store = await tx.store.findFirstOrThrow({ orderBy: { id: "asc" } });
    const follow = await tx.followUp.create({
      data: {
        id: uuidv7(),
        subjectType: "store",
        subjectId: store.id,
        entityId: store.entityId,
        storeId: store.id,
        content: "W206员工移交演练",
        ownerStaffId: cs.id,
        nextFollowAt: runtime.clock.now(),
        actorType: "staff",
        actorId: admin.id,
        client: "admin",
        createdAt: runtime.clock.now(),
        updatedAt: runtime.clock.now(),
      },
    });
    const approvals = await tx.approvalRequest.findMany({
      where: { status: "pending" },
      select: { id: true, kind: true },
      orderBy: { id: "asc" },
    });
    const brief = (person: typeof admin) => ({
      id: person.id,
      name: person.name,
      staffNo: person.staffNo,
      roleKey: person.staffRoleKey,
    });
    return {
      admin: brief(admin),
      editor: {
        ...brief(editor),
        phone: openField(loadKeyring(runtime.env), "staff.phone_enc", editor.phoneEnc),
      },
      cs: brief(cs),
      recipient: brief(recipient),
      manager: brief(manager),
      followId: follow.id,
      approvals,
    };
  });
export default fixture;
