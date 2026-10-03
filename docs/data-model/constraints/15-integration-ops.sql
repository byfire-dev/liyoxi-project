-- 分组 15-integration-ops：回调收件（security）、租约与告警、不变量校验结果（ops）的手写约束。
-- 依据：docs/data-model/15-integration-ops.md；docs/appendix/design/d4-identity.md 第 9.6 节；
--       d2-payment.md 第 3.10 节；d7-platform.md 第 7.6、9.3、9.6 节；d3-flow.md 第 25.5 节；
--       rulings M19、M23、M42、M44、M50、M52、M63、M76、M96；第三轮各分组的检查项登记请求（14 分组 5.4）。
-- 只含 Prisma 表达不了的约束：CHECK、部分唯一索引、表达式唯一索引、部分索引与表达式索引、触发器。
-- 触发器一律用公共文件 00-common.sql 的函数（M50），本分组不定义自己的触发器函数。
-- 新增枚举取值按“先声明、下一版再写入”，用 NOT VALID + VALIDATE 替换 CHECK。
-- 不写跨节点时钟之间的先后关系 CHECK（first_seen_at 与 last_seen_at、started_at 与 finished_at 等）：
-- 写入方可能在不同节点，时钟偏差不应让告警或校验结果写不进去。

-- webhook_event
-- 回调来源：与 /api/v1/hooks/{provider}/ 的路径段一致；esign 在 V1.0 只声明。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_provider
  CHECK (provider IN ('wechatpay','wechat','wecom','ci','asr','sms','esign'));
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_mode
  CHECK (mode IN ('inline','inbox'));
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_process_state
  CHECK (process_state IN ('received','processed','ignored','failed','dead'));
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_event_id
  CHECK (event_id <> '' AND length(event_id) <= 200);
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_event_type
  CHECK (event_type <> '');
-- 原始报文的 sha256，32 字节。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_payload_digest
  CHECK (octet_length(payload_digest) = 32);
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_attempts
  CHECK (attempts >= 0);
-- 内联模式的行只可能是已处理或已忽略（去重行与处理结果同事务，d4 的 I21）。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_inline_state
  CHECK (mode <> 'inline' OR process_state IN ('processed','ignored'));
-- 处理完成时间与终态成对。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_processed_at
  CHECK ((process_state IN ('processed','ignored')) = (processed_at IS NOT NULL));
-- 待处理的行必有下一次处理时间，否则扫描永远捞不到它。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_next_attempt
  CHECK (process_state NOT IN ('received','failed') OR next_attempt_at IS NOT NULL);
-- 失败与死信必有错误摘要。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_error
  CHECK (process_state NOT IN ('failed','dead') OR error IS NOT NULL);
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_payload_object
  CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object');
-- 微信支付（M23）：载荷必有 summary（对象，长期保留），此外只允许 resourceCipher；
-- 摘要里任何层级都不得出现付款人标识（键名含 openid，不区分大小写，或键名为 payer）；
-- 密文必须是完整的三元组（AEAD_AES_256_GCM 解密要用 associated_data 与 nonce，d2 第 4.4 节第 5 步）。
-- 不保存解密后的明文。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_wechatpay_payload
  CHECK (provider <> 'wechatpay' OR (
    payload IS NOT NULL
    AND jsonb_typeof(payload -> 'summary') = 'object'
    AND (payload - ARRAY['summary','resourceCipher']) = '{}'::jsonb
    AND NOT jsonb_path_exists(payload -> 'summary',
          'strict $.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "openid" flag "i" || @.key == "payer")')
    AND (NOT (payload ? 'resourceCipher')
         OR (payload -> 'resourceCipher') ?& ARRAY['ciphertext','nonce','associated_data'])
  ));
-- 存了密文就必须记下密钥版本，否则轮换后无法回放。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_cipher_key_version
  CHECK (payload IS NULL OR NOT (payload ? 'resourceCipher') OR key_version IS NOT NULL);
-- summary 之外的载荷必须有计划清除时间。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_purge_required
  CHECK (payload IS NULL OR payload_purge_at IS NOT NULL OR (payload - 'summary') = '{}'::jsonb);
-- 计划清除时间不早于到达时间；有实际清除时间就必有计划清除时间。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_purge_plan
  CHECK ((payload_purge_at IS NULL OR payload_purge_at >= received_at)
         AND (payload_purged_at IS NULL OR payload_purge_at IS NOT NULL));
-- 清除之后载荷为空，或只剩 summary。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_payload_purged
  CHECK (payload_purged_at IS NULL OR payload IS NULL OR (payload - 'summary') = '{}'::jsonb);
-- 收件箱扫描：WHERE process_state IN ('received','failed') AND next_attempt_at <= now ORDER BY next_attempt_at。
CREATE INDEX ix_webhook_event_due ON webhook_event (next_attempt_at)
  WHERE process_state IN ('received','failed');
