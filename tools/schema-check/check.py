#!/usr/bin/env python3
"""校验数据模型草稿。

步骤：
1. 用 Prisma 7.9.1 对 docs/data-model/schema.prisma 做 format 检查与 validate；
2. 离线生成建表语句（prisma migrate diff --from-empty）；
3. 在一个临时数据库里执行建表语句，再按文件名顺序执行 docs/data-model/constraints/*.sql；
4. 逐列比对各分组文档里的字段表与库里的实际结构（列名、类型、可空）；
5. 扫描文档里“表.列”形式的引用，列出库里不存在的列。

前提：本目录已 npm install；本机可用 psql，并能以有建库权限的用户连上一个 PostgreSQL（14 及以上）。
连接参数用标准的 PG 环境变量（PGHOST、PGPORT、PGUSER、PGPASSWORD）。
临时库名默认 lyx_schema_check，**会先删除再新建**，所以库名必须以 lyx_ 开头。

用法：python3 tools/schema-check/check.py [--db 库名] [--keep]
"""
import argparse, glob, os, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
DM = os.path.join(ROOT, 'docs', 'data-model')
ap = argparse.ArgumentParser(description='校验数据模型草稿：在临时库里建表、执行约束，并与文档逐列比对')
ap.add_argument('--db', default='lyx_schema_check',
                help='临时库名（不是“要检查的库”）：会被删除后重建，必须以 lyx_ 开头；默认 lyx_schema_check')
ap.add_argument('--keep', action='store_true', help='保留临时库，便于手工查看（tools/api-check 也用它）')
args = ap.parse_args()
if not re.fullmatch(r'lyx_[a-z0-9_]{1,58}', args.db):
    sys.exit('--db 是临时库名，会被删除后重建：只接受以 lyx_ 开头、由小写字母、数字、下划线组成的名字')
if not os.path.isdir(os.path.join(HERE, 'node_modules', 'prisma')):
    sys.exit('没有找到 Prisma：先执行 cd tools/schema-check && npm install')

def say(s=''): print(s)
def psql(db, *a):
    # -X 不读 ~/.psqlrc；-w 不交互式要密码（缺密码时直接失败）
    return subprocess.run(['psql', '-X', '-w', '-d', db, *a], capture_output=True, text=True)

work = tempfile.mkdtemp(prefix='lyx-schema-')
created = False

