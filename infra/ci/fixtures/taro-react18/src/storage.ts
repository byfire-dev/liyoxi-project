export interface KeyValue {
  key: string;
  value: string;
}

export function toPairs(record: Record<string, string>): KeyValue[] {
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}
