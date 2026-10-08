import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { useTestDatabase } from "./testing/index.js";

// 真实隔离库、真实非超级用户 lyx_app；不靠模拟 DDL 或迁移口令桥接。
const db = useTestDatabase("db", { role: null, label: "apart" });
let owner: pg.Client;
let app: pg.Client;
let concurrent: pg.Client;
let readonly: pg.Client;

beforeAll(async () => {
  const url = await db.url();
  const client = (role?: string) => {
    const target = new URL(url);
    if (role) target.searchParams.set("options", `-c role=${role}`);
    return new pg.Client({ connectionString: target.toString() });
  };
  owner = client();
  app = client("lyx_app");
  concurrent = client("lyx_app");
  readonly = client("lyx_readonly");
  await Promise.all([owner.connect(), app.connect(), concurrent.connect(), readonly.connect()]);
  await app.query(
    "INSERT INTO public.analytics_event_dedup(event_id,received_at) VALUES ('fictional-side-dedup','2026-01-01T00:00:00Z'); INSERT INTO public.analytics_identity(anonymous_id,merchant_user_id,linked_at) VALUES ('10000000-0000-7000-8000-000000000001','10000000-0000-7000-8000-000000000002','2026-01-02T00:00:00Z')",
  );
});
afterAll(async () => {
  await Promise.all([owner?.end(), app?.end(), concurrent?.end(), readonly?.end()]);
});

const ENSURE = "public.lyx_14_analytics_event_ensure_partition";
const REPARTITION = "public.lyx_14_analytics_event_repartition_month";
async function ensure(month: string, client = app) {
  const result = await client.query<{ part: string }>(`SELECT ${ENSURE}($1::date) AS part`, [
    month,
  ]);
  return result.rows[0]?.part;
}
async function repartition(month: string, client = app) {
  const result = await client.query<{ moved: string }>(`SELECT ${REPARTITION}($1::date) AS moved`, [
    month,
  ]);
  return result.rows[0]?.moved;
}
async function state(action: Promise<unknown>) {
  try {
    await action;
    return "resolved";
  } catch (error) {
    return (error as { code?: string }).code;
  }
}
async function relation(name: string) {
  const result = await owner.query<{ oid: string | null }>("SELECT to_regclass($1)::text AS oid", [
    `public.${name}`,
  ]);
  return result.rows[0]?.oid;
}
async function guards(name: string) {
  return (
    await owner.query(
      "SELECT tgname, tgfoid::regprocedure::text AS function, tgtype, tgenabled, tgparentid <> 0 AS cloned FROM pg_trigger WHERE tgrelid = $1::regclass ORDER BY tgname",
      [`public.${name}`],
    )
  ).rows;
}
async function rows(ids: string[]) {
  // 用 jsonb 的 SQL 表示保留完整 21 列和 timestamptz 精度，避免 JS Date 毫秒截断。
  return (
    await owner.query(
      "SELECT to_jsonb(e) AS row, tableoid::regclass::text AS part FROM public.analytics_event e WHERE id = ANY($1::uuid[]) ORDER BY id",
      [ids],
    )
  ).rows;
}
async function fixture(
  occurredAt: string,
  source: "client" | "direct" | "outbox" = "direct",
): Promise<string> {
  const id = randomUUID();
  const actor = randomUUID();
  await app.query(
    `INSERT INTO public.analytics_event (
    occurred_at,id,event_id,name,source,actor_type,actor_id,client,merchant_user_id,
    anonymous_id,role,entity_id,store_id,city_code,category_code,client_platform,
    client_version,session_id,scene,props,received_at
  ) VALUES ($1,$2,$3,'partition_test',$4,'merchant',$5,'weapp',$5,$6,'owner',$7,$8,
    '310100','fixture_category','fictional_platform','fictional_version',$9,1001,
    '{"fictional":true,"nested":{"n":3},"array":[1,2]}'::jsonb,'2026-01-02T03:04:05.123456Z')`,
    [
      occurredAt,
      id,
      `fixture-${id}`,
      source,
      actor,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ],
  );
  return id;
}
async function sideTables() {
  return (
    await owner.query(
      "SELECT (SELECT jsonb_agg(to_jsonb(d) ORDER BY event_id) FROM public.analytics_event_dedup d) AS dedup, (SELECT jsonb_agg(to_jsonb(i) ORDER BY anonymous_id) FROM public.analytics_identity i) AS identity",
    )
  ).rows;
}

