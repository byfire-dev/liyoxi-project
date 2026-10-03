-- 分组 14-config-data：字典、参数、站点配置、开关、清单模板（config）；埋点（analytics）；报表快照（reports）；导出（exports）的手写约束。
-- 依据：docs/data-model/14-config-data.md；docs/appendix/design/d6-notify-docs-data.md 第 4、5 节；d3-flow.md 第 10.1、10.2 节。
-- 先于本文件执行：Prisma 生成的建表语句、00-common.sql（lyx_forbid_mutation、lyx_write_once、lyx_forbid_delete、lyx_forbid_column_change）。
-- 内容：枚举与范围 CHECK、部分唯一索引、部分索引、表达式唯一索引、防改触发器，以及 analytics_event 的分区改造。
-- 例外（写作规范第 4 节“不写 CREATE TABLE”；M77 已确认）：Prisma 表达不了分区表，analytics_event 在本文件里
-- 以 Prisma 建出的表为模板（LIKE）重建为按 occurred_at 月度 RANGE 分区的表，列定义不在这里重复。
-- 新增枚举取值按“先声明、下一版再写入”，用 NOT VALID + VALIDATE 替换 CHECK。
-- 第二轮（M50）：不可删除、指定列不可改改用公共函数 lyx_forbid_delete()、lyx_forbid_column_change()，
-- 本分组只保留公共文件没有的三个触发器函数（lyx_14_status_transition、lyx_14_freeze_after、lyx_14_mutable_columns_only）。
-- 第三轮（M101、M109、M110 与各分组的请求）没有约束改动：只改文档里的播种数据、参数键与登记说明。

-- 本分组的触发器函数（lyx_14_ 开头）

-- status 列只允许按参数列出的方向迁移，参数形如 '原状态>新状态'。
-- 用法：CREATE TRIGGER trg_<表>_status BEFORE UPDATE ON <表>
--         FOR EACH ROW EXECUTE FUNCTION lyx_14_status_transition('draft>published', 'published>archived');
CREATE OR REPLACE FUNCTION lyx_14_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status || '>' || NEW.status) = ANY (TG_ARGV::text[])) THEN
    RAISE EXCEPTION 'table %: status transition % -> % not allowed', TG_TABLE_NAME, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- 行离开某个状态之后内容冻结：第 1 个参数是“可自由编辑”的状态，其余参数是冻结后仍可改的列。
-- 用法：CREATE TRIGGER trg_<表>_freeze BEFORE UPDATE ON <表>
--         FOR EACH ROW EXECUTE FUNCTION lyx_14_freeze_after('draft', 'status', 'updated_at');
CREATE OR REPLACE FUNCTION lyx_14_freeze_after() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := COALESCE(TG_ARGV[1:], ARRAY[]::text[]);
BEGIN
  IF OLD.status <> TG_ARGV[0]
     AND (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable) THEN
    RAISE EXCEPTION 'table %: row is frozen once status leaves %; only columns % may be updated',
      TG_TABLE_NAME, TG_ARGV[0], mutable
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- 只有参数列出的列可以更新，其余列创建后只读。
-- 用法：CREATE TRIGGER trg_<表>_mutable BEFORE UPDATE ON <表>
--         FOR EACH ROW EXECUTE FUNCTION lyx_14_mutable_columns_only('status', 'updated_at');
CREATE OR REPLACE FUNCTION lyx_14_mutable_columns_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := TG_ARGV::text[];
BEGIN
  IF (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable) THEN
    RAISE EXCEPTION 'table %: only columns % may be updated', TG_TABLE_NAME, mutable
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- dict_type
ALTER TABLE dict_type ADD CONSTRAINT ck_dict_type_type_key
  CHECK (type_key ~ '^[a-z][a-z0-9_]{1,23}$');
ALTER TABLE dict_type ADD CONSTRAINT ck_dict_type_structure
  CHECK (structure IN ('flat','tree'));
