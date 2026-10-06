// 清单模板读取（W0-18）。依据：14 分组 第 2.8、4.7 节。
// 质检、交付前检查、链接核验、巡检、下架核查、账号核验共用一张表；编辑清单 = 新建一个版本并启用。
// 业务记录存模板编码与版本号：active 取当前启用的版本（提交检查结果时按它校验），
// version 按编码与版本号取当时的那一版（事后还原按哪一版清单检查）。草稿读不到。
import { ChecklistItemsSchema } from "@liyoxi/contract";
import type { CHECKLIST_TEMPLATE_CODE, ChecklistItem, EnumValue } from "@liyoxi/contract";

import type { ConfigCache } from "./cache.js";
import type { ConfigDb, ConfigReport } from "./types.js";

export type ChecklistCode = EnumValue<typeof CHECKLIST_TEMPLATE_CODE>;

export interface ChecklistTemplateView {
  code: ChecklistCode;
  versionNo: number;
  status: "active" | "retired";
  items: ChecklistItem[];
  activatedAt: Date | null;
  retiredAt: Date | null;
}

export interface Checklists {
  /** 当前启用的版本；没有返回 null */
  active(code: ChecklistCode): Promise<ChecklistTemplateView | null>;
  /** 某个版本（启用中或已停用）；草稿与不存在的版本返回 null */
  version(code: ChecklistCode, versionNo: number): Promise<ChecklistTemplateView | null>;
}

export interface ChecklistsOptions {
  db: ConfigDb;
  cache: ConfigCache;
  report?: ConfigReport;
}

interface ChecklistState {
  active: ReadonlyMap<string, ChecklistTemplateView>;
  byVersion: ReadonlyMap<string, ChecklistTemplateView>;
}

const versionKeyOf = (code: string, versionNo: number): string => `${code}@${String(versionNo)}`;

export function createChecklists(options: ChecklistsOptions): Checklists {
  const { db, cache, report } = options;

  async function load() {
    const rows = await db.checklistTemplate.findMany({
      where: { status: { in: ["active", "retired"] } },
      select: {
        code: true,
        versionNo: true,
        status: true,
        items: true,
        activatedAt: true,
        retiredAt: true,
      },
    });
    const active = new Map<string, ChecklistTemplateView>();
    const byVersion = new Map<string, ChecklistTemplateView>();
    for (const row of rows) {
      const items = ChecklistItemsSchema.safeParse(row.items);
      if (!items.success) {
        report?.({
          kind: "checklist_invalid",
          subject: versionKeyOf(row.code, row.versionNo),
          detail: "条目不合结构",
        });
        continue;
      }
      const template: ChecklistTemplateView = {
        code: row.code as ChecklistCode,
        versionNo: row.versionNo,
        status: row.status as "active" | "retired",
        items: items.data,
        activatedAt: row.activatedAt,
        retiredAt: row.retiredAt,
      };
      byVersion.set(versionKeyOf(row.code, row.versionNo), template);
      if (row.status === "active") active.set(row.code, template);
    }
    return { data: { active, byVersion } as ChecklistState };
  }

  const state = (): Promise<ChecklistState> => cache.read("checklist", load);

  return {
    async active(code) {
      return (await state()).active.get(code) ?? null;
    },
    async version(code, versionNo) {
      return (await state()).byVersion.get(versionKeyOf(code, versionNo)) ?? null;
    },
  };
}

/** W1-14 清单表单与管理列表的只读原始投影；不改变 active/version 的缓存语义。 */
export function listChecklistTemplates(
  db: ConfigDb,
  query: { code?: readonly string[]; status?: readonly string[]; allVersions?: boolean } = {},
) {
  return db.checklistTemplate.findMany({
    where: {
      ...(query.code ? { code: { in: [...query.code] } } : {}),
      status: {
        in: [
          ...(query.status ?? (query.allVersions ? ["draft", "active", "retired"] : ["active"])),
        ],
      },
    },
    orderBy: [{ code: "asc" }, { versionNo: "desc" }],
  });
}
