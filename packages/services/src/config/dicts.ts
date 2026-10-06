// 字典读取（W0-18）。依据：14 分组 第 2.1、2.2、4.1 节；D6 第 4.1.3、4.1.4 节；m08 第 2.3、3.2 节。
//
// 整份字典进缓存。业务表存的是不可变的 code：字典项只停用、不删除，历史单据凭 code 永远查得到名称。
//   list            后台视图：一个类型的全部项，扩展属性原样
//   listForMerchant 小程序视图：只给小程序可见的类型，缺省只给可选的项，扩展属性只留白名单里的键
//   label           按编码取名称，不看启用状态（读历史数据用）
//   isSelectable    新选择时能不能选：启用，且行业为开放、区划为已开通
// 写接口对新选择的校验（选到停用项回 DICT_ITEM_DISABLED）随写侧的包，它调 isSelectable。
import { DICT_SELECTABLE_EXT_FLAG, MERCHANT_DICT_EXT_KEYS } from "@liyoxi/contract";

import { AppError } from "../kernel/index.js";

import type { ConfigCache } from "./cache.js";
import type { ConfigDb } from "./types.js";

export interface DictItemView {
  code: string;
  parentCode: string | null;
  name: string;
  description: string | null;
  isEnabled: boolean;
  tags: string[];
  ext: Record<string, unknown>;
  position: number;
  /** 新选择时是否可选 */
  isSelectable: boolean;
}

export interface DictTypeItems {
  typeKey: string;
  name: string;
  structure: string;
  /** 该类型的数据版本号：端上据此判断本地缓存是否过期 */
  versionNo: number;
  isMerchantVisible: boolean;
  /** 树按“上级在前、同级按 position”排列 */
  items: DictItemView[];
}

export interface DictListOptions {
  /** 只给这个编码的直接下级（行政区划懒加载） */
  parentCode?: string;
  /** 小程序视图：同时给出不可选的项（isSelectable = false），供端上把历史编码映射成名称 */
  includeDisabled?: boolean;
}

export interface Dicts {
  /** 后台下拉：复用同一缓存；默认仅启用项，完整展示列与类型版本一并给出。 */
  listForAdmin(
    typeKeys: readonly string[],
    options?: { parentCode?: string; scene?: string; includeDisabled?: boolean },
  ): Promise<{ items: AdminDictItem[]; types: Array<{ typeKey: string; versionNo: number }> }>;
  /** 各类型的数据版本号（引导接口的 versions.dict 由它得出） */
  versions(): Promise<Record<string, number>>;
  /** 后台视图。类型不存在即抛 NOT_FOUND */
  list(typeKey: string, options?: Pick<DictListOptions, "parentCode">): Promise<DictTypeItems>;
  /** 小程序视图，顺序同 typeKeys。类型不存在或小程序不可见、parentCode 用得不对，即抛 VALIDATION_FAILED */
  listForMerchant(typeKeys: readonly string[], options?: DictListOptions): Promise<DictTypeItems[]>;
  /** 名称；没有这个编码返回 null */
  label(typeKey: string, code: string): Promise<string | null>;
  isSelectable(typeKey: string, code: string): Promise<boolean>;
}

export interface DictsOptions {
  db: ConfigDb;
  cache: ConfigCache;
}

interface TypeState extends DictTypeItems {
  byCode: ReadonlyMap<string, DictItemView>;
  adminByCode: ReadonlyMap<string, AdminDictItem>;
}
export interface AdminDictItem extends Omit<DictItemView, "isSelectable"> {
  dictItemId: string;
  typeKey: string;
  refCount: null;
  updatedAt: string;
  lockVersion: number;
}
type DictState = ReadonlyMap<string, TypeState>;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** 上级在前、同级按 position（相同再按编码）；上级不在本类型里的项按一级排 */
function treeOrder(items: DictItemView[]): DictItemView[] {
  const codes = new Set(items.map((item) => item.code));
  const children = new Map<string | null, DictItemView[]>();
  for (const item of items) {
    const parent = item.parentCode !== null && codes.has(item.parentCode) ? item.parentCode : null;
    children.set(parent, [...(children.get(parent) ?? []), item]);
  }
  const ordered: DictItemView[] = [];
  const visit = (parent: string | null): void => {
    const level = [...(children.get(parent) ?? [])].sort(
      (a, b) => a.position - b.position || (a.code < b.code ? -1 : 1),
    );
    for (const item of level) {
      ordered.push(item);
      visit(item.code);
    }
  };
  visit(null);
  return ordered;
}

function pick(ext: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key in ext).map((key) => [key, ext[key]]));
}