def main():
    global created
    problems = 0
    # 1–2. Prisma
    shutil.copy(os.path.join(DM, 'schema.prisma'), os.path.join(work, 'schema.prisma'))
    with open(os.path.join(work, 'prisma.config.ts'), 'w', encoding='utf8') as fh:
        fh.write("import { defineConfig } from 'prisma/config'\n"
                 "export default defineConfig({ schema: './schema.prisma', datasource: { url: 'postgresql://localhost/unused' } })\n")
    os.symlink(os.path.join(HERE, 'node_modules'), os.path.join(work, 'node_modules'))
    def prisma(*a):
        return subprocess.run(['npx', '--no-install', 'prisma', *a], cwd=work, capture_output=True, text=True)
    r = prisma('format', '--check')
    if r.returncode != 0:
        say('提示：schema.prisma 不是 prisma format 的标准格式（不影响校验）')
    r = prisma('validate')
    if r.returncode != 0:
        say('Prisma validate 失败：\n' + r.stdout + r.stderr); return 1
    say('Prisma validate：通过')
    r = prisma('migrate', 'diff', '--from-empty', '--to-schema', 'schema.prisma', '--script')
    if r.returncode != 0:
        say('生成建表语句失败：\n' + r.stdout + r.stderr); return 1
    ddl = r.stdout[r.stdout.find('--'):].split('┌')[0]
    with open(os.path.join(work, 'schema.sql'), 'w', encoding='utf8') as fh: fh.write(ddl)
    n_tables = len(re.findall(r'^CREATE TABLE', ddl, flags=re.M))
    say(f'建表语句：{n_tables} 张表')
    if n_tables == 0:
        say('没有生成任何建表语句'); return 1

    # 3. 临时库
    say(f'临时库：{args.db}（PGHOST={os.environ.get("PGHOST", "本机默认")}，PGPORT={os.environ.get("PGPORT", "默认")}），删除后重建')
    psql('postgres', '-qc', f'DROP DATABASE IF EXISTS {args.db}')
    r = psql('postgres', '-qc', f'CREATE DATABASE {args.db}')
    if r.returncode != 0:
        say('无法建库（检查 PG 连接参数与权限）：\n' + r.stderr); return 1
    created = True
    def run_file(path):
        # 出错即停，按退出码判断成败：不依赖服务端报错信息的语言
        r = psql(args.db, '-q', '-v', 'ON_ERROR_STOP=1', '-f', path)
        return r.returncode, [l for l in r.stderr.split('\n') if l.strip()]
    rc, err = run_file(os.path.join(work, 'schema.sql'))
    if rc != 0:
        say('执行建表语句失败：\n' + '\n'.join(err[:20])); return 1
    say('执行建表语句：成功')
    files = sorted(glob.glob(os.path.join(DM, 'constraints', '*.sql')))
    if not files:
        say('没有找到 constraints/*.sql'); return 1
    for f in files:
        rc, err = run_file(f)
        n = len(re.findall(r';\s*$', open(f, encoding='utf8').read(), flags=re.M))
        say(f'  {os.path.basename(f)}：约 {n} 条' + ('，全部成功' if rc == 0 else '，执行失败（在第一处错误停下）'))
        if rc != 0:
            for l in err[:10]: say('    ' + l)
            problems += 1

    # 4. 文档与库结构
    q = psql(args.db, '-AtF', '\t', '-c',
             "select table_name, column_name, data_type, udt_name, is_nullable from information_schema.columns where table_schema='public'")
    cols = {}
    for line in q.stdout.strip().split('\n'):
        if line.count('\t') != 4: continue
        t, c, dt, udt, nul = line.split('\t'); cols.setdefault(t, {})[c] = (dt, udt, nul)
    if q.returncode != 0 or not cols:
        say('读不到库结构：\n' + q.stderr); return 1
    # 文档类型 → (data_type, udt_name；None 表示不比)
    TYPES = {'uuid': ('uuid', None), 'text': ('text', None), 'integer': ('integer', None), 'bigint': ('bigint', None),
             'boolean': ('boolean', None), 'timestamptz': ('timestamp with time zone', None), 'date': ('date', None),
             'jsonb': ('jsonb', None), 'smallint': ('smallint', None), 'bytea': ('bytea', None), 'numeric': ('numeric', None),
             'uuid[]': ('ARRAY', '_uuid'), 'text[]': ('ARRAY', '_text'), 'integer[]': ('ARRAY', '_int4')}
    diffs = 0; seen = set(); unknown_types = {}; unknown_null = 0
    for f in sorted(glob.glob(os.path.join(DM, '[0-9][0-9]-*.md'))):
        for sec in re.split(r'^###\s+', open(f, encoding='utf8').read(), flags=re.M)[1:]:
            m = re.match(r'[\d.]*\s*`([a-z_0-9]+)`', sec)
            if not m: continue
            t = m.group(1); rows = []; intab = False
            for line in sec.split('\n'):
                if re.match(r'^\|\s*列\s*\|', line): intab = True; continue
                if intab:
                    if not line.startswith('|'):
                        if rows: break
                        continue
                    cells = [c.strip() for c in line.strip().strip('|').split('|')]
                    if set(cells[0]) <= set('-: '): continue
                    rows.append(cells)
            if not rows: continue
            seen.add(t)
            if t not in cols:
                say(f'  {os.path.basename(f)}：文档有表 {t}，库里没有'); diffs += 1; continue
            doc = {c[0].replace('`', '').strip(): (c[1].replace('`', '').strip().lower(), c[2]) for c in rows}
            for c in sorted(set(doc) ^ set(cols[t])):
                say(f'  {t}.{c}：' + ('文档有、库里没有' if c in doc else '库里有、文档没有')); diffs += 1
            for c in sorted(set(doc) & set(cols[t])):
                typ, nul = doc[c]; dt, udt, isnul = cols[t][c]
                key = re.sub(r'\(.*\)', '', typ).strip()
                exp = TYPES.get(key)
                if exp is None:
                    unknown_types[key] = unknown_types.get(key, 0) + 1
                elif exp[0] != dt or (exp[1] and exp[1] != udt):
                    say(f'  {t}.{c}：文档 {typ}，库里 {dt}（{udt}）'); diffs += 1
                want = 'NO' if ('否' in nul or '不可' in nul) else 'YES' if '可' in nul else None
                if want is None: unknown_null += 1
                elif want != isnul: say(f'  {t}.{c}：文档可空“{nul}”，库里 {isnul}'); diffs += 1
    missing = sorted(t for t in cols if t not in seen and not re.match(r'.*_(default|y\d{4}m\d{2})$', t))
    say(f'文档与库结构：解析到 {len(seen)} 张表的字段表，差异 {diffs} 处' + (f'；库里有而文档没有字段表的：{missing}' if missing else ''))
    if unknown_types or unknown_null:
        say(f'  未比对：类型写法不认识的 {sum(unknown_types.values())} 列（{", ".join(sorted(unknown_types))}），可空写法不认识的 {unknown_null} 列')
        problems += sum(unknown_types.values()) + unknown_null
    if not seen:
        say('没有从文档里解析到任何字段表'); problems += 1
    problems += diffs + len(missing)

    # 5. 文档里引用的“表.列”（只提示，不计入结论：多数是 JSON 键、事件名、迁移名）
    stale = 0
    for f in sorted(glob.glob(os.path.join(DM, '[0-9][0-9]-*.md'))):
        for i, line in enumerate(open(f, encoding='utf8'), 1):
            for t, c in re.findall(r'`([a-z][a-z0-9_]+)\.([a-z][a-z0-9_]+)`', line):
                if t in cols and c not in cols[t]:
                    stale += 1
                    if stale <= 40: say(f'  {os.path.basename(f)}:{i}：`{t}.{c}` 库里没有这一列')
    say(f'文档里用反引号写的“表.列”引用：{stale} 处找不到对应的列（可能是 JSON 键或事件名，需人工判断；不计入结论）')

    say('\n结论：' + ('通过' if problems == 0 else f'有 {problems} 处问题'))
    return 0 if problems == 0 else 2

code = 1
try:
    code = main()
finally:
    # 失败时不留半成品库（否则 tools/api-check 会拿它去比）；成功且 --keep 才保留
    if created and not (args.keep and code == 0):
        psql('postgres', '-qc', f'DROP DATABASE IF EXISTS {args.db}')
    shutil.rmtree(work, ignore_errors=True)
sys.exit(code)
