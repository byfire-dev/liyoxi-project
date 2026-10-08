import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTestDatabase } from "./testing/index.js";

const db = useTestDatabase("db", { role: null, label: "aretire" });
let owner: pg.Client;
let app: pg.Client;
let concurrent: pg.Client;
let readonly: pg.Client;
let appPid: number;
const AT = "2010-10-01T00:00:00+08:00";
const SHA = "a".repeat(64);
const FN = "public.lyx_14_analytics_event_retire_partition";
const part = (month: string) => `analytics_event_y${month.slice(0, 4)}m${month.slice(5, 7)}`;

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
  appPid = (await app.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
});
afterAll(async () => {
  await Promise.all([owner?.end(), app?.end(), concurrent?.end(), readonly?.end()]);
});
async function ensure(month: string) {
  await app.query("SELECT public.lyx_14_analytics_event_ensure_partition($1::date)", [month]);
}
async function retire(
  month: string | null,
  rows: number | null = 0,
  client = app,
  at: string | null = AT,
  retention: number | null = 25,
  sha: string | null = SHA,
) {
  return (
    await client.query<{ retired: boolean }>(
      `SELECT ${FN}($1::date,$2::timestamptz,$3::int,$4::bigint,$5::text) AS retired`,
      [month, at, retention, rows, sha],
    )
  ).rows[0]!.retired;
}
async function state(action: Promise<unknown>) {
  try {
    await action;
    return "resolved";
  } catch (error) {
    return (error as { code?: string }).code;
  }
}
async function relation(month: string) {
  return (await owner.query("SELECT to_regclass($1)::text AS rel", [`public.${part(month)}`]))
    .rows[0]!.rel as string | null;
}
async function fixture(month: string, client = app) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO public.analytics_event
      (occurred_at,id,event_id,name,source,actor_type,actor_id,client,merchant_user_id,
       anonymous_id,role,entity_id,store_id,city_code,category_code,client_platform,
       client_version,session_id,scene,props,received_at)
     VALUES ($1,$2,$3,'retirement_test','direct','merchant',$4,'weapp',$4,$5,'owner',
       $6,$7,'310100','fictional_category','fictional_platform','fictional_version',
       $8,1001,'{"nested":{"fictional":true},"array":[1,2]}'::jsonb,
       '2000-01-02T03:04:05.123456Z')`,
    [
      `${month}T00:00:00+08:00`,
      id,
      `fictional-${id}`,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ],
  );
  return id;
}
async function rows(ids: string[]) {
  return (
    await owner.query(
      "SELECT to_jsonb(e) AS row FROM public.analytics_event e WHERE id=ANY($1::uuid[]) ORDER BY id",
      [ids],
    )
  ).rows;
}

describe("真实权限下固定到期分区退役", () => {
  it("未来业务时钟不能绕过数据库最短保留界，当前月和完整行必须保留", async () => {
    const month = (
      await owner.query<{ month: string }>(
        "SELECT to_char(statement_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-01') AS month",
      )
    ).rows[0]!.month;
    await ensure(month);
    const id = await fixture(month);
    const original = await rows([id]);
    expect(await state(retire(month, 1, app, "2200-10-01T00:00:00+08:00", 13))).toBe("23001");
    expect(await relation(month)).not.toBeNull();
    expect(await rows([id])).toEqual(original);
  });

  it("只授 app 固定函数，PUBLIC/readonly 无执行权且原表 SI 权限不变", async () => {
    await ensure("2000-01-01");
    expect(await state(retire("2000-01-01", 0, readonly))).toBe("42501");
    expect(
      (
        await owner.query(
          "SELECT a.grantee FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid=$1::regprocedure AND a.grantee=0",
          [`${FN}(date,timestamptz,integer,bigint,text)`],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await app.query(
          "SELECT current_user AS role, has_table_privilege(current_user,'public.analytics_event','SELECT,INSERT') AS si, has_table_privilege(current_user,'public.analytics_event','DELETE') AS del",
        )
      ).rows,
    ).toEqual([{ role: "lyx_app", si: true, del: false }]);
    expect(await state(app.query("DROP TABLE public.analytics_event_y2000m01"))).toBe("42501");
    expect(await retire("2000-01-01")).toBe(true);
    expect(await relation("2000-01-01")).toBeNull();
    expect(await retire("2000-01-01")).toBe(false);
  });

  it.each([null, "infinity", "-infinity", "2000-02-02", "0001-01-01 BC", "10000-01-01"])(
    "拒绝非法月份 %s",
    async (month) => {
      expect(await state(retire(month))).toBe("22023");
    },
  );
  it.each([null, "infinity", "-infinity", "10000-01-01T00:00:00Z"])(
    "拒绝非法业务时钟 %s",
    async (at) => {
      expect(await state(retire("2000-02-01", 0, app, at))).toBe("22023");
    },
  );
  it.each([null, 12, 61])("保留月数必须符合正式 13–60 边界 %s", async (retention) => {
    expect(await state(retire("2000-02-01", 0, app, AT, retention))).toBe("22023");
  });
  it.each([null, -1])("拒绝非法归档行数 %s", async (count) => {
    expect(await state(retire("2000-02-01", count))).toBe("22023");
  });
  it.each([null, "", "x".repeat(64), "a".repeat(63), "a".repeat(65)])(
    "拒绝不完整 manifest 哈希 %s",
    async (sha) => {
      expect(await state(retire("2000-02-01", 0, app, AT, 25, sha))).toBe("22023");
    },
  );

  it("按北京时间保留阈值只删除整个已过期月份", async () => {
    await ensure("2008-08-01");
    await ensure("2008-09-01");
    expect(await retire("2008-08-01")).toBe(true);
    expect(await state(retire("2008-09-01"))).toBe("22023");
    expect(await relation("2008-09-01")).not.toBeNull();
    expect(await state(retire("2008-08-01", 0, app, "2010-09-30T15:59:59.999Z"))).toBe("22023");
  });

  it("归档行数失配不改完整 21 列和旁侧表，正确计数才原子移除", async () => {
    const month = "2001-01-01";
    await ensure(month);
    const ids = [await fixture(month), await fixture(month)];
    const original = await rows(ids);
    expect(Object.keys(original[0]!.row)).toHaveLength(21);
    const side = (
      await owner.query(
        "SELECT (SELECT count(*) FROM analytics_event_dedup) AS dedup,(SELECT count(*) FROM analytics_identity) AS identity",
      )
    ).rows;
    expect(await state(retire(month, 1))).toBe("55000");
    expect(await rows(ids)).toEqual(original);
    expect(await retire(month, 2)).toBe(true);
    expect(await rows(ids)).toEqual([]);
    expect(
      (
        await owner.query(
          "SELECT (SELECT count(*) FROM analytics_event_dedup) AS dedup,(SELECT count(*) FROM analytics_identity) AS identity",
        )
      ).rows,
    ).toEqual(side);
  });

  it("等待父锁期间的迟到插入在锁内计数中可见，旧导出不能删新行", async () => {
    const month = "2001-02-01";
    await ensure(month);
    const first = await fixture(month);
    await owner.query("BEGIN");
    const second = await fixture(month, owner);
    const retiring = state(retire(month, 1));
    try {
      const deadline = Date.now() + 2000;
      let blocked = false;
      while (Date.now() < deadline && !blocked) {
        blocked =
          (
            await owner.query(
              "SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1",
              [appPid],
            )
          ).rows[0]?.blocked === true;
        if (!blocked) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(blocked).toBe(true);
    } finally {
      await owner.query("COMMIT");
    }
    expect(await retiring).toBe("55000");
    expect(await rows([first, second])).toHaveLength(2);
    expect(await relation(month)).not.toBeNull();
  });

  it("外层事务回滚同时恢复分区、行及 guards；重复并发只有一次退役", async () => {
    const month = "2001-03-01";
    await ensure(month);
    const id = await fixture(month);
    const original = await rows([id]);
    await app.query("BEGIN");
    try {
      expect(await retire(month, 1)).toBe(true);
    } finally {
      await app.query("ROLLBACK");
    }
    expect(await rows([id])).toEqual(original);
    expect(await state(owner.query(`TRUNCATE public.${part(month)}`))).toBe("23001");
    expect((await Promise.all([retire(month, 1), retire(month, 1, concurrent)])).sort()).toEqual([
      false,
      true,
    ]);
  });

  it("同名普通表、错误边界或禁用 guard 均不被误删", async () => {
    await owner.query("CREATE TABLE public.analytics_event_y2002m01(id int)");
    expect(await state(retire("2002-01-01"))).toBe("55000");
    expect(await relation("2002-01-01")).not.toBeNull();
    await owner.query(
      "CREATE TABLE public.analytics_event_y2002m02 PARTITION OF public.analytics_event FOR VALUES FROM ('2002-03-01T00:00:00+08:00') TO ('2002-04-01T00:00:00+08:00')",
    );
    expect(await state(retire("2002-02-01"))).toBe("55000");
    await ensure("2002-04-01");
    await owner.query(
      "ALTER TABLE public.analytics_event_y2002m04 DISABLE TRIGGER trg_analytics_event_append_only",
    );
    try {
      expect(await state(retire("2002-04-01"))).toBe("55000");
    } finally {
      await owner.query(
        "ALTER TABLE public.analytics_event_y2002m04 ENABLE TRIGGER trg_analytics_event_append_only",
      );
    }
    expect(await relation("2002-04-01")).not.toBeNull();
  });

  it("调用方 search_path/日期时区及临时同名对象不能重定向固定关系", async () => {
    const month = "2003-01-01";
    await ensure(month);
    await app.query(
      "SET search_path=pg_temp; SET TimeZone='Pacific/Honolulu'; SET DateStyle='SQL, DMY'; CREATE TEMP TABLE analytics_event_y2003m01(id int); INSERT INTO analytics_event_y2003m01 VALUES(1)",
    );
    try {
      expect(await retire(month)).toBe(true);
      expect((await app.query("SELECT * FROM pg_temp.analytics_event_y2003m01")).rows).toEqual([
        { id: 1 },
      ]);
    } finally {
      await app.query("RESET search_path; RESET TimeZone; RESET DateStyle");
    }
  });
});
