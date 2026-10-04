// 从 PDF 字节里读两样东西，不引解析库（任务书 第 5 节：不装解析 PDF 的库）。
// 依据：@react-pdf/renderer（pdfkit）写出的对象字典是明文，只有流内容被压缩。

/** 页对象的个数。用来与页脚回调拿到的总页数互相印证 */
export function countPageObjects(pdf: Buffer): number {
  return pdf.toString("latin1").match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
}

/**
 * 文件里用到的字体名（去掉子集前缀，去重，排序）。
 * 随附字体会以 “ABCDEF+NotoSerifSC-Regular” 的形式嵌入；出现 Helvetica 说明有字回退到了未嵌入的内置字体。
 */
export function listBaseFonts(pdf: Buffer): string[] {
  const names = new Set<string>();
  for (const match of pdf.toString("latin1").matchAll(/\/BaseFont\s*\/([^\s/<>[\]()]+)/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name.replace(/^[A-Z]{6}\+/, ""));
  }
  return [...names].sort();
}
