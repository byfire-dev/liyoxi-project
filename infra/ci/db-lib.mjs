// 数据库检查脚本共用的部分（W0-05）：db-catalog-diff.mjs、db-verify-managed.mjs 与它们的用例、反例都引它。
// 连库的办法与 tools/schema-check/check.py 相同：psql 加标准的 PG* 环境变量。环境里没有 PGHOST 时，
// 从 DATABASE_URL 拆出主机、端口、用户、口令。连接串与口令只进子进程的环境变量：不进命令行参数，不打印。
// 本文件不引依赖，自己不是命令。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

/** 临时库名：会被删除后重建，只认 lyx_ 开头（与 check.py 同一条规矩） */
const TEMP_DB_NAME = /^lyx_[a-z0-9_]{1,58}$/;

/** 给 psql 的连接环境变量。database 为 true 时连库名一起从 DATABASE_URL 取（托管库验证用） */
export function pgEnv(source = process.env, { database = false } = {}) {
  if (source.PGHOST && !database) return {};
  if (!source.DATABASE_URL) {
    throw new Error(
      "没有连接参数：给 DATABASE_URL，或给 PGHOST、PGPORT、PGUSER、PGPASSWORD（本地的取值见 CLAUDE.md 第 9 节）",
    );
  }
  let url;
  try {
    url = new URL(source.DATABASE_URL);
  } catch {
    throw new Error("DATABASE_URL 不是合法的连接串");
  }
  const env = {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
  };
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  if (database) env.PGDATABASE = decodeURIComponent(url.pathname.slice(1));
  return env;
}

