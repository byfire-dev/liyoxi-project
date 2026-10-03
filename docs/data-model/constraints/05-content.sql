-- 分组 05-content：短剧库（content）的手写约束。
-- 依据：docs/appendix/design/d8-content.md 第 3.10 节；docs/data-model/05-content.md；rulings M49、M50、M74。
-- 只含 Prisma 表达不了的约束：CHECK、数组列的 NOT NULL、部分唯一索引、部分索引、触发器。
-- 外键（含 drama_copyright 指向修订的复合外键）、GIN 索引都在 Prisma 片段里；本文件不写外键。

-- 公用：数组列的元素非空且不重复（每个数组列一条 CHECK 调用它）。
CREATE OR REPLACE FUNCTION lyx_05_array_is_set(a anyarray) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT count(DISTINCT x) = cardinality(a) FROM unnest(a) AS t(x)
$$;

-- drama
-- 数组列非空：Prisma 给标量数组列建的是可空列（只带默认值），这里补 NOT NULL（M49）。
ALTER TABLE drama ALTER COLUMN genre_codes SET NOT NULL;
ALTER TABLE drama ALTER COLUMN selling_tag_codes SET NOT NULL;
ALTER TABLE drama ALTER COLUMN industry_codes SET NOT NULL;
ALTER TABLE drama ALTER COLUMN allowed_placements SET NOT NULL;
ALTER TABLE drama ADD CONSTRAINT ck_drama_status
  CHECK (status IN ('draft','listed','delisted'));
ALTER TABLE drama ADD CONSTRAINT ck_drama_delist_reason_code
  CHECK (delist_reason_code IN ('ops_strategy','rights_issue','content_revision','other','license_expired'));
ALTER TABLE drama ADD CONSTRAINT ck_drama_drama_class
  CHECK (drama_class IN ('class_1','class_2','class_3'));
ALTER TABLE drama ADD CONSTRAINT ck_drama_heat_tier
  CHECK (heat_tier IN ('S','A','B','C'));
ALTER TABLE drama ADD CONSTRAINT ck_drama_body_edit_policy
  CHECK (body_edit_policy IN ('undecided','allowed','forbidden'));
ALTER TABLE drama ADD CONSTRAINT ck_drama_allowed_placements
  CHECK (allowed_placements <@ ARRAY['opening','ending','corner','mid_roll']::text[]);
ALTER TABLE drama ADD CONSTRAINT ck_drama_selling_tag_codes_max
  CHECK (cardinality(selling_tag_codes) <= 3);
-- 数组元素非空且不重复。
ALTER TABLE drama ADD CONSTRAINT ck_drama_genre_codes_elements
  CHECK (lyx_05_array_is_set(genre_codes));
ALTER TABLE drama ADD CONSTRAINT ck_drama_selling_tag_codes_elements
  CHECK (lyx_05_array_is_set(selling_tag_codes));
ALTER TABLE drama ADD CONSTRAINT ck_drama_industry_codes_elements
  CHECK (lyx_05_array_is_set(industry_codes));
ALTER TABLE drama ADD CONSTRAINT ck_drama_allowed_placements_elements
  CHECK (lyx_05_array_is_set(allowed_placements));
ALTER TABLE drama ADD CONSTRAINT ck_drama_total_episodes
  CHECK (total_episodes >= 1);
ALTER TABLE drama ADD CONSTRAINT ck_drama_episode_duration_sec
  CHECK (episode_duration_sec > 0);
ALTER TABLE drama ADD CONSTRAINT ck_drama_trial_episode_count
  CHECK (trial_episode_count BETWEEN 0 AND 10);
ALTER TABLE drama ADD CONSTRAINT ck_drama_manual_boost
  CHECK (manual_boost BETWEEN 0 AND 100);
ALTER TABLE drama ADD CONSTRAINT ck_drama_roles_array
  CHECK (jsonb_typeof(roles) = 'array');
-- 草稿从未上架：上架、下架、归档的时间与原因都为空。
ALTER TABLE drama ADD CONSTRAINT ck_drama_draft_clean
  CHECK (status <> 'draft' OR (first_listed_at IS NULL AND listed_at IS NULL AND delisted_at IS NULL
                               AND delist_reason_code IS NULL AND archived_at IS NULL));
-- 已上架、已下架的剧必有首次上架时间与最近上架时间，且前者不晚于后者。
ALTER TABLE drama ADD CONSTRAINT ck_drama_listed_times
  CHECK (status = 'draft' OR (first_listed_at IS NOT NULL AND listed_at IS NOT NULL AND first_listed_at <= listed_at));