ALTER TABLE dict_type ADD CONSTRAINT ck_dict_type_disable_policy
  CHECK (disable_policy IN ('free','block_if_referenced','never'));
-- 平铺只有一层；树为 2 或 3 层。
ALTER TABLE dict_type ADD CONSTRAINT ck_dict_type_max_depth
  CHECK ((structure = 'flat' AND max_depth = 1) OR (structure = 'tree' AND max_depth BETWEEN 2 AND 3));
-- 顺序生成编码的前缀与位数同有同无。
ALTER TABLE dict_type ADD CONSTRAINT ck_dict_type_code_rule
  CHECK ((code_prefix IS NULL) = (code_width IS NULL)
         AND (code_prefix IS NULL OR code_prefix ~ '^[A-Z]{1,4}$')
         AND (code_width IS NULL OR code_width BETWEEN 1 AND 6));
ALTER TABLE dict_type ADD CONSTRAINT ck_dict_type_counters
  CHECK (next_code_no >= 1 AND version_no >= 1);
-- 系统枚举不可新增。
ALTER TABLE dict_type ADD CONSTRAINT ck_dict_type_system
  CHECK (NOT is_system OR NOT can_create);

-- dict_item
-- Prisma 的标量数组列建表时不带 NOT NULL，这里补上。
ALTER TABLE dict_item ALTER COLUMN tags SET NOT NULL;
ALTER TABLE dict_item ADD CONSTRAINT ck_dict_item_code
  CHECK (code ~ '^[A-Za-z0-9_-]{1,16}$');
ALTER TABLE dict_item ADD CONSTRAINT ck_dict_item_parent_code
  CHECK (parent_code IS NULL OR parent_code <> code);
ALTER TABLE dict_item ADD CONSTRAINT ck_dict_item_name
  CHECK (char_length(name) BETWEEN 1 AND 20);
ALTER TABLE dict_item ADD CONSTRAINT ck_dict_item_description
  CHECK (char_length(description) <= 40);
ALTER TABLE dict_item ADD CONSTRAINT ck_dict_item_ext
  CHECK (jsonb_typeof(ext) = 'object');
ALTER TABLE dict_item ADD CONSTRAINT ck_dict_item_position
  CHECK (position >= 0);
-- 同级不重名（一级项的上级编码按空串参与唯一）。
CREATE UNIQUE INDEX uq_dict_item_sibling_name ON dict_item (dict_type_key, COALESCE(parent_code, ''), name);
-- 编码保存后不可改；所属类型与上级同样不可改（编码由上级编码加序号生成）。
CREATE TRIGGER trg_dict_item_immutable BEFORE UPDATE ON dict_item
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('dict_type_key', 'code', 'parent_code');
-- 字典项只停用、不删除（行级 DELETE 与整表 TRUNCATE 都拦）。
CREATE TRIGGER trg_dict_item_no_delete BEFORE DELETE ON dict_item
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_dict_item_no_truncate BEFORE TRUNCATE ON dict_item
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();

-- param_value
-- 键是代码里登记的常量，数据库只校验写法：小写点分，2 至 6 段，总长不超过 64。
ALTER TABLE param_value ADD CONSTRAINT ck_param_value_key
  CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,5}$' AND char_length(key) <= 64);
-- 只能在生效前撤销。
ALTER TABLE param_value ADD CONSTRAINT ck_param_value_cancel_before_effective
  CHECK (cancelled_at IS NULL OR cancelled_at < effective_at);
ALTER TABLE param_value ADD CONSTRAINT ck_param_value_reason
  CHECK (char_length(reason) <= 100);
-- 同一个键在同一生效时刻只有一行未撤销的值；也是“取当前值”查询用的索引。
CREATE UNIQUE INDEX uq_param_value_key_effective_at ON param_value (key, effective_at DESC)
  WHERE cancelled_at IS NULL;
