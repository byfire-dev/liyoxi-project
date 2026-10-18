import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import type { LiveContext } from "./live-context";

interface SessionPage {
  context(): { cookies(url: string): Promise<{ name: string; value: string }[]> };
}
interface Me {
  staff: { staffId: string };
  session: { staffSessionId: string; stepUpValidUntil: string };
  serverTime: string;
}
interface WriteResponse {
  status(): number;
  json(): Promise<unknown>;
}

// 仅 live 单 worker 的交接队列；不同 Page/context 都重新读取服务端的实际身份与会话。
export function createLiveStepUp(options: { contextFile: () => string; fetch: typeof fetch }) {
  let pending = Promise.resolve();
  function ensure(page: SessionPage, force = false): Promise<void> {
    const operation = pending.then(async () => {
      const file = options.contextFile();
      const context = JSON.parse(readFileSync(file, "utf8")) as LiveContext;
      const cookies = (await page.context().cookies(context.origin))
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
      const headers = { Origin: context.origin, "X-LYX-Admin": "1", Cookie: cookies };
      const readMe = async () => {
        const response = await options.fetch(`${context.origin}/api/v1/admin/auth/me`, {
          headers,
        });
        if (response.status !== 200)
          throw new Error(`读取本轮再验证身份失败：HTTP ${response.status}`);
        const me = ((await response.json()) as { data: Me }).data;
        if (!context.stepUp || me.staff.staffId !== context.stepUp.staffId)
          throw new Error("当前身份不是本轮恢复码所属管理员");
        if (!me.session.staffSessionId || !Number.isFinite(Date.parse(me.serverTime)))
          throw new Error("本轮再验证缺少真实会话或服务端时间");
        return me;
      };
      const me = await readMe();
      // 仅提前真实验证，避免读 me 与提交之间越界；不改变生产的十分钟窗口。
      const fresh = (value: Me) =>
        Date.parse(value.session.stepUpValidUntil) - Date.parse(value.serverTime) > 5_000;
      if (!force && fresh(me)) return;
      const code = context.stepUp!.recoveryCodes.shift();
      if (!code || !/^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(code))
        throw new Error("本轮管理员缺少未用的再验证恢复码");
      // 先落盘消费，网络失败也不重用；原生 fetch 不把恢复码送进 Playwright trace。
      chmodSync(file, 0o600);
      writeFileSync(file, `${JSON.stringify(context)}\n`, { mode: 0o600 });
      const response = await options.fetch(`${context.origin}/api/v1/admin/auth/step-up`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ method: "recovery", code }),
      });
      if (response.status !== 200) throw new Error(`本轮管理员再验证失败：HTTP ${response.status}`);
      const verified = await readMe();
      if (verified.session.staffSessionId !== me.session.staffSessionId || !fresh(verified))
        throw new Error("再验证后未读到原会话的有效回执");
    });
    pending = operation.catch(() => {});
    return operation;
  }

  async function write<T extends WriteResponse>(page: SessionPage, send: () => Promise<T>) {
    await ensure(page);
    const response = await send();
    if (response.status() === 403) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (body?.error === "STEP_UP_REQUIRED") {
        await ensure(page, true);
        return send();
      }
    }
    return response;
  }
  return { ensure, write };
}

const liveStepUp = createLiveStepUp({
  contextFile: () => {
    const file = process.env.LYX_ADMIN_LIVE_CONTEXT;
    if (!file) throw new Error("live 再验证需要本轮隔离环境的交接文件");
    return file;
  },
  fetch: (input, init) => fetch(input, init),
});
export const ensureLiveStepUp = liveStepUp.ensure;
export const writeWithLiveStepUp = liveStepUp.write;
