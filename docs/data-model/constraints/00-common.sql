-- 公共：扩展与通用触发器函数。所有分组的手写约束都可以使用，先于各分组的 SQL 执行。
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 只增表：拦截 UPDATE、DELETE、TRUNCATE。
-- 用法：
--   CREATE TRIGGER trg_<表>_append_only BEFORE UPDATE OR DELETE ON <表>
--     FOR EACH ROW EXECUTE FUNCTION lyx_forbid_mutation();
--   CREATE TRIGGER trg_<表>_no_truncate BEFORE TRUNCATE ON <表>
--     FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();
CREATE OR REPLACE FUNCTION lyx_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only: % not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- 只拦 UPDATE（DELETE 由清理函数执行）的表。
-- 用法：CREATE TRIGGER trg_<表>_no_update BEFORE UPDATE ON <表>
--         FOR EACH ROW EXECUTE FUNCTION lyx_forbid_update();
CREATE OR REPLACE FUNCTION lyx_forbid_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table %: UPDATE not allowed', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- 只允许“把指定列从 NULL 写一次”，其余列不可改；DELETE 一律拦截。
-- 用于带生效时间的修订行（只可在生效前写一次 cancelled_at）与下载日志的回执列。
-- 用法：CREATE TRIGGER trg_<表>_write_once BEFORE UPDATE OR DELETE ON <表>
--         FOR EACH ROW EXECUTE FUNCTION lyx_write_once('cancelled_at', 'cancelled_by_staff_id');
CREATE OR REPLACE FUNCTION lyx_write_once() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed text[] := TG_ARGV::text[];
  o jsonb;
  n jsonb;
  c text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'table %: DELETE not allowed', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  o := to_jsonb(OLD);
  n := to_jsonb(NEW);
  IF (o - allowed) IS DISTINCT FROM (n - allowed) THEN
    RAISE EXCEPTION 'table %: only columns % may be written', TG_TABLE_NAME, allowed USING ERRCODE = 'restrict_violation';
  END IF;
  FOREACH c IN ARRAY allowed LOOP
    IF (o -> c) IS DISTINCT FROM 'null'::jsonb AND (o -> c) IS DISTINCT FROM (n -> c) THEN
      RAISE EXCEPTION 'table %: column % is write-once', TG_TABLE_NAME, c USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- 只拦 DELETE 与 TRUNCATE（行可改、不可删）的表。
-- 用法：CREATE TRIGGER trg_<表>_no_delete BEFORE DELETE ON <表>
--         FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
--       CREATE TRIGGER trg_<表>_no_truncate BEFORE TRUNCATE ON <表>
--         FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();
CREATE OR REPLACE FUNCTION lyx_forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table %: % not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- 指定列创建后不可改（归属列、来源列等）。
-- 用法：CREATE TRIGGER trg_<表>_immutable BEFORE UPDATE ON <表>
--         FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('entity_id', 'store_id');
CREATE OR REPLACE FUNCTION lyx_forbid_column_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c text;
  o jsonb := to_jsonb(OLD);
  n jsonb := to_jsonb(NEW);
BEGIN
  FOREACH c IN ARRAY TG_ARGV::text[] LOOP
    IF (o -> c) IS DISTINCT FROM (n -> c) THEN
      RAISE EXCEPTION 'table %: column % is immutable', TG_TABLE_NAME, c USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
