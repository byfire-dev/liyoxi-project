#!/usr/bin/env python3
"""接口文档整体核对。读 working/routemap.json、working/frag/*.json、00-conventions.md、docs/api/*.md，
并连 tools/schema-check 留下的校验库核对“表.列”引用。有问题时退出码为 2。"""
import json, glob, os, re, subprocess, sys
from collections import defaultdict, Counter
TOOL = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(TOOL, '..', '..'))
API_DOCS = os.path.join(ROOT, 'docs', 'api')
W = os.path.join(API_DOCS, 'working')
OUT = os.path.join(TOOL, 'out')
os.makedirs(OUT, exist_ok=True)
rep = []
problems = 0
def P(*a):
    s = ' '.join(str(x) for x in a); print(s); rep.append(s)
def finish():
    P('\n## 结论')
    P('通过' if problems == 0 else f'有 {problems} 处问题')
    with open(os.path.join(OUT, 'api-check.md'), 'w', encoding='utf8') as fh: fh.write('\n'.join(rep) + '\n')
    sys.exit(0 if problems == 0 else 2)

rm = json.load(open(os.path.join(W, 'routemap.json'), encoding='utf8'))
frags = {}
for f in sorted(glob.glob(os.path.join(W, 'frag', '*.json'))):
    try: frags[os.path.basename(f)[:-5]] = json.load(open(f, encoding='utf8'))
    except Exception as e: P(f'!! {f} 不是合法 JSON：{e}'); problems += 1
P(f'# 接口文档核对\n\n路线图 {len(rm)} 条；清单文件 {len(frags)} 份')
if not rm or not frags:
    P('路线图或清单为空，无法核对'); problems += 1; finish()

def mentions(text, op):
    """整词匹配 operationId：`a.b.issue` 不算提到了 `a.b.issueRed` 或 `a.b.issue.x`。"""
    return re.search(r'(?<![A-Za-z0-9_.])' + re.escape(op) + r'(?![A-Za-z0-9_]|\.[A-Za-z])', text) is not None

# 1. 覆盖
P('\n## 1. 路线图接口是否都写进了文档')
by_doc = defaultdict(list)
for e in rm: by_doc[e['doc']].append(e)
dup_ops = [k for k, n in Counter(e['operationId'] for e in rm).items() if n > 1]
dup_paths = [k for k, n in Counter((e['method'], e['path']) for e in rm).items() if n > 1]
if dup_ops or dup_paths:
    P(f'- 路线图里重复的 operationId：{dup_ops}；重复的方法 + 路径：{dup_paths}'); problems += len(dup_ops) + len(dup_paths)
for doc, es in sorted(by_doc.items()):
    fr = frags.get(doc, {}); fops = {x.get('operationId') for x in fr.get('endpoints', [])}
    md = os.path.join(API_DOCS, doc + '.md')
    mdtxt = open(md, encoding='utf8').read() if os.path.exists(md) else ''
    miss_f = [e['operationId'] for e in es if e['operationId'] not in fops]
    miss_m = [e['operationId'] for e in es if not mentions(mdtxt, e['operationId'])]
    extra = sorted(fops - {e['operationId'] for e in es} - {None})
    problems += len(miss_f) + len(miss_m) + len(extra)
    P(f'- {doc}：路线图 {len(es)}；清单缺 {len(miss_f)}；文档缺 {len(miss_m)}；清单多出 {len(extra)}' + (f'（多出：{", ".join(extra[:8])}）' if extra else ''))
    for x in miss_f[:10]: P(f'    清单缺 {x}')
    for x in miss_m[:10]: P(f'    文档缺 {x}')
for doc in sorted(set(frags) - set(by_doc)):
    n = len(frags[doc].get('endpoints', []) or [])
    if n: P(f'- {doc}：清单里有 {n} 条接口，路线图里没有这份文档'); problems += n

# 2. 错误码
P('\n## 2. 错误码')
conv = open(os.path.join(API_DOCS, '00-conventions.md'), encoding='utf8').read()
m = re.search(r'\*\*C27 通用错误码清单。\*\*\s*\n(.*?)\n\s*\n', conv, re.S)
generic = set()
for line in (m.group(1) if m else '').split('\n'):
    c = [x.strip() for x in line.strip().strip('|').split('|')]
    if len(c) >= 3 and re.fullmatch(r'`[A-Z][A-Z0-9_]+`', c[0]): generic.add(c[0].strip('`'))
if not generic:
    P('没有从约定 C27 解析到通用错误码（标题或表格被改了？）'); problems += 1
