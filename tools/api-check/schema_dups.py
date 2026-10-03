#!/usr/bin/env python3
"""找出各清单里同名的公共结构（同一 OpenAPI 文档内同名不同构 / 跨文档同名），以及同构不同名的候选。"""
import json, glob, os, collections, sys
TOOL = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(TOOL, '..', '..'))
W = os.path.join(ROOT, 'docs', 'api', 'working')
OUT = os.path.join(TOOL, 'out')
os.makedirs(OUT, exist_ok=True)
def grp(doc):
    return {'m': 'merchant', 'a': 'admin', 'p': 'portal', 'h': 'hooks', 'x': 'events'}[doc[0]]
defs = collections.defaultdict(list)
for f in sorted(glob.glob(os.path.join(W, 'frag', '*.json'))):
    d = json.load(open(f, encoding='utf8')); doc = os.path.basename(f)[:-5]
    for s in d.get('schemas', []) or []:
        if s.get('definedIn') and s['definedIn'] != doc: continue
        defs[s['name']].append((doc, tuple(sorted(s.get('fields') or []))))
out = []
P = lambda *a: out.append(' '.join(str(x) for x in a))
P('# 公共结构重名与同构核对\n')
P('## 1. 同名定义（多份清单都定义了同一个结构名）\n')
P('| 结构名 | 定义方（字段数） | 字段是否一致 | 字段差异 |'); P('| --- | --- | --- | --- |')
n = 0
for name, v in sorted(defs.items()):
    docs = sorted({d for d, _ in v})
    if len(v) < 2: continue
    n += 1
    fs = [set(f) for _, f in v]
    same = all(x == fs[0] for x in fs)
    diff = ''
    if not same:
        allf = set().union(*fs)
        diff = '；'.join(f'{d} 缺 {",".join(sorted(allf - set(f)))}' for d, f in v if allf - set(f))[:300]
    P(f'| `{name}` | {"、".join(f"{d}（{len(f)}）" for d, f in v)} | {"一致" if same else "不一致"} | {diff} |')
P(f'\n共 {n} 个。\n')
P('## 2. 同构不同名（字段集合相同、≥4 个字段、名字不同）\n')
by_fields = collections.defaultdict(set)
for name, v in defs.items():
    for d, f in v:
        if len(f) >= 4: by_fields[f].add((name, d))
m = 0
for f, ns in sorted(by_fields.items(), key=lambda x: -len(x[1])):
    names = {n for n, _ in ns}
    if len(names) > 1:
        m += 1
        P(f'- {"、".join(f"`{n}`（{d}）" for n, d in sorted(ns))}：{", ".join(f)}')
P(f'\n共 {m} 组。')
open(os.path.join(OUT, 'schema-dups.md'), 'w', encoding='utf8').write('\n'.join(out) + '\n')
print('\n'.join(out[:6])); print(f'同名 {n}，同构不同名 {m}')