-- 受限更新（M14）：只允许把 cancelled_at 从空写一次，其余列不可改，不可删。
CREATE TRIGGER trg_param_value_write_once BEFORE UPDATE OR DELETE ON param_value
  FOR EACH ROW EXECUTE FUNCTION lyx_write_once('cancelled_at');
CREATE TRIGGER trg_param_value_no_truncate BEFORE TRUNCATE ON param_value
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();

-- site_config_revision
ALTER TABLE site_config_revision ADD CONSTRAINT ck_site_config_revision_config_key
  CHECK (config_key IN ('mall','home_recommend'));
ALTER TABLE site_config_revision ADD CONSTRAINT ck_site_config_revision_status
  CHECK (status IN ('draft','published','archived'));
-- 修订号与发布时间在发布时写入：草稿两者为空，已发布与已归档两者必有。
ALTER TABLE site_config_revision ADD CONSTRAINT ck_site_config_revision_published
  CHECK ((status = 'draft') = (rev_no IS NULL)
         AND (status = 'draft') = (published_at IS NULL)
         AND (status <> 'draft' OR published_by_staff_id IS NULL));
ALTER TABLE site_config_revision ADD CONSTRAINT ck_site_config_revision_rev_no
  CHECK ((rev_no IS NULL OR rev_no >= 1)
         AND (base_rev_no IS NULL OR base_rev_no >= 1)
         AND (rev_no IS NULL OR base_rev_no IS NULL OR rev_no > base_rev_no));
ALTER TABLE site_config_revision ADD CONSTRAINT ck_site_config_revision_content
  CHECK (jsonb_typeof(content) = 'object');
ALTER TABLE site_config_revision ADD CONSTRAINT ck_site_config_revision_note
  CHECK (char_length(note) <= 100);
-- 每个配置键至多一份草稿、至多一份已发布（“恰有一份已发布”由不变量校验）。
CREATE UNIQUE INDEX uq_site_config_revision_draft ON site_config_revision (config_key)
  WHERE status = 'draft';
CREATE UNIQUE INDEX uq_site_config_revision_published ON site_config_revision (config_key)
  WHERE status = 'published';
-- 修订行不删；配置键不可改；状态只能 草稿 → 已发布 → 已归档；发布后内容冻结。
CREATE TRIGGER trg_site_config_revision_no_delete BEFORE DELETE ON site_config_revision
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_site_config_revision_no_truncate BEFORE TRUNCATE ON site_config_revision
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_site_config_revision_immutable BEFORE UPDATE ON site_config_revision
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('config_key', 'created_by_staff_id', 'created_at');
CREATE TRIGGER trg_site_config_revision_status BEFORE UPDATE ON site_config_revision
  FOR EACH ROW EXECUTE FUNCTION lyx_14_status_transition('draft>published', 'published>archived');
CREATE TRIGGER trg_site_config_revision_freeze BEFORE UPDATE ON site_config_revision
  FOR EACH ROW EXECUTE FUNCTION lyx_14_freeze_after('draft', 'status', 'updated_at', 'lock_version');

-- home_banner
ALTER TABLE home_banner ADD CONSTRAINT ck_home_banner_jump_kind
  CHECK (jump_kind IN ('drama','mall','page','none'));
-- 跳转目标与跳转类型：不跳转时没有目标，其余必有且为对象。
ALTER TABLE home_banner ADD CONSTRAINT ck_home_banner_jump_target
  CHECK ((jump_kind = 'none') = (jump_target IS NULL)
         AND (jump_target IS NULL OR jsonb_typeof(jump_target) = 'object'));
ALTER TABLE home_banner ADD CONSTRAINT ck_home_banner_window
  CHECK (end_at IS NULL OR end_at > start_at);
ALTER TABLE home_banner ADD CONSTRAINT ck_home_banner_title
  CHECK (char_length(title) BETWEEN 1 AND 30);