defs = defaultdict(list)
for doc, fr in frags.items():
    for ec in fr.get('errorCodes', []) or []:
        defs[ec.get('symbol')].append((doc, ec.get('code'), ec.get('http')))
dup_sym = {k: v for k, v in defs.items() if len(v) > 1}
shadow = sorted(set(defs) & generic)
codes = Counter(c for v in defs.values() for _, c, _ in v)
dup_code = {c: n for c, n in codes.items() if n > 1}
RANGES = {
 'm01-account': [(41000,41099),(47400,47499)], 'm02-tenant': [(41100,41199)], 'm03-profile-asset': [(49000,49099),(46000,46099)],
 'm04-mall-order': [(45000,45099),(49300,49399)], 'm05-delivery-publish': [(45100,45199),(46100,46199)], 'm06-ad': [(45200,45299)],
 'm07-billing': [(43000,43099),(44000,44099)], 'm08-support-misc': [(45500,45599),(47000,47099)],
 'a01-system': [(48000,48199),(46400,46499),(47300,47399)], 'a02-workbench-report': [(47200,47299)],
 'a03-merchant': [(41300,41399),(48200,48299),(49100,49199),(46300,46399)], 'a04-content': [(49200,49299),(43200,43299)],
 'a05-order-delivery': [(45300,45499)], 'a06-publish': [(46200,46299)], 'a07-billing-finance': [(43100,43199),(44100,44299)],
 'a08-support': [(45600,45699)], 'a09-ops': [(47100,47199)], 'p01-portal': [(41200,41299),(46500,46599),(47500,47599)], 'h01-hooks': [(46600,46699)]}
oor = []
for sym, v in defs.items():
    for doc, c, h in v:
        try: c = int(c)
        except (TypeError, ValueError): oor.append((doc, sym, c)); continue
        if doc not in RANGES: oor.append((doc, sym, f'{c}（这份文档没有登记区间）'))
        elif not any(a <= c <= b for a, b in RANGES[doc]): oor.append((doc, sym, c))
used = defaultdict(set)
for doc, fr in frags.items():
    for e in fr.get('endpoints', []):
        for s in e.get('errors', []) or []: used[s].add(doc)
undef = sorted(s for s in used if s not in defs and s not in generic)
problems += len(undef) + len(dup_sym) + len(shadow) + len(dup_code) + len(oor)
P(f'通用码 {len(generic)} 个（约定 C27）；定义 {len(defs)} 个领域错误码；被引用的符号 {len(used)} 个')
P(f'- 未定义（既不在约定 C27，也不在任何清单）：{len(undef)} 个' + (f'：{", ".join(undef[:40])}' if undef else ''))
P(f'- 同一符号多处定义：{len(dup_sym)} 个' + ''.join(f'\n    {k}：{v}' for k, v in list(dup_sym.items())[:30]))
P(f'- 领域码与通用码重名：{len(shadow)} 个' + (f'：{", ".join(shadow)}' if shadow else ''))
P(f'- 同一数值被多个符号使用：{len(dup_code)} 个' + (f'：{list(dup_code.items())[:20]}' if dup_code else ''))
P(f'- 越出 A70 区间：{len(oor)} 个' + ''.join(f'\n    {d} {s} {c}' for d, s, c in oor[:30]))

# 3. 事件
P('\n## 3. 事件')
x01 = frags.get('x01-events-jobs', {})
evnames = {e.get('name') for e in x01.get('events', [])}
evused = defaultdict(set)
for doc, fr in frags.items():
    for e in fr.get('endpoints', []):
        for ev in e.get('events', []) or []: evused[ev].add(doc)
unk = sorted(ev for ev in evused if ev not in evnames)
problems += len(unk) + (0 if evnames else 1)
P(f'事件目录 {len(evnames)} 个；接口引用 {len(evused)} 个；不在目录里的 {len(unk)} 个' + (f'：{", ".join(unk[:50])}' if unk else ''))

# 4. 权限点与能力点（是否都在注册表里由 gen_permissions.py 核对）
P('\n## 4. 权限点与能力点')
perms = Counter(); caps = Counter()
for e in rm:
    if e.get('permission'): perms[e['permission']] += 1
    if e.get('capability'): caps[e['capability']] += 1
P(f'路线图引用权限点 {len(perms)} 个、能力点 {len(caps)} 个')

# 5. 表与列
P('\n## 5. 文档引用的表.列')
db = os.environ.get('API_CHECK_DB', 'lyx_schema_check')
cols = defaultdict(set)
try:
    r = subprocess.run(['psql', '-X', '-w', '-d', db, '-AtF', '\t', '-c', "select table_name, column_name from information_schema.columns where table_schema='public'"], capture_output=True, text=True)
    if r.returncode == 0:
        for line in r.stdout.strip().split('\n'):
            if line.count('\t') == 1: t, c = line.split('\t'); cols[t].add(c)
