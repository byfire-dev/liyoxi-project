-- ADR-045 / 14 §2.9：结构能力仅授 lyx_app，不让 worker 持有迁移口令或任意 DDL。
-- 不改只增表权限；只在单条函数语句的事务里受控重分区，任何错误整体回滚。
BEGIN;

CREATE OR REPLACE FUNCTION public.lyx_14_analytics_event_ensure_partition(p_month pg_catalog.date)
RETURNS pg_catalog.text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
SET DateStyle = 'ISO, YMD'
AS $body$
DECLARE
  part pg_catalog.text;
  lo pg_catalog.timestamptz;
  hi pg_catalog.timestamptz;
  parent_id pg_catalog.oid;
  owner_id pg_catalog.oid;
  child_id pg_catalog.oid;
  append_id pg_catalog.oid;
  guard_id pg_catalog.oid := 'public.lyx_forbid_mutation()'::pg_catalog.regprocedure;
BEGIN
  IF p_month IS NULL OR NOT pg_catalog.isfinite(p_month)
     OR pg_catalog.date_part('year', p_month) NOT BETWEEN 1 AND 9999
     OR pg_catalog.date_part('day', p_month) <> 1 THEN
    RAISE EXCEPTION 'analytics partition month must be a finite Gregorian month start in years 0001-9999'
      USING ERRCODE = '22023';
  END IF;
  part := 'analytics_event_y' || pg_catalog.to_char(p_month, 'YYYY') || 'm' || pg_catalog.to_char(p_month, 'MM');
  lo := p_month::pg_catalog.timestamp AT TIME ZONE 'Asia/Shanghai';
  hi := (p_month + INTERVAL '1 month')::pg_catalog.timestamp AT TIME ZONE 'Asia/Shanghai';
  LOCK TABLE public.analytics_event IN ACCESS EXCLUSIVE MODE;
  parent_id := 'public.analytics_event'::pg_catalog.regclass;
  SELECT c.relowner INTO owner_id FROM pg_catalog.pg_class c
    WHERE c.oid = parent_id AND c.relkind = 'p' AND c.relpersistence = 'p';
  IF owner_id IS DISTINCT FROM current_user::pg_catalog.regrole::pg_catalog.oid
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_partitioned_table p
       JOIN pg_catalog.pg_attribute a ON a.attrelid = p.partrelid AND a.attname = 'occurred_at'
       WHERE p.partrelid = parent_id AND p.partstrat = 'r' AND p.partnatts = 1
         AND p.partattrs[0] = a.attnum AND p.partexprs IS NULL) THEN
    RAISE EXCEPTION 'analytics partition parent metadata is not valid' USING ERRCODE = '55000';
  END IF;
  SELECT t.oid INTO append_id FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = parent_id AND t.tgname = 'trg_analytics_event_append_only'
      AND t.tgfoid = guard_id AND t.tgtype = 27 AND t.tgenabled = 'O'
      AND t.tgparentid = 0 AND NOT t.tgisinternal AND t.tgnargs = 0
      AND t.tgargs = '\x'::pg_catalog.bytea AND t.tgqual IS NULL;
  IF append_id IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = parent_id AND t.tgname = 'trg_analytics_event_no_truncate'
      AND t.tgfoid = guard_id AND t.tgtype = 34 AND t.tgenabled = 'O'
      AND t.tgparentid = 0 AND NOT t.tgisinternal AND t.tgnargs = 0
      AND t.tgargs = '\x'::pg_catalog.bytea AND t.tgqual IS NULL) THEN
    RAISE EXCEPTION 'analytics partition parent guards are not valid' USING ERRCODE = '55000';
  END IF;
  child_id := pg_catalog.to_regclass(pg_catalog.format('public.%I', part));
  IF child_id IS NULL THEN
    EXECUTE pg_catalog.format('CREATE TABLE public.%I PARTITION OF public.analytics_event FOR VALUES FROM (%L) TO (%L)', part, lo, hi);
    EXECUTE pg_catalog.format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.lyx_forbid_mutation()', 'trg_' || part || '_no_truncate', part);
    child_id := pg_catalog.to_regclass(pg_catalog.format('public.%I', part));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
    WHERE c.oid = child_id AND c.relkind = 'r' AND c.relpersistence = 'p'
      AND c.relispartition AND c.relowner = owner_id
      AND pg_catalog.pg_get_expr(c.relpartbound, c.oid, true)
        = pg_catalog.format('FOR VALUES FROM (%L) TO (%L)', lo, hi))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_inherits i WHERE i.inhrelid = child_id) <> 1
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid = child_id AND i.inhparent = parent_id)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = child_id AND t.tgname = 'trg_analytics_event_append_only'
        AND t.tgfoid = guard_id AND t.tgtype = 27 AND t.tgenabled = 'O'
        AND t.tgparentid = append_id AND NOT t.tgisinternal AND t.tgnargs = 0
        AND t.tgargs = '\x'::pg_catalog.bytea AND t.tgqual IS NULL)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = child_id AND t.tgname = 'trg_' || part || '_no_truncate'
        AND t.tgfoid = guard_id AND t.tgtype = 34 AND t.tgenabled = 'O'
        AND t.tgparentid = 0 AND NOT t.tgisinternal AND t.tgnargs = 0
        AND t.tgargs = '\x'::pg_catalog.bytea AND t.tgqual IS NULL) THEN
    RAISE EXCEPTION 'analytics partition child metadata is not valid' USING ERRCODE = '55000';
  END IF;
  RETURN part;
