#!/usr/bin/env python3
"""由路线图与各文档清单生成：接口索引、错误码登记表、共用领域码归属表（约定 C28 的表格）。
输出到 docs/api/ 与 tools/api-check/out/。"""
import json, glob, os, re, sys, collections
TOOL = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(TOOL, '..', '..'))
W = os.path.join(ROOT, 'docs', 'api', 'working')
OUT = os.path.join(TOOL, 'out')
os.makedirs(OUT, exist_ok=True)
DOCS = os.path.join(ROOT, 'docs', 'api')
rm = json.load(open(os.path.join(W, 'routemap.json'), encoding='utf8'))
frags = {os.path.basename(f)[:-5]: json.load(open(f, encoding='utf8')) for f in sorted(glob.glob(os.path.join(W, 'frag', '*.json')))}
TITLES = {}
for f in glob.glob(os.path.join(DOCS, '[maphx][0-9][0-9]-*.md')):
    first = open(f, encoding='utf8').readline().strip().lstrip('# ').strip()
    TITLES[os.path.basename(f)[:-3]] = first
GROUPS = [('merchant', '商家端（小程序）', '/api/v1/m', 'm'), ('admin', '运营管理后台', '/api/v1/admin', 'a'),
          ('portal', '电脑端下载页', '/api/v1/portal', 'p'), ('hooks', '外部回调与探活', '/api/v1/hooks', 'h')]
sec = {}
for doc, fr in frags.items():
    for e in fr.get('endpoints', []):
        sec[e.get('operationId')] = e.get('section')

def esc(s):
    return str(s or '').replace('|', '\\|').replace('\n', ' ')

def idem(e):
    x = e.get('xIdempotent') or ''
    if x == 'natural':
        by = e.get('idempotentBy') or []
        return 'natural' + (f'（{", ".join(by)}）' if by else '')
    return x

def auth(e):
    if e.get('permission'): return f'`{e["permission"]}`'
    if e.get('capability'): return f'`{e["capability"]}`'
    return '—'

# 1. 接口索引
by_doc = collections.defaultdict(list)
for e in rm: by_doc[e['doc']].append(e)
L = ['# 接口索引', '', '由 `working/routemap.json` 生成，请勿手改；每条接口的字段级定义见对应文档的章节。', '']
cnt = collections.Counter(e.get('version') for e in rm)
L += [f'共 {len(rm)} 条（V1.0 {cnt.get("V1.0", 0)}，V1.1 {cnt.get("V1.1", 0)}）。列说明：“判权”为后台权限点或商家端能力点（`assert-in-handler` 表示处理器内按对象判定，见约定 C66）；“幂等”见约定 C46–C50。', '']
L += ['| 端 | 前缀 | 文档 | 接口数 |', '| --- | --- | --- | --- |']
for g, name, prefix, p in GROUPS:
    docs = sorted(d for d in by_doc if d.startswith(p))
    L.append(f'| {name} | `{prefix}` | ' + '、'.join(f'[{d}]({d}.md)' for d in docs) + f' | {sum(len(by_doc[d]) for d in docs)} |')
L.append('')
for g, name, prefix, p in GROUPS:
    L += [f'## {name}', '']
    for d in sorted(x for x in by_doc if x.startswith(p)):
        L += [f'### [{TITLES.get(d, d)}]({d}.md)', '', '| operationId | 方法 | 路径 | 用途 | 判权 | 幂等 | 版本 | 章节 |', '| --- | --- | --- | --- | --- | --- | --- | --- |']
        for e in by_doc[d]:
            L.append(f'| `{e["operationId"]}` | {e["method"]} | `{esc(e["path"])}` | {esc(e.get("summary"))} | {auth(e)} | {esc(idem(e))} | {e.get("version") or ""} | {esc(sec.get(e["operationId"]))} |')
        L.append('')

