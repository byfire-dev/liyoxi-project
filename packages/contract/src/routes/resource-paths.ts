// 路径对着资源登记查（约定 C9–C11；移交表第 19 行 ②）：路径里的每个资源段都在资源登记里，
// 路径参数名与登记一致，视图别名在登记过的别名之内。资源登记在 ../resources（W0-09b）。
// 路径的形状：/<组>/(<资源>[/{参数}])*[/<动作>]。登记过的别名（完整路径）可以整段出现在开头，
// 如 /m/me、/m/store-profile/qualification；别名后面接它所属资源的参数、下一级资源或动作。
// 回调的第一段是渠道名（/hooks/asr/media-jobs/{mediaJobId}），连同下一段登记成一个资源名的
//（wechatpay/transactions）按两段认，其余的渠道名跳过。只登记的探活不在四组之内，不查。
import { RESOURCES } from "../resources/index.js";

import type { RouteCatalogEntry } from "./catalog.js";

const PARAM = /^\{([A-Za-z0-9]+)\}$/;

interface Registered {
  readonly param: string | null;
}

const byName = new Map<string, Registered>(RESOURCES.map((item) => [item.resource, item]));
const byAlias = new Map<string, Registered>(
  RESOURCES.flatMap((item) => item.aliases.map((alias) => [alias, item] as const)),
);
/** 别名按段数从多到少排：先认最长的 */
const aliases = [...byAlias.keys()].sort((a, b) => b.split("/").length - a.split("/").length);

/** 一条路径有哪些问题；没有问题返回空数组 */
export function resourcePathProblems(path: string): string[] {
  const problems: string[] = [];
  const all = path.split("/").slice(1);
  const group = all[0];
  let segments = all.slice(1);
  /** 刚认出来的资源：下一段若是参数，要与它登记的参数名相同 */
  let current: { name: string; def: Registered } | undefined;

  const alias = aliases.find((item) => path === item || path.startsWith(`${item}/`));
  if (alias !== undefined) {
    segments = all.slice(alias.split("/").length - 1);
    current = { name: alias, def: byAlias.get(alias) as Registered };
  }

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string;
    const param = PARAM.exec(segment)?.[1];
    if (param !== undefined) {
      if (current === undefined) {
        problems.push(`参数 {${param}} 前面没有资源段`);
      } else if (current.def.param !== param) {
        problems.push(
          current.def.param === null
            ? `资源 ${current.name} 登记为不按 id 访问，路径里却带了参数 {${param}}`
            : `资源 ${current.name} 的参数名登记为 {${current.def.param}}，路径里是 {${param}}`,
        );
      }
      current = undefined;
      continue;
    }
    const next = segments[index + 1];
    const twoSegments = next === undefined ? undefined : byName.get(`${segment}/${next}`);
    if (twoSegments !== undefined) {
      current = { name: `${segment}/${next}`, def: twoSegments };
      index += 1;
      continue;
    }
    const registered = byName.get(segment);
    if (registered !== undefined) {
      current = { name: segment, def: registered };
      continue;
    }
    current = undefined;
    // 回调的渠道名；最后一段的动作（/claim、/approve、/summary）。动作前面得有资源或别名，不能顶在组名后面
    if (group === "hooks" && index === 0) continue;
    if (index === segments.length - 1 && (index > 0 || alias !== undefined)) continue;
    problems.push(
      `段“${segment}”既不是登记过的资源，也不是末尾的动作，所在的路径也不在登记过的别名里`,
    );
  }
  return problems;
}

/** 整张清单的路径问题。V1.1 的路由只登记、资源多是占位，不查；探活不在四组之内，不查 */
export function catalogResourcePathProblems(catalog: readonly RouteCatalogEntry[]): string[] {
  return catalog
    .filter((entry) => entry.version === "V1.0" && !entry.registryKeyOnly)
    .flatMap((entry) =>
      resourcePathProblems(entry.path).map(
        (problem) => `${entry.operationId}（${entry.path}）：${problem}`,
      ),
    );
}