END;
$body$;
REVOKE ALL ON FUNCTION public.lyx_14_analytics_event_ensure_partition(pg_catalog.date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lyx_14_analytics_event_ensure_partition(pg_catalog.date) TO lyx_app;

CREATE FUNCTION public.lyx_14_analytics_event_repartition_month(p_month pg_catalog.date)
RETURNS pg_catalog.int8 LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
SET DateStyle = 'ISO, YMD'
AS $body$
DECLARE
  lo pg_catalog.timestamptz;
  hi pg_catalog.timestamptz;
  parent_id pg_catalog.oid;
  default_id pg_catalog.oid;
  owner_id pg_catalog.oid;
  append_id pg_catalog.oid;
  guard_id pg_catalog.oid := 'public.lyx_forbid_mutation()'::pg_catalog.regprocedure;
  expected_count pg_catalog.int8;
  moved_count pg_catalog.int8;
  inserted_count pg_catalog.int8;
  same_rows pg_catalog.bool;
BEGIN
  IF p_month IS NULL OR NOT pg_catalog.isfinite(p_month)
     OR pg_catalog.date_part('year', p_month) NOT BETWEEN 1 AND 9999
     OR pg_catalog.date_part('day', p_month) <> 1 THEN
    RAISE EXCEPTION 'analytics repartition month must be a finite Gregorian month start in years 0001-9999'
      USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.to_regclass('pg_temp.lyx_analytics_repartition_buffer') IS NOT NULL THEN
    RAISE EXCEPTION 'analytics repartition private buffer name is already in use' USING ERRCODE = '55000';
  END IF;
  lo := p_month::pg_catalog.timestamp AT TIME ZONE 'Asia/Shanghai';
  hi := (p_month + INTERVAL '1 month')::pg_catalog.timestamp AT TIME ZONE 'Asia/Shanghai';
  LOCK TABLE public.analytics_event IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE ONLY public.analytics_event_default IN ACCESS EXCLUSIVE MODE;
  parent_id := 'public.analytics_event'::pg_catalog.regclass;
  default_id := 'public.analytics_event_default'::pg_catalog.regclass;
  SELECT c.relowner INTO owner_id FROM pg_catalog.pg_class c
    WHERE c.oid = parent_id AND c.relkind = 'p' AND c.relpersistence = 'p';
  SELECT t.oid INTO append_id FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = parent_id AND t.tgname = 'trg_analytics_event_append_only'
      AND t.tgfoid = guard_id AND t.tgtype = 27 AND t.tgenabled = 'O'
      AND t.tgparentid = 0 AND NOT t.tgisinternal AND t.tgnargs = 0
      AND t.tgargs = '\x'::pg_catalog.bytea AND t.tgqual IS NULL;
  IF owner_id IS DISTINCT FROM current_user::pg_catalog.regrole::pg_catalog.oid OR append_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = default_id
      AND c.relkind = 'r' AND c.relpersistence = 'p' AND c.relispartition
      AND c.relowner = owner_id AND pg_catalog.pg_get_expr(c.relpartbound, c.oid, true) = 'DEFAULT')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_inherits i WHERE i.inhrelid = default_id) <> 1
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid = default_id AND i.inhparent = parent_id)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = default_id AND t.tgname = 'trg_analytics_event_append_only'
        AND t.tgfoid = guard_id AND t.tgtype = 27 AND t.tgenabled = 'O'
        AND t.tgparentid = append_id AND NOT t.tgisinternal AND t.tgnargs = 0
        AND t.tgargs = '\x'::pg_catalog.bytea AND t.tgqual IS NULL)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = default_id AND t.tgname = 'trg_analytics_event_default_no_truncate'
        AND t.tgfoid = guard_id AND t.tgtype = 34 AND t.tgenabled = 'O'
        AND t.tgparentid = 0 AND NOT t.tgisinternal AND t.tgnargs = 0
        AND t.tgargs = '\x'::pg_catalog.bytea AND t.tgqual IS NULL) THEN
    RAISE EXCEPTION 'analytics repartition default metadata is not valid' USING ERRCODE = '55000';
  END IF;
  CREATE TEMP TABLE pg_temp.lyx_analytics_repartition_buffer
    (LIKE public.analytics_event INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
  SELECT pg_catalog.count(*) INTO expected_count FROM ONLY public.analytics_event_default
    WHERE occurred_at >= lo AND occurred_at < hi;
  ALTER TABLE ONLY public.analytics_event_default DISABLE TRIGGER trg_analytics_event_append_only;
  WITH moved AS (
    DELETE FROM ONLY public.analytics_event_default WHERE occurred_at >= lo AND occurred_at < hi RETURNING *
  ) INSERT INTO pg_temp.lyx_analytics_repartition_buffer SELECT * FROM moved;
  GET DIAGNOSTICS moved_count = ROW_COUNT;
  IF moved_count <> expected_count THEN
    RAISE EXCEPTION 'analytics repartition source row count changed' USING ERRCODE = '55000';
  END IF;
  PERFORM public.lyx_14_analytics_event_ensure_partition(p_month);
  WITH restored AS (
    INSERT INTO public.analytics_event SELECT * FROM pg_temp.lyx_analytics_repartition_buffer RETURNING *
  )
  SELECT pg_catalog.count(*), NOT EXISTS (
    (SELECT * FROM restored EXCEPT ALL SELECT * FROM pg_temp.lyx_analytics_repartition_buffer)
    UNION ALL (SELECT * FROM pg_temp.lyx_analytics_repartition_buffer EXCEPT ALL SELECT * FROM restored)
  ) INTO inserted_count, same_rows FROM restored;
  IF inserted_count <> moved_count OR NOT same_rows THEN
    RAISE EXCEPTION 'analytics repartition restored rows are not identical' USING ERRCODE = '55000';
  END IF;
  ALTER TABLE ONLY public.analytics_event_default ENABLE TRIGGER trg_analytics_event_append_only;
  -- lyx:allow 只删除本次函数自建的私有暂存表；入口拒绝caller已有同名对象，不覆盖或删除caller对象。
  DROP TABLE pg_temp.lyx_analytics_repartition_buffer;
  RETURN moved_count;
END;
$body$;
REVOKE ALL ON FUNCTION public.lyx_14_analytics_event_repartition_month(pg_catalog.date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lyx_14_analytics_event_repartition_month(pg_catalog.date) TO lyx_app;

COMMIT;