# 2. 错误码登记表
conv = open(os.path.join(ROOT, 'docs', 'api', '00-conventions.md'), encoding='utf8').read()
generic = []
m = re.search(r'\*\*C27 通用错误码清单。\*\*(.*?)\n\n取舍', conv, re.S)
for line in (m.group(1) if m else '').split('\n'):
    c = [x.strip() for x in line.strip().strip('|').split('|')]
    if len(c) >= 5 and c[0].startswith('`'):
        generic.append({'symbol': c[0].strip('`'), 'http': c[1], 'code': c[2], 'retryable': c[3], 'meaning': c[4]})
if not generic:
    sys.exit('没有从约定 C27 解析到通用错误码（标题或表格被改了？），未写任何文件')
defs = {}
for doc, fr in frags.items():
    for ec in fr.get('errorCodes', []) or []:
        if ec['symbol'] in defs:
            sys.exit(f'错误码 {ec["symbol"]} 在 {defs[ec["symbol"]]["doc"]} 与 {doc} 两份清单里都有定义，未写任何文件（先跑 check.py）')
        if not str(ec.get('code', '')).isdigit() or 'http' not in ec:
            sys.exit(f'{doc} 的错误码 {ec["symbol"]} 缺数值或 HTTP 状态，未写任何文件')
        defs[ec['symbol']] = dict(ec, doc=doc)
used = collections.defaultdict(set)
for doc, fr in frags.items():
    for e in fr.get('endpoints', []):
        for s in e.get('errors', []) or []: used[s].add(doc)
E = ['# 错误码登记表', '', '由各文档的结构化清单（`working/frag/*.json`）与约定 C27 生成，请勿手改。错误体与分段规则见 [约定](00-conventions.md) 第 4 节；数值区间见裁决 A70。', '']
E += [f'## 1. 通用错误码（{len(generic)} 个，约定 C27）', '', '| 符号 | 数值 | HTTP | 可重试 | 何时 | 引用文档数 |', '| --- | --- | --- | --- | --- | --- |']
for g in generic:
    E.append(f'| `{g["symbol"]}` | {g["code"]} | {g["http"]} | {g["retryable"]} | {esc(g["meaning"])} | {len(used.get(g["symbol"], ()))} |')
E += ['', f'## 2. 领域错误码（{len(defs)} 个，按数值排序）', '', '| 符号 | 数值 | HTTP | 可重试 | 含义 | `details` | 定义方 | 其他引用方 |', '| --- | --- | --- | --- | --- | --- | --- | --- |']
for s, ec in sorted(defs.items(), key=lambda x: int(x[1]['code'])):
    others = sorted(used.get(s, set()) - {ec['doc']})
    E.append(f'| `{s}` | {ec["code"]} | {ec["http"]} | {"是" if ec.get("retryable") else "否"} | {esc(ec.get("meaning"))} | {esc(ec.get("details") or "—")} | [{ec["doc"]}]({ec["doc"]}.md) | {"、".join(others) or "—"} |')

# 3. 共用领域码归属表（约定 C28）：被定义方之外至少一份文档引用的领域码
C = ['| 符号 | 归属文档 | 数值 | HTTP | 引用方 | `details` |', '| --- | --- | --- | --- | --- | --- |']
shared = 0
for s, ec in sorted(defs.items(), key=lambda x: int(x[1]['code'])):
    others = sorted(used.get(s, set()) - {ec['doc']})
    if not others: continue
    shared += 1
    C.append(f'| `{s}` | {ec["doc"]} | {ec["code"]} | {ec["http"]} | {"、".join(others)} | {esc(ec.get("details") or "—")} |')

# 全部内容都生成成功后再落盘，避免只改了一半
for path, text in ((os.path.join(DOCS, 'registry-routes.md'), '\n'.join(L)), (os.path.join(DOCS, 'registry-errors.md'), '\n'.join(E) + '\n'), (os.path.join(OUT, 'c28-table.md'), '\n'.join(C) + '\n')):
    with open(path, 'w', encoding='utf8') as fh: fh.write(text)
print(f'接口索引 {len(rm)} 条；通用码 {len(generic)}；领域码 {len(defs)}；共用领域码 {shared}')
