import type { Change } from "../components/delivery-api";
export const changeKinds = [
  ["launch_date", "上线日期"],
  ["account", "发布账号"],
  ["customization", "定制重点"],
  ["placement", "广告位置"],
  ["ad", "广告内容"],
  ["other", "其他"],
] as const;
export function changeBody(kinds: Change["kinds"], note: string): Change {
  if (
    !kinds.length ||
    kinds.length > 6 ||
    new Set(kinds).size !== kinds.length ||
    !note.trim() ||
    note.trim().length > 200
  )
    throw new Error("请选择修改项，并填写 1–200 字说明");
  return { kinds, note: note.trim() };
}