export function createDicts(options: DictsOptions): Dicts {
  const { db, cache } = options;

  async function load() {
    const [types, rows] = await Promise.all([db.dictType.findMany(), db.dictItem.findMany()]);
    const byType = new Map<string, DictItemView[]>();
    const adminItems = new Map<string, AdminDictItem>();
    for (const row of rows) {
      const ext = asRecord(row.ext);
      const flag = DICT_SELECTABLE_EXT_FLAG[row.dictTypeKey];
      const item: DictItemView = {
        code: row.code,
        parentCode: row.parentCode,
        name: row.name,
        description: row.description,
        isEnabled: row.isEnabled,
        tags: row.tags,
        ext,
        position: row.position,
        isSelectable: row.isEnabled && (flag === undefined || ext[flag] === true),
      };
      byType.set(row.dictTypeKey, [...(byType.get(row.dictTypeKey) ?? []), item]);
      adminItems.set(`${row.dictTypeKey}:${row.code}`, {
        dictItemId: row.id,
        typeKey: row.dictTypeKey,
        code: item.code,
        parentCode: item.parentCode,
        name: item.name,
        description: item.description,
        isEnabled: item.isEnabled,
        tags: item.tags,
        ext: item.ext,
        position: item.position,
        refCount: null,
        updatedAt: row.updatedAt.toISOString(),
        lockVersion: row.lockVersion,
      });
    }
    const data = new Map<string, TypeState>();
    for (const type of types) {
      const items = treeOrder(byType.get(type.typeKey) ?? []);
      data.set(type.typeKey, {
        typeKey: type.typeKey,
        name: type.name,
        structure: type.structure,
        versionNo: type.versionNo,
        isMerchantVisible: type.isMerchantVisible,
        items,
        byCode: new Map(items.map((item) => [item.code, item])),
        adminByCode: new Map(
          items.map((item) => [item.code, adminItems.get(`${type.typeKey}:${item.code}`)!]),
        ),
      });
    }
    return { data: data as DictState };
  }

  const state = (): Promise<DictState> => cache.read("dict", load);

  const view = (type: TypeState, items: DictItemView[]): DictTypeItems => ({
    typeKey: type.typeKey,
    name: type.name,
    structure: type.structure,
    versionNo: type.versionNo,
    isMerchantVisible: type.isMerchantVisible,
    items,
  });

  const under = (items: DictItemView[], parentCode: string | undefined): DictItemView[] =>
    parentCode === undefined ? items : items.filter((item) => item.parentCode === parentCode);

  return {
    async listForAdmin(typeKeys, listOptions = {}) {
      const data = await state();
      const types = typeKeys.map((key) => {
        const type = data.get(key);
        if (type === undefined) throw new AppError("NOT_FOUND", { message: "字典类型不存在" });
        return type;
      });
      if (
        listOptions.parentCode !== undefined &&
        (types.length !== 1 || types[0]?.structure !== "tree")
      )
        throw new AppError("VALIDATION_FAILED", { message: "parentCode 只能与一个树形类型同用" });
      return {
        items: types.flatMap((type) =>
          under(type.items, listOptions.parentCode)
            .filter(
              (item) =>
                (listOptions.includeDisabled === true || item.isEnabled) &&
                (listOptions.scene === undefined ||
                  (type.typeKey === "reject_reason" && item.ext["scene"] === listOptions.scene)),
            )
            .map((item) => type.adminByCode.get(item.code)!),
        ),
        types: types.map((type) => ({ typeKey: type.typeKey, versionNo: type.versionNo })),
      };
    },
    async versions() {
      const types = await state();
      return Object.fromEntries([...types.values()].map((type) => [type.typeKey, type.versionNo]));
    },

    async list(typeKey, listOptions = {}) {
      const type = (await state()).get(typeKey);
      if (!type) throw new AppError("NOT_FOUND", { message: "字典类型不存在" });
      return view(type, under(type.items, listOptions.parentCode));
    },

    async listForMerchant(typeKeys, listOptions = {}) {
      const types = await state();
      const { parentCode, includeDisabled = false } = listOptions;
      const invalid = (message: string): AppError => new AppError("VALIDATION_FAILED", { message });
      return typeKeys.map((typeKey) => {
        const type = types.get(typeKey);
        if (!type?.isMerchantVisible) throw invalid("字典类型不存在");
        if (parentCode !== undefined && (typeKeys.length !== 1 || type.structure !== "tree")) {
          throw invalid("parentCode 只能与一个树形的字典类型同用");
        }
        const allowed = MERCHANT_DICT_EXT_KEYS[typeKey] ?? [];
        const items = under(type.items, parentCode)
          .filter((item) => includeDisabled || item.isSelectable)
          .map((item) => ({ ...item, ext: pick(item.ext, allowed) }));
        return view(type, items);
      });
    },

    async label(typeKey, code) {
      return (await state()).get(typeKey)?.byCode.get(code)?.name ?? null;
    },

    async isSelectable(typeKey, code) {
      return (await state()).get(typeKey)?.byCode.get(code)?.isSelectable ?? false;
    },
  };
}
