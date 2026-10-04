export interface Amount {
  readonly fen: number;
}

export function add(a: Amount, b: Amount): Amount {
  return { fen: a.fen + b.fen };
}