-- 已下架的剧必有下架时间与原因，且下架时间不早于最近一次上架：每次下架都要重写 delisted_at，
-- 重新上架后残留的上一次下架时间过不了这条。
ALTER TABLE drama ADD CONSTRAINT ck_drama_delisted_fields
  CHECK (status <> 'delisted' OR (delisted_at IS NOT NULL AND delist_reason_code IS NOT NULL AND delisted_at >= listed_at));
-- 系统到期下架没有人工说明：原因为 license_expired 时 delist_note 为空。
ALTER TABLE drama ADD CONSTRAINT ck_drama_delist_note_expired
  CHECK (delist_reason_code IS DISTINCT FROM 'license_expired' OR delist_note IS NULL);
-- 只有已下架的剧可以归档；配合触发器，归档后不能重新上架。
ALTER TABLE drama ADD CONSTRAINT ck_drama_archived_delisted
  CHECK (archived_at IS NULL OR status = 'delisted');

-- “最新上架”排序、“新剧”判定：只扫已上架的剧。
CREATE INDEX ix_drama_listed_first_listed_at ON drama (first_listed_at DESC) WHERE status = 'listed';

-- first_listed_at、archived_at 写入后不可改（重新上架不重置首次上架时间；归档是终态）。
-- 公共的 lyx_write_once 会锁住其余所有列，lyx_forbid_column_change 不允许从 NULL 写一次，所以本组自定义。
CREATE OR REPLACE FUNCTION lyx_05_drama_write_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.first_listed_at IS NOT NULL AND NEW.first_listed_at IS DISTINCT FROM OLD.first_listed_at THEN
    RAISE EXCEPTION 'table drama: column first_listed_at is write-once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
    RAISE EXCEPTION 'table drama: column archived_at is write-once (archive is terminal)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_drama_write_once BEFORE UPDATE ON drama
  FOR EACH ROW EXECUTE FUNCTION lyx_05_drama_write_once();
-- 剧目不做物理删除（d8:49；07、09、10、13 的外键都指向它）。
CREATE TRIGGER trg_drama_no_delete BEFORE DELETE ON drama
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_drama_no_truncate BEFORE TRUNCATE ON drama
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();

-- drama_episode
ALTER TABLE drama_episode ADD CONSTRAINT ck_drama_episode_episode_no
  CHECK (episode_no >= 1);
ALTER TABLE drama_episode ADD CONSTRAINT ck_drama_episode_duration_ms
  CHECK (duration_ms > 0);

-- drama_permit
ALTER TABLE drama_permit ALTER COLUMN scan_file_ids SET NOT NULL;
ALTER TABLE drama_permit ADD CONSTRAINT ck_drama_permit_platform
  CHECK (platform IN ('all','douyin','wechat_channels'));
ALTER TABLE drama_permit ADD CONSTRAINT ck_drama_permit_permit_kind
  CHECK (permit_kind IN ('license_no','approval_no','program_no'));
ALTER TABLE drama_permit ADD CONSTRAINT ck_drama_permit_status
  CHECK (status IN ('active','retired'));
-- 停用行必有停用时间；活动行的停用时间与停用原因都为空。
ALTER TABLE drama_permit ADD CONSTRAINT ck_drama_permit_retired_fields
  CHECK ((status = 'retired') = (retired_at IS NOT NULL) AND (status = 'retired' OR retire_reason IS NULL));
ALTER TABLE drama_permit ADD CONSTRAINT ck_drama_permit_scan_file_ids_elements
  CHECK (lyx_05_array_is_set(scan_file_ids));
-- 每个（剧, 平台, 编号种类）至多一条活动行。
CREATE UNIQUE INDEX uq_drama_permit_active ON drama_permit (drama_id, platform, permit_kind) WHERE status = 'active';
-- 许可行的留痕防线：停用行是换号留痕，不可改、不可删；drama_id 创建后不可改；
-- 上架过的剧（drama.first_listed_at 非空）不原地改号（平台、种类、编号），活动行也不可删，只能停用。
CREATE OR REPLACE FUNCTION lyx_05_drama_permit_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ever_listed boolean;
BEGIN
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'table drama_permit: retired row % is evidence, % not allowed', OLD.id, TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT d.first_listed_at IS NOT NULL INTO ever_listed FROM drama d WHERE d.id = OLD.drama_id;
  IF TG_OP = 'DELETE' THEN
    IF ever_listed THEN
      RAISE EXCEPTION 'table drama_permit: rows of a drama that has been listed cannot be deleted, retire instead'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.drama_id IS DISTINCT FROM OLD.drama_id THEN
    RAISE EXCEPTION 'table drama_permit: column drama_id is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF ever_listed AND (NEW.platform, NEW.permit_kind, NEW.permit_no)
                     IS DISTINCT FROM (OLD.platform, OLD.permit_kind, OLD.permit_no) THEN
    RAISE EXCEPTION 'table drama_permit: permit number of a listed drama cannot be changed in place, retire and insert'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_drama_permit_guard BEFORE UPDATE OR DELETE ON drama_permit
  FOR EACH ROW EXECUTE FUNCTION lyx_05_drama_permit_guard();
