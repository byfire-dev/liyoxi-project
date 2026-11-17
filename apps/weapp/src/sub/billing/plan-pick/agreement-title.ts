export function agreementTitle(name: string): string {
  const title = name.trim();
  return title.startsWith("《") && title.endsWith("》") ? title : `《${title}》`;
}
