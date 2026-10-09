/** Private bounded CI XML tree. No DTD/entity/attribute/mixed-content interpretation. */
export interface CiXml {
  readonly name: string;
  text: string;
  readonly children: CiXml[];
}
const bad = () => new TypeError("CI XML结构不合格");
const decode = (raw: string) =>
  raw.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (entity) => {
    const named: Record<string, string> = {
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&apos;": "'",
    };
    if (Object.hasOwn(named, entity)) return named[entity]!;
    const number =
      entity[2] === "x" ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    if (
      !Number.isInteger(number) ||
      (number < 32 && ![9, 10, 13].includes(number)) ||
      number > 0x10ffff ||
      (number >= 0xd800 && number <= 0xdfff)
    )
      throw bad();
    return String.fromCodePoint(number);
  });
export function parseCiXml(raw: string): CiXml {
  raw = raw.replace(/^\s*<\?xml\s+version="1\.0"(?:\s+encoding="(?:UTF-8|utf-8)")?\s*\?>/, "");
  if (/<!|<\?|&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(raw)) throw bad();
  const stack: CiXml[] = [];
  let root: CiXml | undefined;
  let cursor = 0,
    count = 0;
  for (const match of raw.matchAll(/<\/?[A-Za-z][A-Za-z0-9_]*(?:\s*\/)?\s*>/g)) {
    const text = raw.slice(cursor, match.index);
    if (text.includes("<") || text.includes(">")) throw bad();
    if (stack.length) stack.at(-1)!.text += decode(text);
    else if (text.trim()) throw bad();
    const token = match[0],
      name = token.match(/[A-Za-z][A-Za-z0-9_]*/)![0];
    if (token.startsWith("</")) {
      if (stack.at(-1)?.name !== name) throw bad();
      const one = stack.pop()!;
      if (one.children.length && one.text.trim()) throw bad();
    } else {
      const one: CiXml = { name, text: "", children: [] };
      if (++count > 10_000 || stack.length >= 32) throw bad();
      if (stack.length) stack.at(-1)!.children.push(one);
      else if (root) throw bad();
      else root = one;
      if (!token.endsWith("/>")) stack.push(one);
    }
    cursor = match.index! + token.length;
  }
  if (!root || stack.length || raw.slice(cursor).trim()) throw bad();
  return root;
}
export function ciChild(node: CiXml, name: string): CiXml | undefined {
  const values = node.children.filter((one) => one.name === name);
  if (values.length > 1) throw bad();
  return values[0];
}
export function ciText(node: CiXml, name: string): string | undefined {
  const one = ciChild(node, name);
  if (!one) return undefined;
  if (one.children.length) throw bad();
  return one.text;
}