ALTER TABLE home_banner ADD CONSTRAINT ck_home_banner_position
  CHECK (position >= 0);

-- site_notice
-- 公告类型即 ref_id 的多态类型，用最终表名（M19）；V1.1 的人工公告（ops）启用时再登记。
ALTER TABLE site_notice ADD CONSTRAINT ck_site_notice_kind
  CHECK (kind IN ('plan_revision','billing_param','agreement_version'));
ALTER TABLE site_notice ADD CONSTRAINT ck_site_notice_status
  CHECK (status IN ('announced','withdrawn'));
ALTER TABLE site_notice ADD CONSTRAINT ck_site_notice_lead
  CHECK (lead_days >= 0 AND effective_at >= announced_at);
-- 公告期不足的原因只可能来自协议版本。
ALTER TABLE site_notice ADD CONSTRAINT ck_site_notice_short_notice
  CHECK (short_notice_reason IS NULL
         OR (kind = 'agreement_version' AND char_length(short_notice_reason) BETWEEN 1 AND 100));
ALTER TABLE site_notice ADD CONSTRAINT ck_site_notice_text
  CHECK (char_length(title) BETWEEN 1 AND 40 AND char_length(summary) BETWEEN 1 AND 200);
-- 不含价格数字的摘要：计费类公告（价目修订、计费参数）必填，供 offline_contract 模式（showPrice = false）使用。
ALTER TABLE site_notice ADD CONSTRAINT ck_site_notice_summary_no_price
  CHECK ((kind NOT IN ('plan_revision','billing_param') OR summary_no_price IS NOT NULL)
         AND (summary_no_price IS NULL OR char_length(summary_no_price) BETWEEN 1 AND 200));
ALTER TABLE site_notice ADD CONSTRAINT ck_site_notice_link
  CHECK (jsonb_typeof(link) = 'object' AND link ? 'route');
-- 已撤回必有撤回时间与撤回人；未撤回两者为空。
ALTER TABLE site_notice ADD CONSTRAINT ck_site_notice_withdrawn
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)
         AND (status = 'withdrawn') = (withdrawn_by_staff_id IS NOT NULL));
-- 同一变更至多一条已公告的记录；已撤回的行保留，撤回后再次公告（如协议版本 pending → draft → pending）新建一行。
-- notices.announce：INSERT … ON CONFLICT (kind, ref_id) WHERE status = 'announced' DO NOTHING RETURNING id，无返回行时按同一条件查出已有 id。
CREATE UNIQUE INDEX uq_site_notice_kind_ref_id_announced ON site_notice (kind, ref_id)
  WHERE status = 'announced';
-- 首页公告条：status = 'announced' AND bar_enabled 中 announced_at 最新的一条。
CREATE INDEX ix_site_notice_bar ON site_notice (announced_at DESC)
  WHERE status = 'announced' AND bar_enabled;
-- 公告不可编辑、不可删：只允许撤回一次，撤回后整行冻结。
CREATE TRIGGER trg_site_notice_no_delete BEFORE DELETE ON site_notice
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_site_notice_no_truncate BEFORE TRUNCATE ON site_notice
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_site_notice_status BEFORE UPDATE ON site_notice
  FOR EACH ROW EXECUTE FUNCTION lyx_14_status_transition('announced>withdrawn');
CREATE TRIGGER trg_site_notice_mutable BEFORE UPDATE ON site_notice
  FOR EACH ROW EXECUTE FUNCTION lyx_14_mutable_columns_only('status', 'withdrawn_at', 'withdrawn_by_staff_id', 'updated_at');
CREATE TRIGGER trg_site_notice_freeze BEFORE UPDATE ON site_notice
  FOR EACH ROW EXECUTE FUNCTION lyx_14_freeze_after('announced');

-- feature_flag
ALTER TABLE feature_flag ADD CONSTRAINT ck_feature_flag_key
  CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,5}$' AND char_length(key) <= 48);
