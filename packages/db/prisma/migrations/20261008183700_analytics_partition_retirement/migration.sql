-- W2-18 / 14 §2.9：可信服务验证完整对象归档后，受限退役一个到期月分区。
-- 归档对象的存在/内容由服务校验；数据库只核固定结构、到期范围和锁内完整行数。
BEGIN;

CREATE FUNCTION public.lyx_14_analytics_event_retire_partition(
  p_month pg_catalog.date,
  p_at pg_catalog.timestamptz,
  p_retention_months pg_catalog.int4,
  p_exported_rows pg_catalog.int8,
  p_archive_sha256 pg_catalog.text
) RETURNS pg_catalog.bool LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
SET DateStyle = 'ISO, YMD'
AS $body$
DECLARE
  part pg_catalog.text;
  child_id pg_catalog.oid;
  month_end pg_catalog.timestamp;
  cutoff pg_catalog.timestamp;
  database_floor pg_catalog.timestamp;
  actual_rows pg_catalog.int8;
BEGIN
  IF p_month IS NULL OR NOT pg_catalog.isfinite(p_month)
     OR pg_catalog.date_part('year', p_month) NOT BETWEEN 1 AND 9999
     OR pg_catalog.date_part('day', p_month) <> 1
     OR p_at IS NULL OR NOT pg_catalog.isfinite(p_at)
     OR pg_catalog.date_part('year', p_at) NOT BETWEEN 1 AND 9999
     OR p_retention_months IS NULL OR p_retention_months NOT BETWEEN 13 AND 60
     OR p_exported_rows IS NULL OR p_exported_rows < 0
     OR p_archive_sha256 IS NULL OR p_archive_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'analytics retirement requires finite month/time, retention 13-60, exact rows and archive SHA-256'
      USING ERRCODE = '22023';
  END IF;
  month_end := (p_month + INTERVAL '1 month')::pg_catalog.timestamp;
  -- 这是角色权限的最短年龄下限，不替代注入业务时钟；同既有 auth_event purge 的防未来边界。
  -- caller 即使伪造未来 p_at，也不得退役数据库真实时间下仍处于正式最短 13 月保护的分区。
  database_floor := (pg_catalog.statement_timestamp() AT TIME ZONE 'Asia/Shanghai')
    - INTERVAL '13 months';
  IF month_end > database_floor THEN
    RAISE EXCEPTION 'analytics retirement cannot bypass database minimum retention'
      USING ERRCODE = '23001';
  END IF;
  cutoff := (p_at AT TIME ZONE 'Asia/Shanghai')
    - pg_catalog.make_interval(months => p_retention_months);
  IF month_end > cutoff THEN
    RAISE EXCEPTION 'analytics retirement month is still retained' USING ERRCODE = '22023';
  END IF;
  part := 'analytics_event_y' || pg_catalog.to_char(p_month, 'YYYY')
    || 'm' || pg_catalog.to_char(p_month, 'MM');
  LOCK TABLE public.analytics_event IN ACCESS EXCLUSIVE MODE;
  child_id := pg_catalog.to_regclass(pg_catalog.format('public.%I', part));
  IF child_id IS NULL THEN
    RETURN false;
  END IF;
  -- 原受限能力检查完整父/子属主、RANGE 轴、精确北京时间月界及只增/禁 TRUNCATE guards。
  -- 当前子表存在且父锁已持有，此调用不能新建对象或覆盖不合法同名对象。
  PERFORM public.lyx_14_analytics_event_ensure_partition(p_month);
  EXECUTE pg_catalog.format('SELECT count(*) FROM ONLY public.%I', part) INTO actual_rows;
  IF actual_rows <> p_exported_rows THEN
    RAISE EXCEPTION 'analytics retirement rows changed after export' USING ERRCODE = '55000';
  END IF;
  EXECUTE pg_catalog.format('ALTER TABLE public.analytics_event DETACH PARTITION public.%I', part);
  -- lyx:allow 只删除经固定父表、属主、精确月界及 guards 验证且归档行数匹配的到期子表，无 CASCADE。
  EXECUTE pg_catalog.format('DROP TABLE public.%I', part);
  RETURN true;
END;
$body$;
REVOKE ALL ON FUNCTION public.lyx_14_analytics_event_retire_partition(
  pg_catalog.date, pg_catalog.timestamptz, pg_catalog.int4, pg_catalog.int8, pg_catalog.text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lyx_14_analytics_event_retire_partition(
  pg_catalog.date, pg_catalog.timestamptz, pg_catalog.int4, pg_catalog.int8, pg_catalog.text
) TO lyx_app;

COMMIT;