except FileNotFoundError:
    pass
db_ok = len(cols) >= 100  # 完整的校验库有 166 张表；连不上、没建完或连错库都按跳过处理
# 非列的点分标识：事件名、权限点、能力点、数据模型文档里出现过的点分名（迁移、不变量、定时器、参数键等）
known = set(evnames) | set(perms) | set(caps)
for fr in frags.values():
    for k in ('permissions', 'capabilities'):
        for x in fr.get(k, []) or []:
            if isinstance(x, str): known.add(x)
    for x in fr.get('permissionSupplements', []) or []:
        if isinstance(x, dict) and x.get('key'): known.add(x['key'])
for f in glob.glob(os.path.join(ROOT, 'docs', 'data-model', '*.md')):
    for t, c in re.findall(r'`([a-z][a-z0-9_]+)\.([a-z][a-z0-9_]+)`', open(f, encoding='utf8').read()):
        if not (t in cols and c in cols[t]): known.add(f'{t}.{c}')
known |= set(re.findall(r'`([a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*)`', conv))
# 深链路由键（AdminRouteKey、DeepLink 等，形如 ad.detail、drama.edit）与参数、开关键：从清单的 enums / 参数键与文档的路由键表里收集
for fr in frags.values():
    for k in ('paramsReferenced', 'paramKeys', 'proposedParams', 'flagsReferenced', 'proposedFlags', 'enums'):
        v = fr.get(k)
        for x in (v if isinstance(v, list) else (v.values() if isinstance(v, dict) else [])):
            for t in re.findall(r'[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*', json.dumps(x, ensure_ascii=False)): known.add(t)
for f in glob.glob(os.path.join(API_DOCS, '*.md')):
    t = open(f, encoding='utf8').read()
    for sec in re.findall(r'(?:AdminRouteKey|DeepLink|路由键)[^\n]*\n((?:[^\n]*\n){0,80})', t):
        known |= set(re.findall(r'`([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)`', sec))
rulings = open(os.path.join(W, 'api-rulings.md'), encoding='utf8').read()
known |= set(re.findall(r'`([a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*)`', rulings))
if not db_ok:
    P(f'（跳过，未核对：连不上校验库 {db}，或库里的表不全（读到 {len(cols)} 张）。先运行 `python3 tools/schema-check/check.py --keep`，或用环境变量 API_CHECK_DB 指定库名）')
else:
    bad = Counter()
    for f in sorted(glob.glob(os.path.join(API_DOCS, '*.md'))):
        for t, c in re.findall(r'`([a-z][a-z0-9_]+)\.([a-z][a-z0-9_]+)`', open(f, encoding='utf8').read()):
            if t in cols and c not in cols[t] and f'{t}.{c}' not in known: bad[(os.path.basename(f), f'{t}.{c}')] += 1
    problems += len(bad)
    P(f'校验库 {db}：{len(cols)} 张表。找不到的列引用 {len(bad)} 处（已排除事件名、权限点、能力点与数据模型文档里出现过的点分名）')
    for (f, tc), n in list(bad.items())[:80]: P(f'- {f}：`{tc}` ×{n}')

# 6. 文档里引用的 operationId 是否存在（各文档“修订记录”一节不查：那里保留了改名前的旧名）
P('\n## 6. 文档引用了不存在的 operationId')
ops = {e['operationId'] for e in rm}
for fr in frags.values():
    for e in fr.get('endpoints', []):
        if e.get('operationId'): ops.add(e['operationId'])
convtok = set(re.findall(r'`((?:m|admin|portal|hooks)\.[A-Za-z0-9_.]+)`', conv))
dang = Counter()
for f in sorted(glob.glob(os.path.join(API_DOCS, '*.md'))):
    txt = open(f, encoding='utf8').read()
    txt = re.sub(r'^## [^\n]*修订记录[^\n]*\n.*?(?=^## |\Z)', '', txt, flags=re.S | re.M)
    for tok in re.findall(r'`((?:m|admin|portal|hooks)\.[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+)`', txt):
        if tok in ops or tok in convtok or tok in known: continue
        if any(o.startswith(tok + '.') for o in ops): continue
        dang[(os.path.basename(f), tok)] += 1
problems += len(dang)
P(f'共 {len(dang)} 处（不含约定里登记的限流档位等名字，不含各文档的修订记录）')
for (f, tok), n in sorted(dang.items()): P(f'- {f}：`{tok}` ×{n}')
finish()