-- 死信列表与“回调积压”探针。
CREATE INDEX ix_webhook_event_dead ON webhook_event (received_at)
  WHERE process_state = 'dead';
-- 每日清除到期的载荷。
CREATE INDEX ix_webhook_event_purge_due ON webhook_event (payload_purge_at)
  WHERE payload_purge_at IS NOT NULL AND payload_purged_at IS NULL;
-- 举证用的列不可改（M50 的公共函数）。
CREATE TRIGGER trg_webhook_event_immutable BEFORE UPDATE ON webhook_event
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('provider', 'event_id', 'event_type', 'received_at', 'payload_digest');
-- 行不可删、表不可清空（保留期未定之前不清理；载荷到期清除是 UPDATE）。
CREATE TRIGGER trg_webhook_event_no_delete BEFORE DELETE ON webhook_event
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_webhook_event_no_truncate BEFORE TRUNCATE ON webhook_event
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();

-- worker_lease
-- 至多一行（连同主键）；行由第一次续约插入，不靠迁移播种。名字被 CHECK 固定，不需要另设防改触发器。
ALTER TABLE worker_lease ADD CONSTRAINT ck_worker_lease_name
  CHECK (name = 'primary');
ALTER TABLE worker_lease ADD CONSTRAINT ck_worker_lease_holder
  CHECK (holder <> '' AND holder_version <> '');
-- 租约行不可删、表不可清空：删掉后虽然下一次续约会重新插入，但可能被另一实例抢先插入而接任，
-- 两个实例在一个续约周期内同时工作；租约只能经“让出”（把 heartbeat_at 改早）交出（M50 的公共函数）。
CREATE TRIGGER trg_worker_lease_no_delete BEFORE DELETE ON worker_lease
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_worker_lease_no_truncate BEFORE TRUNCATE ON worker_lease
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();

-- alert_event
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_severity
  CHECK (severity IN ('P1','P2','P3'));
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_kind
  CHECK (kind IN ('probe','event'));
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_status
  CHECK (status IN ('open','acked','resolved'));
-- 规则键：小写点分，至少两段。
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_rule
  CHECK (rule ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');
-- 指纹 = 规则键，或 规则键 + ':' + 维度。
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_fingerprint
  CHECK (left(fingerprint, length(rule)) = rule
         AND (length(fingerprint) = length(rule)
              OR (substr(fingerprint, length(rule) + 1, 1) = ':' AND length(fingerprint) > length(rule) + 1)));
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_counts
  CHECK (occurrences >= 1 AND ok_streak >= 0 AND notify_count >= 0);
-- 连续正常次数只对探针型有意义。
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_ok_streak_kind
  CHECK (kind = 'probe' OR ok_streak = 0);
-- 恢复时间与已恢复状态成对。
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_resolved
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL));
-- 未认领的没有认领时间；已认领的必有认领时间；认领人与认领时间同有同无
-- （后台与命令行都以员工身份认领，M44 的单一操作人类型）。
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_acked
  CHECK ((status <> 'open' OR acked_at IS NULL)
         AND (status <> 'acked' OR acked_at IS NOT NULL)
         AND ((acked_at IS NULL) = (acked_by_staff_id IS NULL)));
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_notified
  CHECK ((notify_count = 0) = (last_notified_at IS NULL));
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_last_value
  CHECK (last_value IS NULL OR jsonb_typeof(last_value) = 'object');
-- 同一指纹至多一条未恢复的告警；探针与 raise() 的写入用它做 ON CONFLICT，
-- 命中时 severity = LEAST(旧值, 新值)（'P1' < 'P2' < 'P3'），只升不降。
CREATE UNIQUE INDEX uq_alert_event_open_fingerprint ON alert_event (fingerprint)
  WHERE status IN ('open','acked');

-- invariant_run
ALTER TABLE invariant_run ADD CONSTRAINT ck_invariant_run_mode
  CHECK (mode IN ('quick','full'));
ALTER TABLE invariant_run ADD CONSTRAINT ck_invariant_run_trigger
  CHECK (trigger IN ('schedule','deploy','drill','manual'));
ALTER TABLE invariant_run ADD CONSTRAINT ck_invariant_run_status
  CHECK (status IN ('running','succeeded','failed'));
-- 结束时间与运行状态成对。
ALTER TABLE invariant_run ADD CONSTRAINT ck_invariant_run_finished
  CHECK ((status = 'running') = (finished_at IS NULL));
-- 失败必有错误摘要，成功没有。
ALTER TABLE invariant_run ADD CONSTRAINT ck_invariant_run_error
  CHECK ((status <> 'failed' OR error IS NOT NULL) AND (status <> 'succeeded' OR error IS NULL));
