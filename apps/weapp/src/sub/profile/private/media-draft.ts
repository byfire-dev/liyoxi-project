const DISPLAY_FIELDS = [
  "kind",
  "url",
  "expiresAt",
  "coverUrl",
  "durationMs",
  "displayWidth",
  "displayHeight",
  "moderationState",
] as const;

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isMedia = (value: RecordValue): value is RecordValue & { fileId: string } =>
  typeof value.fileId === "string" && typeof value.kind === "string" && Object.hasOwn(value, "url");

/** 同一文件的回显信息可以刷新；媒体成员与其他未保存输入仍归草稿。 */
export function refreshDraftMedia<D>(draft: D, source: unknown): D {
  const files = new Map<string, RecordValue>();
  const collect = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (isRecord(value)) {
      if (isMedia(value)) files.set(value.fileId, value);
      else Object.values(value).forEach(collect);
    }
  };
  collect(source);
  if (!files.size) return draft;

  const refresh = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const next = value.map(refresh);
      return next.some((item, index) => item !== value[index]) ? next : value;
    }
    if (!isRecord(value)) return value;
    let next: RecordValue | undefined;
    if (isMedia(value)) {
      const fresh = files.get(value.fileId);
      if (!fresh) return value; // 未保存的新上传或替换不能被旧 GET 回退。
      for (const field of DISPLAY_FIELDS)
        if (Object.hasOwn(fresh, field) && !Object.is(value[field], fresh[field])) {
          next ??= { ...value };
          next[field] = fresh[field]; // null 也必须采用，清除已撤销/不可用的旧地址。
        }
    } else {
      for (const [key, item] of Object.entries(value)) {
        const updated = refresh(item);
        if (updated !== item) {
          next ??= { ...value };
          next[key] = updated;
        }
      }
    }
    return next ?? value;
  };
  return refresh(draft) as D;
}