CREATE TRIGGER trg_drama_permit_no_truncate BEFORE TRUNCATE ON drama_permit
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();

-- drama_copyright
ALTER TABLE drama_copyright ALTER COLUMN platforms SET NOT NULL;
ALTER TABLE drama_copyright ALTER COLUMN proof_file_ids SET NOT NULL;
ALTER TABLE drama_copyright ADD CONSTRAINT ck_drama_copyright_source
  CHECK (source IN ('own','licensed'));
ALTER TABLE drama_copyright ADD CONSTRAINT ck_drama_copyright_platforms
  CHECK (platforms <@ ARRAY['douyin','wechat_channels']::text[]);
ALTER TABLE drama_copyright ADD CONSTRAINT ck_drama_copyright_platforms_elements
  CHECK (lyx_05_array_is_set(platforms));
ALTER TABLE drama_copyright ADD CONSTRAINT ck_drama_copyright_proof_file_ids_elements
  CHECK (lyx_05_array_is_set(proof_file_ids));
ALTER TABLE drama_copyright ADD CONSTRAINT ck_drama_copyright_license_dates
  CHECK (license_end_date >= license_start_date);
-- 版权当前值与剧目一对一，不做物理删除。
CREATE TRIGGER trg_drama_copyright_no_delete BEFORE DELETE ON drama_copyright
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_drama_copyright_no_truncate BEFORE TRUNCATE ON drama_copyright
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();

-- drama_copyright_revision
ALTER TABLE drama_copyright_revision ALTER COLUMN proof_file_ids SET NOT NULL;
ALTER TABLE drama_copyright_revision ADD CONSTRAINT ck_drama_copyright_revision_change_kind
  CHECK (change_kind IN ('initial','extend','shorten','scope_change','correction'));
-- 修订类型与止日前后值不矛盾（new_end_date 列本身非空）：initial 没有前值；其余类型前值必有，
-- extend 变晚、shorten 变早、scope_change 不变、correction 不限方向。
ALTER TABLE drama_copyright_revision ADD CONSTRAINT ck_drama_copyright_revision_end_dates
  CHECK (CASE change_kind
           WHEN 'initial' THEN prev_end_date IS NULL
           WHEN 'extend' THEN prev_end_date IS NOT NULL AND new_end_date > prev_end_date
           WHEN 'shorten' THEN prev_end_date IS NOT NULL AND new_end_date < prev_end_date
           WHEN 'scope_change' THEN prev_end_date IS NOT NULL AND new_end_date = prev_end_date
           WHEN 'correction' THEN prev_end_date IS NOT NULL
           ELSE false
         END);
ALTER TABLE drama_copyright_revision ADD CONSTRAINT ck_drama_copyright_revision_copyright_snapshot
  CHECK (jsonb_typeof(copyright_snapshot) = 'object');
ALTER TABLE drama_copyright_revision ADD CONSTRAINT ck_drama_copyright_revision_proof_file_ids_elements
  CHECK (lyx_05_array_is_set(proof_file_ids));
-- 每部剧至多一条 initial 修订（首次上架时写入）。
CREATE UNIQUE INDEX uq_drama_copyright_revision_initial ON drama_copyright_revision (drama_id) WHERE change_kind = 'initial';
-- 只增：拦截 UPDATE、DELETE、TRUNCATE。
CREATE TRIGGER trg_drama_copyright_revision_append_only BEFORE UPDATE OR DELETE ON drama_copyright_revision
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_mutation();
CREATE TRIGGER trg_drama_copyright_revision_no_truncate BEFORE TRUNCATE ON drama_copyright_revision
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();

-- drama_stat
ALTER TABLE drama_stat ADD CONSTRAINT ck_drama_stat_counts
  CHECK (orders_30d >= 0 AND orders_mtd >= 0 AND live_items >= 0);
