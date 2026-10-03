#!/usr/bin/env python3
"""汇总各接口文档“待确认”一节的表格行：文档、编号、问题、默认做法、谁定。输出 out/open-questions.json 与按决策方分组的统计。"""
import glob, json, os, re, collections
TOOL = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(TOOL, '..', '..'))
W = os.path.join(ROOT, 'docs', 'api', 'working')
OUT = os.path.join(TOOL, 'out')
os.makedirs(OUT, exist_ok=True)
rows = []
for f in sorted(glob.glob(os.path.join(ROOT, 'docs', 'api', '[maphx][0-9][0-9]-*.md'))):
    doc = os.path.basename(f)[:-3]
    lines = open(f, encoding='utf8').read().split('\n')
    start = next((i for i, l in enumerate(lines) if l.startswith('## ') and '待确认' in l), None)
    if start is None:
        continue
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith('## ')), len(lines))
    header = None
    for l in lines[start + 1:end]:
        if not l.startswith('|'):
            continue
        cells = [c.strip() for c in re.split(r'(?<!\\)\|', l.strip().strip('|'))]
        if header is None:
            header = cells
            continue
        if set(''.join(cells)) <= set('-: '):
            continue
        rec = dict(zip(header, cells))
        q = next((rec[k] for k in rec if k in ('问题', '事项', '待确认')), cells[1] if len(cells) > 1 else '')
        who = next((rec[k] for k in rec if k in ('谁定', '由谁定', '拍板', '决策方', '谁拍板', '责任方', '归属')), None)
        if who is None:  # 表里没有“谁定”一列：从问题里的括注取，如“（产品、设计）”
            m = re.search(r'（((?:产品|设计|业务|法务|财务|运营|研发|安全)[^（）]{0,12})）', q)
            tail = '、'.join(k for k in ('法务', '财务', '业务', '产品', '设计') if k in cells[-1]) if len(cells) > 3 else ''
            who = m.group(1) if m else (tail or '产品')
        if '已关闭' in who or q.startswith('~~'):  # 已由裁决关闭、留作记录的行不计
            continue
        d = next((rec[k] for k in rec if k.startswith('默认')), cells[2] if len(cells) > 2 else '')
        rows.append({'doc': doc, 'no': cells[0], 'question': q, 'default': d, 'who': who})
json.dump(rows, open(os.path.join(OUT, 'open-questions.json'), 'w', encoding='utf8'), ensure_ascii=False, indent=1)
byw = collections.Counter()
for r in rows:
    for w in re.split(r'[、，,＋+/]+', re.sub(r'（[^（）]*）|\s+', '', r['who'])):
        if w: byw[w] += 1
byd = collections.Counter(r['doc'] for r in rows)
print('共', len(rows), '项'); print(dict(byd)); print(byw.most_common(20))
