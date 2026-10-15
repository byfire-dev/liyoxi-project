/** 私有map的component + pair.path：未来上传name必须等于abs_path，dist等于component。 */
export type ClientErrorComponent = "admin" | "weapp";
export interface ClientErrorFrame {
  readonly filename: string;
  readonly abs_path: string;
  readonly lineno: number;
  readonly colno: number;
  readonly in_app: true;
}
const MAX_FRAMES = 50;
const rootScripts = new Set([
  "app.js",
  "common.js",
  "vendors.js",
  "taro.js",
  "babelHelpers.js",
  "comp.js",
  "portrait-platform.js",
  "publish-fixtures.js",
  "billing-fixtures.js",
  "custom-wrapper.js",
]);
function component(value: unknown): value is ClientErrorComponent {
  return value === "admin" || value === "weapp";
}
function artifactPath(kind: ClientErrorComponent, value: string): boolean {
  if (
    value.length > 300 ||
    !/^[A-Za-z0-9_./-]+$/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    return false;
  return kind === "admin"
    ? /^assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.js$/.test(value)
    : rootScripts.has(value) ||
        /^(?:pages\/[A-Za-z0-9_-]+|sub\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)+)\/index\.js$/.test(
          value,
        );
}
function coordinate(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2_147_483_647
  );
}
function localPath(kind: ClientErrorComponent, raw: string, origin?: string): string | undefined {
  if (
    raw.length > 512 ||
    /[%\\?#\s]/.test(raw) ||
    raw.split("/").some((part) => part === "." || part === "..")
  )
    return;
  let path: string;
  if (raw.startsWith(`app:///${kind}/`)) path = raw.slice(`app:///${kind}/`.length);
  else if (kind === "admin") {
    if (!origin) return;
    try {
      const url = new URL(raw),
        own = new URL(origin);
      if (
        !/^https?:$/.test(url.protocol) ||
        url.origin !== own.origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return;
      path = url.pathname.slice(1);
    } catch {
      return;
    }
  } else {
    // 只认已知本地bundle形态；不裁掉HTTP host或绝对服务器路径来冒认项目帧。
    path = raw.startsWith("/appservice/__APP__/")
      ? raw.slice("/appservice/__APP__/".length)
      : raw.replace(/^\//, "");
  }
  return artifactPath(kind, path) ? path : undefined;
}
function frame(
  kind: ClientErrorComponent,
  path: string,
  line: number,
  column: number,
): ClientErrorFrame {
  return {
    filename: path,
    abs_path: `app:///${kind}/${path}`,
    lineno: line,
    colno: column,
    in_app: true,
  };
}

/** V8/JSC/Taro常见file:line:column。未知/native/外部帧不猜坐标，不标in_app。Sentry按最早调用在前。 */
export function clientErrorFrames(
  stack: unknown,
  kind: ClientErrorComponent,
  origin?: string,
): readonly ClientErrorFrame[] {
  if (typeof stack !== "string" || stack.length > 32_768) return [];
  const result: ClientErrorFrame[] = [];
  for (const raw of stack.split("\n").slice(0, 100)) {
    let location = raw.trim();
    if (location.startsWith("at ")) {
      location = location.slice(3);
      if (location.endsWith(")")) {
        const wrapped = /^(?:(?:async|new) )?[A-Za-z0-9_.$<>[\]-]+ \((.*)\)$/.exec(location);
        if (!wrapped) continue;
        location = wrapped[1]!;
      }
    } else {
      const at = location.indexOf("@");
      if (at < 0) continue;
      location = location.slice(at + 1);
    }
    const match = /^(.*):(\d{1,10}):(\d{1,10})$/.exec(location);
    if (!match) continue;
    const line = Number(match[2]),
      column = Number(match[3]),
      path = localPath(kind, match[1]!, origin);
    if (path && coordinate(line) && coordinate(column))
      result.push(frame(kind, path, line, column));
    if (result.length === MAX_FRAMES) break;
  }
  return result.reverse();
}

function own(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && "value" in field ? field.value : undefined;
}
/** 映射只认组件/完整路径/正坐标；旧无dist帧仅留安全文件名，不透传源码上下文或vars。 */
export function cleanClientStacktrace(
  value: unknown,
  kind: unknown,
):
  | { readonly frames: readonly (ClientErrorFrame | Pick<ClientErrorFrame, "filename">)[] }
  | undefined {
  const frames = own(value, "frames");
  if (!Array.isArray(frames)) return;
  const result: (ClientErrorFrame | Pick<ClientErrorFrame, "filename">)[] = [];
  for (const item of frames.slice(0, MAX_FRAMES)) {
    const path = own(item, "filename"),
      absolute = own(item, "abs_path"),
      line = own(item, "lineno"),
      column = own(item, "colno");
    if (typeof path !== "string") continue;
    if (
      component(kind) &&
      artifactPath(kind, path) &&
      absolute === `app:///${kind}/${path}` &&
      coordinate(line) &&
      coordinate(column)
    )
      result.push(frame(kind, path, line, column));
    else if (
      kind === undefined &&
      absolute === undefined &&
      (artifactPath("admin", path) || artifactPath("weapp", path))
    )
      // 旧信封仅留安全相对文件名作诊断，不补坐标/abs_path/in_app冒认映射。
      result.push({ filename: path });
  }
  return result.length ? { frames: result } : undefined;
}