ALTER TABLE feature_flag ADD CONSTRAINT ck_feature_flag_value_type
  CHECK (value_type IN ('bool','enum','json'));
ALTER TABLE feature_flag ADD CONSTRAINT ck_feature_flag_exposed_to
  CHECK (exposed_to IN ('client','server'));
-- 默认值的 JSON 类型与值类型一致：bool 为布尔，enum 为字符串，json 不限。
ALTER TABLE feature_flag ADD CONSTRAINT ck_feature_flag_default_value
  CHECK (CASE value_type
           WHEN 'bool' THEN jsonb_typeof(default_value) = 'boolean'
           WHEN 'enum' THEN jsonb_typeof(default_value) = 'string'
           ELSE true
         END);
ALTER TABLE feature_flag ADD CONSTRAINT ck_feature_flag_rules
  CHECK (jsonb_typeof(rules) = 'array');

-- checklist_template
ALTER TABLE checklist_template ADD CONSTRAINT ck_checklist_template_code
  CHECK (code IN ('qc.sample','qc.episode','qc.package','delivery.precheck','launch.verify',
                  'patrol.check','takedown.check','takedown.absence_check','account.verify'));
ALTER TABLE checklist_template ADD CONSTRAINT ck_checklist_template_status
  CHECK (status IN ('draft','active','retired'));
ALTER TABLE checklist_template ADD CONSTRAINT ck_checklist_template_version_no
  CHECK (version_no >= 1);
-- 条目是数组；启用过的版本至少有一个条目。
ALTER TABLE checklist_template ADD CONSTRAINT ck_checklist_template_items
  CHECK (jsonb_typeof(items) = 'array' AND (status = 'draft' OR jsonb_array_length(items) >= 1));
-- 状态与时间一致：草稿没有启用与停用时间；启用中必有启用时间、没有停用时间；已停用必有停用时间。
ALTER TABLE checklist_template ADD CONSTRAINT ck_checklist_template_state_times
  CHECK ((status = 'draft' AND activated_at IS NULL AND retired_at IS NULL)
      OR (status = 'active' AND activated_at IS NOT NULL AND retired_at IS NULL)
      OR (status = 'retired' AND retired_at IS NOT NULL
          AND (activated_at IS NULL OR retired_at >= activated_at)));
-- 每个编码至多一个启用中的版本。
CREATE UNIQUE INDEX uq_checklist_template_active ON checklist_template (code)
  WHERE status = 'active';
-- 模板行不删；编码与版本号不可改；状态只能向前；启用后条目冻结（业务记录按编码与版本号还原当时的清单）。
CREATE TRIGGER trg_checklist_template_no_delete BEFORE DELETE ON checklist_template
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_checklist_template_no_truncate BEFORE TRUNCATE ON checklist_template
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_checklist_template_immutable BEFORE UPDATE ON checklist_template
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('code', 'version_no', 'created_by_staff_id', 'created_at');
CREATE TRIGGER trg_checklist_template_status BEFORE UPDATE ON checklist_template
  FOR EACH ROW EXECUTE FUNCTION lyx_14_status_transition('draft>active', 'draft>retired', 'active>retired');
CREATE TRIGGER trg_checklist_template_freeze BEFORE UPDATE ON checklist_template
  FOR EACH ROW EXECUTE FUNCTION lyx_14_freeze_after('draft', 'status', 'retired_at', 'updated_at', 'lock_version');

