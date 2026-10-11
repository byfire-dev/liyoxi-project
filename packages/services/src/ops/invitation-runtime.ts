import type { Assembly } from "../kernel/index.js";
import type { InvitationExpiry } from "../tenant/index.js";

/** 定时器闭包只属于本实例，未绑定或关闭不借用其他运行时。 */
export function createInvitationAssembly(base: Assembly) {
  if (base.timerHandlers.filter((item) => item.kind === "invitation.expire").length !== 1)
    throw new TypeError("邀请到期需要唯一处理器登记");
  let service: InvitationExpiry | undefined;
  let closed = false;
  const current = () => {
    if (closed || !service) throw new TypeError("本邀请运行时尚未绑定或已经关闭");
    return service;
  };
  const timerHandlers = base.timerHandlers.map((item) =>
    item.kind === "invitation.expire"
      ? { ...item, handle: (...args: Parameters<typeof item.handle>) => current().handle(...args) }
      : item,
  );
  const assembly: Assembly = {
    ...base,
    timerHandlers,
    timerHandler: (kind) => timerHandlers.find((item) => item.kind === kind),
  };
  return {
    assembly,
    attach(value: InvitationExpiry) {
      if (closed || service) throw new TypeError("邀请运行时只能绑定一次");
      service = value;
    },
    close() {
      closed = true;
      service = undefined;
    },
  };
}