describe("固定月份分区能力的权限与对象验证", () => {
  it("真实 lyx_app 非超级用户能建分区，PUBLIC/readonly 无 EXECUTE，表权限不扩大", async () => {
    expect(
      (
        await app.query(
          "SELECT current_user AS role, rolsuper FROM pg_roles WHERE rolname=current_user",
        )
      ).rows,
    ).toEqual([{ role: "lyx_app", rolsuper: false }]);
    expect(await ensure("2600-01-01")).toBe("analytics_event_y2600m01");
    expect(await state(ensure("2600-02-01", readonly))).toBe("42501");
    expect(await state(repartition("2600-02-01", readonly))).toBe("42501");
    const publicPrivileges = await owner.query(
      "SELECT p.proname FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid IN ($1::regprocedure,$2::regprocedure) AND a.grantee=0",
      [`${ENSURE}(date)`, `${REPARTITION}(date)`],
    );
    expect(publicPrivileges.rows).toEqual([]);
    expect(
      (
        await owner.query(
          "SELECT has_table_privilege('lyx_app','public.analytics_event_y2600m01','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS app, has_table_privilege('lyx_readonly','public.analytics_event_y2600m01','SELECT') AS readonly",
        )
      ).rows,
    ).toEqual([{ app: false, readonly: true }]);
    for (const sql of [
      "CREATE TABLE public.partition_denied(id int)",
      "ALTER TABLE public.analytics_event ADD COLUMN denied int",
      "UPDATE public.analytics_event SET name='denied'",
      "DELETE FROM public.analytics_event",
      "TRUNCATE public.analytics_event",
      "SELECT * FROM public.analytics_event_y2600m01",
    ]) {
      expect(await state(app.query(sql))).toBe("42501");
    }
    expect(await state(owner.query("TRUNCATE public.analytics_event_y2600m01"))).toBe("23001");
  });

  it.each([null, "infinity", "-infinity", "2600-02-02", "0001-01-01 BC", "10000-01-01"])(
    "两入口拒绝非法月首 %s",
    async (month) => {
      for (const fn of [ENSURE, REPARTITION]) {
        expect(await state(app.query(`SELECT ${fn}($1::date)`, [month]))).toBe("22023");
      }
    },
  );

  it("不存在的公历日期由真实 date 解析拒绝", async () => {
    expect(await state(ensure("2600-02-30"))).toBe("22008");
  });

  it("并发重复建同一月只产生一个真实子分区且 guards 完整", async () => {
    expect(await Promise.all([ensure("2600-03-01"), ensure("2600-03-01", concurrent)])).toEqual([
      "analytics_event_y2600m03",
      "analytics_event_y2600m03",
    ]);
    expect(await guards("analytics_event_y2600m03")).toEqual([
      {
        tgname: "trg_analytics_event_append_only",
        function: "lyx_forbid_mutation()",
        tgtype: 27,
        tgenabled: "O",
        cloned: true,
      },
      {
        tgname: "trg_analytics_event_y2600m03_no_truncate",
        function: "lyx_forbid_mutation()",
        tgtype: 34,
        tgenabled: "O",
        cloned: false,
      },
    ]);
  });

  it("当前、历史 0001 年及 9999 年末的真实 bound 与上海月界一致", async () => {
    const current = (
      await owner.query<{ month: string }>(
        "SELECT to_char((now() AT TIME ZONE 'Asia/Shanghai')::date,'YYYY-MM-01') AS month",
      )
    ).rows[0]?.month;
    for (const month of [current!, "0001-01-01", "1900-01-01", "9999-12-01"]) {
      const part = await ensure(month);
      await owner.query("SET TimeZone='UTC'; SET DateStyle='ISO,YMD'");
      const result = await owner.query(
        "SELECT pg_get_expr(c.relpartbound,c.oid,true) AS bound, format('FOR VALUES FROM (%L) TO (%L)', $2::date::timestamp AT TIME ZONE 'Asia/Shanghai', ($2::date + interval '1 month')::timestamp AT TIME ZONE 'Asia/Shanghai') AS expected FROM pg_class c WHERE c.oid=$1::regclass",
        [`public.${part}`, month],
      );
      expect(result.rows[0]?.bound).toBe(result.rows[0]?.expected);
    }
  });

  it("default 有当月行时普通 ensure 失败，不偷搬数据或改 guard", async () => {
    const id = await fixture("2601-01-15T00:00:00Z");
    const before = await rows([id]);
    const beforeGuards = await guards("analytics_event_default");
    expect(await state(ensure("2601-01-01"))).toBe("23514");
    expect(await relation("analytics_event_y2601m01")).toBeNull();
    expect(await rows([id])).toEqual(before);
    expect(await guards("analytics_event_default")).toEqual(beforeGuards);
  });

  it("拒绝同名普通表、错误真实 bound、错误 owner、disabled 或错误函数的 guard", async () => {
    await owner.query("CREATE TABLE public.analytics_event_y2602m01(id int)");
    expect(await state(ensure("2602-01-01"))).toBe("55000");
    await owner.query(
      "CREATE TABLE public.analytics_event_y2602m02 PARTITION OF public.analytics_event FOR VALUES FROM ('2602-02-02T00:00:00+08') TO ('2602-03-01T00:00:00+08')",
    );
    expect(await state(ensure("2602-02-01"))).toBe("55000");
    await ensure("2602-03-01");
    await owner.query("ALTER TABLE public.analytics_event_y2602m03 OWNER TO lyx_readonly");
    expect(await state(ensure("2602-03-01"))).toBe("55000");
    await owner.query("ALTER TABLE public.analytics_event_y2602m03 OWNER TO CURRENT_USER");
    await owner.query(
      "ALTER TABLE public.analytics_event_y2602m03 DISABLE TRIGGER trg_analytics_event_append_only",
    );
    expect(await state(ensure("2602-03-01"))).toBe("55000");
    await owner.query(
      "ALTER TABLE public.analytics_event_y2602m03 ENABLE TRIGGER trg_analytics_event_append_only",
    );
    await owner.query(
      "CREATE FUNCTION public.lyx_test_wrong_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; DROP TRIGGER trg_analytics_event_y2602m03_no_truncate ON public.analytics_event_y2602m03; CREATE TRIGGER trg_analytics_event_y2602m03_no_truncate BEFORE TRUNCATE ON public.analytics_event_y2602m03 FOR EACH STATEMENT EXECUTE FUNCTION public.lyx_test_wrong_guard()",
    );
    expect(await state(ensure("2602-03-01"))).toBe("55000");
  });

  it("parent/default 的 guard 被停用时拒绝，恢复后数据与其他 guard 原样", async () => {
    const id = await fixture("2603-04-15T00:00:00Z");
    const before = await rows([id]);
    const original = await guards("analytics_event_default");
    await owner.query(
      "ALTER TABLE public.analytics_event DISABLE TRIGGER trg_analytics_event_append_only",
    );
    try {
      expect(await state(ensure("2603-04-01"))).toBe("55000");
      expect(await state(repartition("2603-04-01"))).toBe("55000");
    } finally {
      await owner.query(
        "ALTER TABLE public.analytics_event ENABLE TRIGGER trg_analytics_event_append_only",
      );
    }
    await owner.query(
      "ALTER TABLE ONLY public.analytics_event_default DISABLE TRIGGER trg_analytics_event_default_no_truncate",
    );
    try {
      expect(await state(repartition("2603-04-01"))).toBe("55000");
    } finally {
      await owner.query(
        "ALTER TABLE ONLY public.analytics_event_default ENABLE TRIGGER trg_analytics_event_default_no_truncate",
      );
    }
    expect(await rows([id])).toEqual(before);
    expect(await guards("analytics_event_default")).toEqual(original);
    expect(await relation("analytics_event_y2603m04")).toBeNull();
  });
});