ALTER TABLE invariant_run ADD CONSTRAINT ck_invariant_run_counts
  CHECK (checks_run >= 0 AND violations_found >= 0);
ALTER TABLE invariant_run ADD CONSTRAINT ck_invariant_run_scope
  CHECK (scope IS NULL OR jsonb_typeof(scope) = 'object');

-- invariant_violation
-- 检查项编号：<命名空间>.<编号>，如 billing.I3、payment.I5、flow.STUCK_TICKET。
ALTER TABLE invariant_violation ADD CONSTRAINT ck_invariant_violation_code
  CHECK (code ~ '^[a-z][a-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$');
-- 登记检查项的模块：01 第 5 节的模块名。
ALTER TABLE invariant_violation ADD CONSTRAINT ck_invariant_violation_module
  CHECK (module IN (
    'kernel','events','timers','flow','sla','audit','config','security','authz','providers',
    'identity','tenant','staff','approval','portal','profile','content','media','notify','docs',
    'billing','order','ad','delivery','publish','support','workbench',
    'analytics','reports','exports','ops'));
ALTER TABLE invariant_violation ADD CONSTRAINT ck_invariant_violation_severity
  CHECK (severity IN ('P1','P2'));
-- 违规对象的类型取最终表名（M19）；数据库只校验格式，取值由检查项登记表在启动时对照表名单校验。
ALTER TABLE invariant_violation ADD CONSTRAINT ck_invariant_violation_subject_type
  CHECK (subject_type IS NULL OR subject_type ~ '^[a-z][a-z0-9_]*$');
-- 全局性违规：subject_type、subject_id 为空；subject_key 可选，用来区分同一检查项下的多条全局违规
-- （参数键、开关键、清单编码等不是某张表一行的对象，14 分组 5.4）。
-- 有对象时 subject_type 必填，subject_id 与 subject_key 恰填一个。
ALTER TABLE invariant_violation ADD CONSTRAINT ck_invariant_violation_subject
  CHECK ((subject_type IS NULL AND subject_id IS NULL)
         OR (subject_type IS NOT NULL AND (subject_id IS NULL) <> (subject_key IS NULL)));
ALTER TABLE invariant_violation ADD CONSTRAINT ck_invariant_violation_subject_key
  CHECK (subject_key IS NULL OR subject_key <> '');
ALTER TABLE invariant_violation ADD CONSTRAINT ck_invariant_violation_detail
  CHECK (jsonb_typeof(detail) = 'object');
-- 所属主体写在 detail.entityId（全局表不带归属列）：有这个键就必须是 uuid 文本，按主体查询走表达式索引。
ALTER TABLE invariant_violation ADD CONSTRAINT ck_invariant_violation_detail_entity_id
  CHECK (NOT (detail ? 'entityId')
         OR (detail ->> 'entityId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
-- 处理时间与处理结论成对；处理结论不能是空白；有处理人就有处理时间；
-- 已解决的行要么有处理人（后台与命令行都以员工身份处理，M44），要么是 heal_only 检查项自愈后自动关闭的（auto_healed_at 非空）。
ALTER TABLE invariant_violation ADD CONSTRAINT ck_invariant_violation_resolved
  CHECK ((resolved_at IS NULL) = (resolution IS NULL)
         AND (resolution IS NULL OR btrim(resolution) <> '')
         AND (resolved_by_staff_id IS NULL OR resolved_at IS NOT NULL)
         AND (resolved_at IS NULL OR resolved_by_staff_id IS NOT NULL OR auto_healed_at IS NOT NULL));
-- 同一检查项对同一对象至多一条未解决的违规；持续存在时更新 last_seen_at、detail、auto_healed_at。
-- 可空列参与唯一：用 COALESCE 表达式索引，写入方的 ON CONFLICT 用同一组表达式。
CREATE UNIQUE INDEX uq_invariant_violation_open ON invariant_violation
  (code, COALESCE(subject_type, ''), COALESCE(subject_id::text, subject_key, ''))
  WHERE resolved_at IS NULL;
-- 后台“系统健康”“流程运维”两页的未解决列表；告警规则“不变量校验失败”按级别计数。
CREATE INDEX ix_invariant_violation_unresolved ON invariant_violation (severity, first_seen_at)
  WHERE resolved_at IS NULL;
-- /health 计费分节的 openViolations 与后台按模块计数（d1:1530）。
CREATE INDEX ix_invariant_violation_module_unresolved ON invariant_violation (module, severity)
  WHERE resolved_at IS NULL;
-- 按主体查看违规（d1:1539、1714 的单主体校验与处理；商家详情）。
CREATE INDEX ix_invariant_violation_entity_id ON invariant_violation ((detail ->> 'entityId'), first_seen_at);