-- analytics_event
-- 分区改造：以 Prisma 建出的表为模板，重建为按 occurred_at 月度 RANGE 分区的表（列、默认值、NOT NULL 原样带过来）。
ALTER TABLE analytics_event RENAME TO analytics_event_plain;
CREATE TABLE analytics_event (LIKE analytics_event_plain INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
  PARTITION BY RANGE (occurred_at);
DROP TABLE analytics_event_plain;
ALTER TABLE analytics_event ADD CONSTRAINT pk_analytics_event PRIMARY KEY (occurred_at, id);
-- 索引建在父表上，自动下推到各分区。
CREATE INDEX ix_analytics_event_name_occurred_at ON analytics_event (name, occurred_at);
CREATE INDEX ix_analytics_event_entity_id_occurred_at ON analytics_event (entity_id, occurred_at)
  WHERE entity_id IS NOT NULL;
CREATE INDEX ix_analytics_event_merchant_user_id_occurred_at ON analytics_event (merchant_user_id, occurred_at)
  WHERE merchant_user_id IS NOT NULL;
-- 漏斗拼接：从用户反查匿名标识后，按 anonymous_id 取登录前的访问事件。
CREATE INDEX ix_analytics_event_anonymous_id_occurred_at ON analytics_event (anonymous_id, occurred_at)
  WHERE anonymous_id IS NOT NULL;
-- 去重标识上限 128：uuid 化之后，出站派生 out-{uuid}-{name} 最长 81，直记 srv-pkgdl-{uuid}-{uuid}-{方式}-{日} 约 100。
ALTER TABLE analytics_event ADD CONSTRAINT ck_analytics_event_event_id
  CHECK (char_length(event_id) BETWEEN 1 AND 128);
ALTER TABLE analytics_event ADD CONSTRAINT ck_analytics_event_name
  CHECK (name ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE analytics_event ADD CONSTRAINT ck_analytics_event_source
  CHECK (source IN ('client','outbox','direct'));
ALTER TABLE analytics_event ADD CONSTRAINT ck_analytics_event_actor_type
  CHECK (actor_type IN ('merchant','staff','system','partner'));
ALTER TABLE analytics_event ADD CONSTRAINT ck_analytics_event_client
  CHECK (client IN ('weapp','portal','admin'));
ALTER TABLE analytics_event ADD CONSTRAINT ck_analytics_event_role
  CHECK (role IN ('owner','clerk'));
-- client_platform、client_version 取自请求头，不做 CHECK：取值随微信客户端增加，
-- 直记事件与业务写同事务，写不进会连带业务事务失败（与 outbox_event 同一处理）。
-- 操作人：系统动作没有操作人 id 与客户端来源；员工与服务商必有操作人 id；
-- 商家要么有操作人 id（已登录），要么只有匿名标识（游客）。
ALTER TABLE analytics_event ADD CONSTRAINT ck_analytics_event_actor
  CHECK (CASE actor_type
           WHEN 'system' THEN actor_id IS NULL AND client IS NULL
           WHEN 'merchant' THEN actor_id IS NOT NULL OR anonymous_id IS NOT NULL
           ELSE actor_id IS NOT NULL
         END);
-- 端上事件只来自小程序里的商家，批次头必带匿名标识与会话标识。
ALTER TABLE analytics_event ADD CONSTRAINT ck_analytics_event_client_source
  CHECK (source <> 'client'
         OR (actor_type = 'merchant' AND client IS NOT NULL AND client = 'weapp'
             AND anonymous_id IS NOT NULL AND session_id IS NOT NULL));
-- 有门店必有主体；角色快照只在有归属用户时出现。
ALTER TABLE analytics_event ADD CONSTRAINT ck_analytics_event_scope
  CHECK ((store_id IS NULL OR entity_id IS NOT NULL) AND (role IS NULL OR merchant_user_id IS NOT NULL));
ALTER TABLE analytics_event ADD CONSTRAINT ck_analytics_event_props
  CHECK (jsonb_typeof(props) = 'object');
-- 只增：行级触发器建在父表上，自动带到各分区；到期清理按整分区 DETACH + DROP，不逐行删除。
CREATE TRIGGER trg_analytics_event_append_only BEFORE UPDATE OR DELETE ON analytics_event
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_mutation();
CREATE TRIGGER trg_analytics_event_no_truncate BEFORE TRUNCATE ON analytics_event
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();
-- 兜底分区：正常应为空，有数据即告警。
CREATE TABLE analytics_event_default PARTITION OF analytics_event DEFAULT;
CREATE TRIGGER trg_analytics_event_default_no_truncate BEFORE TRUNCATE ON analytics_event_default
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();
-- 建某个月的分区（已存在则跳过）；月界按 Asia/Shanghai 取。周期任务 analytics.partitions 与迁移都调用它。
-- 语句级的 TRUNCATE 触发器不会从父表带到分区，这里逐个分区补上。
CREATE OR REPLACE FUNCTION lyx_14_analytics_event_ensure_partition(p_month date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  m date := date_trunc('month', p_month)::date;
  part text := 'analytics_event_y' || to_char(m, 'YYYY') || 'm' || to_char(m, 'MM');
  lo timestamptz := m::timestamp AT TIME ZONE 'Asia/Shanghai';
  hi timestamptz := (m + interval '1 month')::timestamp AT TIME ZONE 'Asia/Shanghai';
BEGIN
  IF to_regclass(part) IS NULL THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF analytics_event FOR VALUES FROM (%L) TO (%L)', part, lo, hi);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation()',
                   'trg_' || part || '_no_truncate', part);
  END IF;
  RETURN part;
END;
$$;
-- 预建当月与未来 3 个月的分区。
SELECT lyx_14_analytics_event_ensure_partition(
         ((now() AT TIME ZONE 'Asia/Shanghai')::date + make_interval(months => i))::date)
  FROM generate_series(0, 3) AS i;

-- analytics_event_dedup
ALTER TABLE analytics_event_dedup ADD CONSTRAINT ck_analytics_event_dedup_event_id
  CHECK (char_length(event_id) BETWEEN 1 AND 128);

-- analytics_identity
-- 本表没有 Prisma 表达不了的约束：主键与普通索引都在片段里。

-- report_month_close
ALTER TABLE report_month_close ADD CONSTRAINT ck_report_month_close_report_key
  CHECK (report_key IN ('overview'));
ALTER TABLE report_month_close ADD CONSTRAINT ck_report_month_close_status
  CHECK (status IN ('closed','superseded'));
-- 月份取当月 1 日。
ALTER TABLE report_month_close ADD CONSTRAINT ck_report_month_close_month_date
  CHECK (EXTRACT(DAY FROM month_date) = 1);
ALTER TABLE report_month_close ADD CONSTRAINT ck_report_month_close_numbers
  CHECK (revision_no >= 1 AND metric_def_version >= 1);
ALTER TABLE report_month_close ADD CONSTRAINT ck_report_month_close_json
  CHECK (jsonb_typeof(payload) = 'object' AND jsonb_typeof(finality) = 'object');
-- 固化时刻不早于次月 1 日零点（Asia/Shanghai），写入时间不早于固化时刻。
ALTER TABLE report_month_close ADD CONSTRAINT ck_report_month_close_times
  CHECK (closed_at >= cutoff_at
         AND cutoff_at >= ((month_date + interval '1 month') AT TIME ZONE 'Asia/Shanghai'));
-- 员工重出快照必填原因。
ALTER TABLE report_month_close ADD CONSTRAINT ck_report_month_close_reason
  CHECK ((closed_by_staff_id IS NULL OR reason IS NOT NULL) AND char_length(reason) <= 100);
-- 同一报表同一月份至多一行当前有效的快照。
CREATE UNIQUE INDEX uq_report_month_close_current ON report_month_close (report_key, month_date)
  WHERE status = 'closed';
-- 快照内容不可改、不可删：只允许把状态从 closed 改为 superseded。
CREATE TRIGGER trg_report_month_close_no_delete BEFORE DELETE ON report_month_close
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_report_month_close_no_truncate BEFORE TRUNCATE ON report_month_close
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_report_month_close_status BEFORE UPDATE ON report_month_close
  FOR EACH ROW EXECUTE FUNCTION lyx_14_status_transition('closed>superseded');
CREATE TRIGGER trg_report_month_close_mutable BEFORE UPDATE ON report_month_close
  FOR EACH ROW EXECUTE FUNCTION lyx_14_mutable_columns_only('status', 'updated_at');

-- export_job
-- 单号：DC + 8 位日期 + 流水（至少 3 位）；预发环境加 T 前缀。
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_job_no
  CHECK (job_no ~ '^T?DC[0-9]{8}[0-9]{3,}$');
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_export_key
  CHECK (export_key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,3}$' AND char_length(export_key) <= 40);
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_format
  CHECK (format IN ('xlsx','csv'));
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_status
  CHECK (status IN ('queued','running','succeeded','failed','expired','cancelled'));
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_hashes
  CHECK (params_hash ~ '^[0-9a-f]{64}$' AND (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'));
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_json
  CHECK (jsonb_typeof(params) = 'object' AND jsonb_typeof(request_scope_snapshot) = 'object');
-- 不脱敏导出必填原因。
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_reason
  CHECK ((is_masked OR (reason IS NOT NULL AND char_length(btrim(reason)) > 0))
         AND (reason IS NULL OR char_length(reason) <= 100));
-- 认领序号：自动重试 1 次，最多认领 2 次。
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_counters
  CHECK (attempt_no BETWEEN 0 AND 2 AND download_count >= 0
         AND (row_count IS NULL OR row_count >= 0) AND (size_bytes IS NULL OR size_bytes >= 0));
-- 按状态必填：执行中必有租约与开始时间；成功与过期必有文件、行数、字节数、哈希、过期时间；
-- 成功、失败、取消必有结束时间；失败必有原因。
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_state_fields
  CHECK ((status <> 'running' OR (lease_until IS NOT NULL AND started_at IS NOT NULL AND attempt_no >= 1))
     AND (status NOT IN ('succeeded','expired')
          OR (file_id IS NOT NULL AND row_count IS NOT NULL AND size_bytes IS NOT NULL
              AND sha256 IS NOT NULL AND expires_at IS NOT NULL))
     AND (status NOT IN ('succeeded','failed','cancelled','expired') OR finished_at IS NOT NULL)
     AND (status <> 'failed' OR error IS NOT NULL)
     AND (status IN ('succeeded','expired') OR file_id IS NULL));
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_error
  CHECK (char_length(error) <= 200);
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_downloads
  CHECK ((download_count = 0) = (last_downloaded_at IS NULL));
-- 同一申请人、同一导出、同一参数只允许一个进行中的任务：重复点击返回同一个任务。
CREATE UNIQUE INDEX uq_export_job_inflight ON export_job (requested_by_staff_id, export_key, params_hash)
  WHERE status IN ('queued','running');
-- worker 认领：WHERE status = 'queued' ORDER BY created_at。
CREATE INDEX ix_export_job_queued ON export_job (created_at)
  WHERE status = 'queued';
-- export.sweep 回收过期租约：WHERE status = 'running' AND lease_until < now。
CREATE INDEX ix_export_job_running_lease ON export_job (lease_until)
  WHERE status = 'running';
-- export.sweep 置过期并删文件：WHERE status = 'succeeded' AND expires_at < now。
CREATE INDEX ix_export_job_expiry ON export_job (expires_at)
  WHERE status = 'succeeded';
-- 申请内容不可改（留痕）：申请时写入的列创建后只读。format 例外，执行中可由 xlsx 改为 csv。
CREATE TRIGGER trg_export_job_immutable BEFORE UPDATE ON export_job
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'job_no', 'export_key', 'params', 'params_hash', 'requested_by_staff_id',
    'request_scope_snapshot', 'is_masked', 'reason', 'created_at');
CREATE TRIGGER trg_export_job_no_delete BEFORE DELETE ON export_job
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_export_job_no_truncate BEFORE TRUNCATE ON export_job
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();
