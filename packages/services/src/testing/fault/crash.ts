// 故障注入之二：进程中断（W0-05b）。起一个子进程跑一段场景，到指定的断点由父进程发 SIGKILL。
//
// 场景是一个模块（TypeScript 也行）导出的函数。场景里在想断的位置写 `await crashPoint("名字")`：
//   - 到了指定的断点：子进程停在那里等，父进程收到通知后立刻杀掉它。不给它任何收尾的机会，
//     与机器掉电、容器被强杀是一回事：没提交的事务由数据库回滚，没释放的锁由连接断开释放。
//   - 到了别的断点：只通知父进程一声，接着往下跑。
//   - 不在 runUntilCrash 起的子进程里（比如平时的用例直接调场景函数）：crashPoint 什么都不做。
// 子进程里的模块由 Vite 加载（与 Vitest 加载测试文件是同一套办法），能引工作区的包与 Prisma 客户端。
// 场景拿不到父进程里的对象：要用的连接串之类经 payload 传（能序列化成 JSON 的值）。
// 本文件不引 Vitest：它在子进程里也要被加载。本文件只交工具；拿它去压 worker 与三段式是 W0-20、W0-23 的事。

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const CHILD = fileURLToPath(new URL("./crash-child.mjs", import.meta.url));

/** 父子进程之间的约定：环境变量里放场景，进程间消息报断点 */
const SPEC_ENV = "LYX_CRASH_SPEC";

interface CrashSpec {
  module: string;
  exportName: string;
  payload: unknown;
  crashAt: string;
}

interface CrashPointMessage {
  lyxCrashPoint: string;
}

const isCrashPointMessage = (message: unknown): message is CrashPointMessage =>
  typeof message === "object" &&
  message !== null &&
  typeof (message as Partial<CrashPointMessage>).lyxCrashPoint === "string";

/** 子进程里读场景；不在 runUntilCrash 起的子进程里时是 undefined */
function readCrashSpec(): CrashSpec | undefined {
  const raw = process.env[SPEC_ENV];
  if (!raw || typeof process.send !== "function") return undefined;
  return JSON.parse(raw) as CrashSpec;
}

/**
 * 断点。写在场景里想断的位置。
 * 到了指定的断点就不再返回：通知父进程，然后原地等着被杀。
 */
export async function crashPoint(name: string): Promise<void> {
  const spec = readCrashSpec();
  const send = process.send?.bind(process);
  if (!spec || !send) return;
  await new Promise<void>((resolve, reject) => {
    send({ lyxCrashPoint: name } satisfies CrashPointMessage, (error: Error | null) =>
      error ? reject(error) : resolve(),
    );
  });
  if (name !== spec.crashAt) return;
  // 留一个定时器撑住事件循环，等父进程的 SIGKILL
  await new Promise<never>(() => {
    setInterval(() => {}, 60_000);
  });
}

export interface CrashRunOptions {
  /** 场景模块：绝对路径或 file: 地址。TypeScript 模块也行 */
  module: string | URL;
  /** 场景函数的导出名，缺省 default。它收一个参数：payload */
  exportName?: string;
  /** 传给场景函数的参数，要能序列化成 JSON */
  payload?: unknown;
  /** 在哪个断点杀掉子进程 */
  crashAt: string;
  /** 子进程到了指定断点、被杀之前，在父进程里先执行它（比如查一眼数据库里未提交的状态） */
  onReach?: () => void | Promise<void>;
  /** 另给子进程的环境变量 */
  env?: Record<string, string>;
  /** 等多久（毫秒），缺省 30 秒。到点还没结束就杀掉并报错 */
  timeoutMs?: number;
}

export interface CrashRunResult {
  /** 子进程是不是在指定断点被杀掉的 */
  killed: boolean;
  /** 子进程到过的断点，按先后 */
  reached: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** 子进程的标准输出与标准错误 */
  output: string;
}

/** 起子进程跑场景，到 crashAt 断点时发 SIGKILL。场景没走到那个断点就自己结束的，killed 为 false */
export function runUntilCrash(options: CrashRunOptions): Promise<CrashRunResult> {
  const spec: CrashSpec = {
    module: options.module instanceof URL ? fileURLToPath(options.module) : options.module,
    exportName: options.exportName ?? "default",
    payload: options.payload ?? null,
    crashAt: options.crashAt,
  };
  const timeoutMs = options.timeoutMs ?? 30_000;

  return new Promise((resolve, reject) => {
    const child = fork(CHILD, [], {
      env: { ...process.env, ...options.env, [SPEC_ENV]: JSON.stringify(spec) },
      // 不带父进程（Vitest worker）的启动参数
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const reached: string[] = [];
    let output = "";
    let killed = false;
    let failure: unknown;
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));

    const timer = setTimeout(() => {
      failure = new Error(
        `子进程 ${timeoutMs} 毫秒内没有结束，已杀掉。到过的断点：${reached.join("、")}`,
      );
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("message", (message) => {
      if (!isCrashPointMessage(message)) return;
      reached.push(message.lyxCrashPoint);
      if (message.lyxCrashPoint !== spec.crashAt || killed) return;
      killed = true;
      Promise.resolve()
        .then(() => options.onReach?.())
        .catch((error: unknown) => {
          failure = error;
        })
        .finally(() => child.kill("SIGKILL"));
    });
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (failure !== undefined) {
        reject(failure instanceof Error ? failure : new Error(String(failure)));
        return;
      }
      resolve({ killed: killed && signal === "SIGKILL", reached, exitCode, signal, output });
    });
  });
}