/** 跑一段 SQL（经标准输入给 psql），出错即停。返回 { status, stdout, stderr }，不抛错 */
export function psql(db, sql, env = pgEnv()) {
  const result = spawnSync("psql", ["-X", "-w", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", db], {
    input: sql,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error)
    return { status: -1, stdout: "", stderr: `psql 没跑起来：${result.error.message}` };
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** 同上，失败即抛错（报错里带 psql 的标准错误，不带连接参数） */
export function sqlOrThrow(db, sql, env) {
  const result = psql(db, sql, env);
  if (result.status !== 0) throw new Error(`库 ${db} 上的语句没跑成：${result.stderr.trim()}`);
  return result.stdout;
}

/** 删掉并重建一个临时库。template 给了就从那个库拷（那个库上不能有别的连接） */
export function recreateDb(name, { template, env } = {}) {
  if (!TEMP_DB_NAME.test(name) || (template && !TEMP_DB_NAME.test(template))) {
    throw new Error(`临时库会被删除后重建：只接受以 lyx_ 开头、由小写字母、数字、下划线组成的名字`);
  }
  dropDb(name, env);
  sqlOrThrow("postgres", `CREATE DATABASE ${name}${template ? ` TEMPLATE ${template}` : ""}`, env);
}

export function dropDb(name, env) {
  if (!TEMP_DB_NAME.test(name)) throw new Error(`只删以 lyx_ 开头的库，${name} 不删`);
  sqlOrThrow("postgres", `DROP DATABASE IF EXISTS ${name}`, env);
}

/** 比对的类别：前六类是验收标准（任务书 第 7 节第 4 条），最后一类是这六类盖不到的其余对象，一并比 */
export const CATEGORIES = [
  ["tables", "表"],
  ["columns", "列"],
  ["constraints", "约束定义"],
  ["indexes", "索引定义"],
  ["triggers", "触发器"],
  ["functions", "函数体"],
  [
    "others",
    "附：序列、扩展、视图与物化视图、外部表、类型（枚举、域、范围、复合）、模式、策略、规则、统计对象、事件触发器、注释",
  ],
];

// 一条语句把系统目录读成一个 JSON 文档。口径：
//   - 只看用户的模式（不看 pg_ 开头的与 information_schema）；_prisma_migrations 连同它的列、约束、索引不计。
//   - 每一行是 { key, def, … }：key 在本类里唯一，def 是要逐项相同的定义；其余字段只给计数用，不参与比对。
//   - part 表示“这一行挂在分区子表上”，两组口径就差在这里。
//   - “表”只收普通表与分区表，连 TOAST 选项一起比。列、约束、索引、触发器除了它们名下的，还收视图、物化视图、
//     外部表、独立的复合类型名下的：视图上的触发器、物化视图上的索引、外部表的列与约束、复合类型的属性都在这四类里比。
//   - 列连压缩方式（compression）与列选项（options，如 n_distinct）一起比。
//   - 约束连它名下内部触发器的启停一起比（internal_triggers）：外键靠这几个触发器校验，停用之后外键的定义不变。
//   - 触发器一类不收内部触发器本身（名字里有对象编号，两个库不同）；它们的启停见上一条。
//   - 函数不看扩展带进来的（btree_gist、pg_trgm 的函数落在 public 里；扩展按名字与版本在最后一类里比）。
//     聚合没有函数体：比它在 pg_aggregate 里的整行，外加并行安全与是否严格。
//   - 序列连当前值（state：last_value 与 is_called；迁移里有 ALTER SEQUENCE … RESTART）与持久性一起比。
//   - 最后一类里：视图与物化视图比定义，外部表比有没有（它的列与约束在前面几类里）；类型收枚举（取值）、
//     域（基类型、非空、默认值、CHECK）、范围与多范围（只比有没有）、独立的复合类型（属性在“列”里）。
//   - 最后一类里的策略、规则、统计对象、事件触发器、注释，首版迁移一样都不建（注释只有两个扩展自带的那两条）：
//     比的是“两边都没有多出来的”。注释不看系统对象与扩展成员的；16384 是用户对象编号的起点。
//   - 不比的（改了查不出）。以上各条点了名的才比；下面是试过或读查询读出来的，没列到的对象种类也按不比看待：
//       属主、授权、默认授权（迁移里不建角色、不写 GRANT，归 W0-06a）；统计信息；列与索引列的存储方式、统计目标；
//       表里的数据行（序列的当前值除外）；表空间、表的访问方法、类型化的表（CREATE TABLE … OF）所属的类型；
//       库级、角色级的设置（ALTER DATABASE … SET）；
//       排序规则、运算符与运算符类、类型转换、全文检索配置、过程语言、外部数据包装器、外部服务器、外部表的选项、
//       发布与订阅、安全标签、大对象；基础类型（CREATE TYPE … (INPUT = …)）、范围类型的子类型、域的排序规则；
//       视图与物化视图的存储选项、物化视图是否已填充；扩展带进来的函数、类型、运算符（只比扩展的名字与版本）。
export const CATALOG_SQL = `
set search_path to public;
with rel as (
  select c.oid, c.relispartition as part
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
     and c.relkind in ('r', 'p', 'v', 'm', 'f', 'c') and c.relname <> '_prisma_migrations'
), usr as (
  select oid from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema'
), ext as (
  select classid, objid from pg_depend where deptype = 'e'
)
select json_build_object(
  'version', current_setting('server_version'),
  'tables', (select json_agg(json_build_object('key', c.oid::regclass::text, 'part', r.part, 'def', json_build_object(
      'kind', c.relkind, 'persistence', c.relpersistence, 'partition_key', pg_get_partkeydef(c.oid),
      'partition_of', (select i.inhparent::regclass::text from pg_inherits i where i.inhrelid = c.oid),
      'partition_bound', pg_get_expr(c.relpartbound, c.oid), 'options', c.reloptions,
      'toast_options', (select t.reloptions from pg_class t where t.oid = c.reltoastrelid),
      'row_security', c.relrowsecurity, 'force_row_security', c.relforcerowsecurity,
      'replica_identity', c.relreplident)))
    from rel r join pg_class c on c.oid = r.oid and c.relkind in ('r', 'p')),
  'columns', (select json_agg(json_build_object('key', a.attrelid::regclass::text || '.' || a.attname, 'part', r.part,
      'def', json_build_object(
      'position', a.attnum, 'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull,
      'default', pg_get_expr(d.adbin, d.adrelid), 'identity', a.attidentity, 'generated', a.attgenerated,
      'compression', a.attcompression, 'options', a.attoptions,
      'collation', (select l.collname from pg_collation l join pg_type t on t.oid = a.atttypid
                     where l.oid = a.attcollation and a.attcollation <> t.typcollation))))
    from rel r join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum),
  'constraints', (select json_agg(json_build_object('key', k.conrelid::regclass::text || '.' || k.conname, 'part', r.part,
      'type', k.contype, 'def', json_build_object(
      'type', k.contype, 'definition', pg_get_constraintdef(k.oid), 'validated', k.convalidated,
      'deferrable', k.condeferrable, 'deferred', k.condeferred, 'no_inherit', k.connoinherit,
      'local', k.conislocal, 'inherit_count', k.coninhcount,
      'internal_triggers', (select json_agg(g.tgfoid::regproc::text || ' ' || g.tgenabled::text
                                   order by g.tgfoid::regproc::text, g.tgrelid::regclass::text)
                              from pg_trigger g where g.tgconstraint = k.oid and g.tgisinternal))))
    from rel r join pg_constraint k on k.conrelid = r.oid),
  'indexes', (select json_agg(json_build_object('key', i.indexrelid::regclass::text, 'part', r.part,
      'partial', i.indpred is not null, 'def', json_build_object(
      'table', i.indrelid::regclass::text, 'definition', pg_get_indexdef(i.indexrelid), 'unique', i.indisunique,
      'primary', i.indisprimary, 'exclusion', i.indisexclusion, 'immediate', i.indimmediate, 'valid', i.indisvalid,
      'ready', i.indisready, 'live', i.indislive, 'clustered', i.indisclustered, 'replica_identity', i.indisreplident,
      'parent', (select h.inhparent::regclass::text from pg_inherits h where h.inhrelid = i.indexrelid))))
    from rel r join pg_index i on i.indrelid = r.oid),
  'triggers', (select json_agg(json_build_object('key', t.tgrelid::regclass::text || '.' || t.tgname, 'part', r.part,
      'clone', t.tgparentid <> 0, 'def', json_build_object(
      'definition', pg_get_triggerdef(t.oid), 'enabled', t.tgenabled, 'clone', t.tgparentid <> 0)))
    from rel r join pg_trigger t on t.tgrelid = r.oid and not t.tgisinternal),
  'functions', (select json_agg(json_build_object('key', p.oid::regprocedure::text, 'def', json_build_object(
      'kind', p.prokind,
      'definition', case when p.prokind in ('f', 'p', 'w') then pg_get_functiondef(p.oid) else (
        select (to_jsonb(g) - 'aggfnoid' || jsonb_build_object('aggsortop', g.aggsortop::regoperator,
                'aggtranstype', g.aggtranstype::regtype, 'aggmtranstype', g.aggmtranstype::regtype,
                'parallel', p.proparallel, 'strict', p.proisstrict))::text
          from pg_aggregate g where g.aggfnoid = p.oid) end)))
    from pg_proc p where p.pronamespace in (select oid from usr)
     and not exists (select 1 from ext where classid = 'pg_proc'::regclass and objid = p.oid)),
  'others', (select json_agg(o) from (
    select json_build_object('key', '序列 ' || c.oid::regclass::text, 'def', json_build_object(
        'type', format_type(s.seqtypid, null), 'persistence', c.relpersistence,
        'start', s.seqstart::text, 'increment', s.seqincrement::text,
        'min', s.seqmin::text, 'max', s.seqmax::text, 'cache', s.seqcache::text, 'cycle', s.seqcycle,
        'state', (xpath('/row/state/text()', query_to_xml(format(
                   'select last_value || '' '' || is_called as state from %s', c.oid::regclass), false, true, '')))[1]::text,
        'owned_by', (select d.refobjid::regclass::text || '.' || a.attname from pg_depend d
                       join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
                      where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype in ('a', 'i')))) as o
      from pg_sequence s join pg_class c on c.oid = s.seqrelid where c.relnamespace in (select oid from usr)
    union all
    select json_build_object('key', '扩展 ' || e.extname, 'def', json_build_object(
        'version', e.extversion, 'schema', e.extnamespace::regnamespace::text)) from pg_extension e
    union all
    select json_build_object('key', '关系 ' || c.oid::regclass::text, 'def', json_build_object(
        'kind', c.relkind, 'definition', case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid) end))
      from pg_class c where c.relnamespace in (select oid from usr) and c.relkind in ('v', 'm', 'f')
    union all
    select json_build_object('key', '类型 ' || t.oid::regtype::text, 'def', json_build_object(
        'kind', t.typtype, 'base', format_type(t.typbasetype, t.typtypmod), 'not_null', t.typnotnull,
        'default', t.typdefault,
        'checks', (select json_agg(k.conname || ' ' || pg_get_constraintdef(k.oid) order by k.conname)
                     from pg_constraint k where k.contypid = t.oid),
        'labels', (select json_agg(l.enumlabel order by l.enumsortorder) from pg_enum l where l.enumtypid = t.oid)))
      from pg_type t where t.typnamespace in (select oid from usr)
       and (t.typtype in ('e', 'd', 'r', 'm') or (select c.relkind from pg_class c where c.oid = t.typrelid) = 'c')
       and not exists (select 1 from ext where classid = 'pg_type'::regclass and objid = t.oid)
    union all
    select json_build_object('key', '模式 ' || n.nspname, 'def', json_build_object('exists', true))
      from pg_namespace n where n.oid in (select oid from usr)
    union all
    select json_build_object('key', '策略 ' || p.polrelid::regclass::text || '.' || p.polname, 'def', json_build_object(
        'command', p.polcmd, 'permissive', p.polpermissive, 'roles', p.polroles::regrole[]::text[],
        'using', pg_get_expr(p.polqual, p.polrelid), 'check', pg_get_expr(p.polwithcheck, p.polrelid)))
      from pg_policy p
    union all
    select json_build_object('key', '规则 ' || w.ev_class::regclass::text || '.' || w.rulename, 'def', json_build_object(
        'definition', pg_get_ruledef(w.oid), 'enabled', w.ev_enabled))
      from pg_rewrite w join pg_class c on c.oid = w.ev_class
     where c.relnamespace in (select oid from usr) and w.rulename <> '_RETURN'
    union all
    select json_build_object('key', '统计对象 ' || s.stxnamespace::regnamespace::text || '.' || s.stxname, 'def',
        json_build_object('definition', pg_get_statisticsobjdef(s.oid)))
      from pg_statistic_ext s where s.stxnamespace in (select oid from usr)
    union all
    select json_build_object('key', '事件触发器 ' || e.evtname, 'def', json_build_object(
        'event', e.evtevent, 'function', e.evtfoid::regproc::text, 'enabled', e.evtenabled, 'tags', e.evttags))
      from pg_event_trigger e
    union all
    select json_build_object('key', '注释 ' || pg_describe_object(d.classoid, d.objoid, d.objsubid), 'def',
        json_build_object('text', d.description))
      from pg_description d where d.objoid >= 16384
       and not exists (select 1 from ext where classid = d.classoid and objid = d.objoid)
  ) x)
);`;

/** 把查询的输出解析成 { version, tables: [...], …, others: [...] }，每类按 key 排好序 */
export function parseCatalog(output) {
  const catalog = JSON.parse(output);
  for (const [id] of CATEGORIES) {
    catalog[id] = (catalog[id] ?? []).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  return catalog;
}

/** 读一个库的系统目录。只读不写 */
export const readCatalog = (db, env) => parseCatalog(sqlOrThrow(db, CATALOG_SQL, env));

/** 一类对象的差异，每条一句话：只在一边有的对象；两边都有而定义不同的，逐个字段列出 */
export function diffRows(refRows, targetRows) {
  const target = new Map(targetRows.map((row) => [row.key, row.def]));
  const seen = new Set();
  const problems = [];
  for (const { key, def } of refRows) {
    seen.add(key);
    const other = target.get(key);
    if (other === undefined) problems.push(`${key}：参照库有，迁移库没有`);
    else {
      for (const field of Object.keys({ ...def, ...other })) {
        const [a, b] = [JSON.stringify(def[field]), JSON.stringify(other[field])];
        if (a !== b) problems.push(`${key} 的 ${field} 不同：参照库 ${a}；迁移库 ${b}`);
      }
    }
  }
  for (const { key } of targetRows) {
    if (!seen.has(key)) problems.push(`${key}：迁移库有，参照库没有`);
  }
  return problems;
}

/** 一类对象的摘要：全部对象的名字与定义的 sha256 前 16 位。两个库的摘要相同，即这一类逐项相同 */
export const digestOf = (rows) =>
  createHash("sha256")
    .update(JSON.stringify(rows.map((row) => [row.key, row.def])))
    .digest("hex")
    .slice(0, 16);

/** 首版迁移应有的数量（06 第 1 节；任务书 第 7 节第 5 条）：[只数逻辑表, 含分区子表] */
export const EXPECTED_COUNTS = {
  表: [166, 171],
  "CHECK 约束": [1234, 1284],
  触发器: [121, 126],
  外键: [477, 477],
  排他约束: [1, 1],
  索引: [757, 782],
  部分索引: [168, 183],
};

/**
 * 两组口径的计数：[只数逻辑表, 含分区子表]。差在分区子表上：子表各继承父表的 CHECK，各带一个 TRUNCATE 触发器。
 * 父表的行级触发器在分区上的克隆不计（任务书 第 11 节第 4 项）。
 */
export function countsOf(catalog) {
  const both = (rows) => [rows.filter((row) => !row.part).length, rows.length];
  const typed = (type) => catalog.constraints.filter((row) => row.type === type);
  return {
    表: both(catalog.tables),
    "CHECK 约束": both(typed("c")),
    触发器: both(catalog.triggers.filter((row) => !row.clone)),
    外键: both(typed("f")),
    排他约束: both(typed("x")),
    索引: both(catalog.indexes),
    部分索引: both(catalog.indexes.filter((row) => row.partial)),
  };
}

/** 计数表（Markdown）与对不上的地方。named：[[这个库叫什么, 它的系统目录], …] */
export function countReport(named) {
  const lines = [
    `| 项 | 应为（逻辑表 / 含分区子表） | ${named.map(([name]) => name).join(" | ")} |`,
    `| --- | --- | ${named.map(() => "---").join(" | ")} |`,
  ];
  const problems = [];
  const counted = named.map(([name, catalog]) => [name, countsOf(catalog)]);
  for (const [item, expected] of Object.entries(EXPECTED_COUNTS)) {
    const want = expected.join(" / ");
    const cells = counted.map(([name, counts]) => {
      const got = counts[item].join(" / ");
      if (got !== want) problems.push(`${name}的${item}是 ${got}，应为 ${want}`);
      return got;
    });
    lines.push(`| ${item} | ${want} | ${cells.join(" | ")} |`);
  }
  return { lines, problems };
}