describe("default 单月修复的完整性与原子性", () => {
  it("上海两端边界、全列/PK/来源/收件时刻原样；其他月与两表不变，重复返回 0", async () => {
    const ids = [
      await fixture("2610-03-31T15:59:59.999Z"),
      await fixture("2610-03-31T16:00:00Z", "client"),
      await fixture("2610-04-15T01:02:03.456789Z", "outbox"),
      await fixture("2610-04-30T15:59:59.999Z"),
      await fixture("2610-04-30T16:00:00Z"),
    ];
    const before = await rows(ids);
    const other = await sideTables();
    const beforeGuards = await guards("analytics_event_default");
    expect(await repartition("2610-04-01")).toBe("3");
    const after = await rows(ids);
    expect(after.map((x) => x.row)).toEqual(before.map((x) => x.row));
    for (const row of after) {
      const id = (row.row as { id: string }).id;
      expect(row.part).toBe(
        ids.slice(1, 4).includes(id) ? "analytics_event_y2610m04" : "analytics_event_default",
      );
    }
    expect(await guards("analytics_event_default")).toEqual(beforeGuards);
    expect((await guards("analytics_event_y2610m04")).every((g) => g.tgenabled === "O")).toBe(true);
    expect(await sideTables()).toEqual(other);
    expect(await repartition("2610-04-01")).toBe("0");
    expect(
      (await app.query("SELECT to_regclass('pg_temp.lyx_analytics_repartition_buffer') AS temp"))
        .rows,
    ).toEqual([{ temp: null }]);
  });

  it("caller 已有同名 temp 不覆盖、不删除，public 与 search_path 影子不被访问", async () => {
    const id = await fixture("2611-05-15T00:00:00Z");
    const before = await rows([id]);
    await app.query(
      "CREATE TEMP TABLE lyx_analytics_repartition_buffer(marker text); INSERT INTO lyx_analytics_repartition_buffer VALUES ('caller-owned')",
    );
    expect(await state(repartition("2611-05-01"))).toBe("55000");
    expect(
      (await app.query("SELECT * FROM pg_temp.lyx_analytics_repartition_buffer")).rows,
    ).toEqual([{ marker: "caller-owned" }]);
    expect(await rows([id])).toEqual(before);
    await app.query("DROP TABLE pg_temp.lyx_analytics_repartition_buffer");
    await owner.query(
      "CREATE TABLE public.lyx_analytics_repartition_buffer(marker text); INSERT INTO public.lyx_analytics_repartition_buffer VALUES ('public-owned'); CREATE SCHEMA lyx_test_shadow; CREATE TABLE lyx_test_shadow.analytics_event(marker text); CREATE FUNCTION lyx_test_shadow.lyx_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'shadow helper must not run'; END $$; CREATE TRIGGER shadow_insert BEFORE INSERT ON public.lyx_analytics_repartition_buffer FOR EACH ROW EXECUTE FUNCTION lyx_test_shadow.lyx_forbid_mutation(); GRANT USAGE ON SCHEMA lyx_test_shadow TO lyx_app",
    );
    await app.query(
      "CREATE TEMP TABLE analytics_event(marker text); INSERT INTO pg_temp.analytics_event VALUES ('temp-owned'); SET search_path=pg_temp,lyx_test_shadow,public; SET TimeZone='Pacific/Honolulu'; SET DateStyle='SQL,DMY'",
    );
    try {
      expect(await repartition("2611-05-01")).toBe("1");
      expect(
        (await owner.query("SELECT * FROM public.lyx_analytics_repartition_buffer")).rows,
      ).toEqual([{ marker: "public-owned" }]);
      expect((await app.query("SELECT * FROM pg_temp.analytics_event")).rows).toEqual([
        { marker: "temp-owned" },
      ]);
      expect((await owner.query("SELECT * FROM lyx_test_shadow.analytics_event")).rows).toEqual([]);
      expect((await rows([id]))[0]?.part).toBe("analytics_event_y2611m05");
    } finally {
      await app.query(
        "RESET search_path; RESET TimeZone; RESET DateStyle; DROP TABLE pg_temp.analytics_event",
      );
    }
  });

  it("恢复途中真实异常使 DELETE、建 child、trigger disable 与 temp 全部回滚", async () => {
    const id = await fixture("2612-06-15T00:00:00Z");
    const before = await rows([id]);
    const other = await sideTables();
    await owner.query(
      "CREATE FUNCTION public.lyx_test_repartition_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_id LIKE 'fixture-%' THEN RAISE EXCEPTION 'fictional injected restore failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER lyx_test_repartition_fail BEFORE INSERT ON public.analytics_event FOR EACH ROW EXECUTE FUNCTION public.lyx_test_repartition_fail()",
    );
    const beforeGuards = await guards("analytics_event_default");
    try {
      expect(await state(repartition("2612-06-01"))).toBe("P0001");
      expect(await rows([id])).toEqual(before);
      expect(await relation("analytics_event_y2612m06")).toBeNull();
      expect(await guards("analytics_event_default")).toEqual(beforeGuards);
      expect(await sideTables()).toEqual(other);
      expect(
        (await app.query("SELECT to_regclass('pg_temp.lyx_analytics_repartition_buffer') AS temp"))
          .rows,
      ).toEqual([{ temp: null }]);
    } finally {
      await owner.query(
        "DROP TRIGGER lyx_test_repartition_fail ON public.analytics_event; DROP FUNCTION public.lyx_test_repartition_fail()",
      );
    }
  });

  it("恢复 trigger 篡改完整行时 EXCEPT ALL 拒绝并整体回滚", async () => {
    const id = await fixture("2613-07-15T00:00:00Z");
    const before = await rows([id]);
    await owner.query(
      "CREATE FUNCTION public.lyx_test_repartition_mutate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.props := '{\"tampered\":true}'::jsonb; RETURN NEW; END $$; CREATE TRIGGER lyx_test_repartition_mutate BEFORE INSERT ON public.analytics_event FOR EACH ROW EXECUTE FUNCTION public.lyx_test_repartition_mutate()",
    );
    try {
      expect(await state(repartition("2613-07-01"))).toBe("55000");
      expect(await rows([id])).toEqual(before);
      expect(await relation("analytics_event_y2613m07")).toBeNull();
      expect((await guards("analytics_event_default")).every((g) => g.tgenabled === "O")).toBe(
        true,
      );
    } finally {
      await owner.query(
        "DROP TRIGGER lyx_test_repartition_mutate ON public.analytics_event; DROP FUNCTION public.lyx_test_repartition_mutate()",
      );
    }
  });

  it("caller 外层 ROLLBACK 还原成功函数的全部 DDL、行与 guard", async () => {
    const id = await fixture("2614-08-15T00:00:00Z");
    const before = await rows([id]);
    const beforeGuards = await guards("analytics_event_default");
    await app.query("BEGIN");
    try {
      expect(await repartition("2614-08-01")).toBe("1");
    } finally {
      await app.query("ROLLBACK");
    }
    expect(await rows([id])).toEqual(before);
    expect(await relation("analytics_event_y2614m08")).toBeNull();
    expect(await guards("analytics_event_default")).toEqual(beforeGuards);
  });
});
