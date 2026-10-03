-- 分组 11-publish：渠道账号与账号核验提交、上线任务与链接回填、巡检、下架（模块 publish）的手写约束。
-- 依据：docs/appendix/design/d3-flow.md 第 12–15 节；rulings M4，第二轮 M46–M49、M56、M59、M60、M71–M73；docs/data-model/11-publish.md。
-- 只含 Prisma 表达不了的约束：CHECK、部分唯一索引、部分索引、数组列的 NOT NULL，以及 CHECK 用的一个函数。
-- 外键全部由 Prisma 片段生成（M46、M47），本文件不写外键。本分组没有只增表，不使用触发器。先执行 00-common.sql。
-- 标“补”的是字段级阶段按写作规范补的列间关系（草案只在状态机的守卫里写了规则）。

-- 公共：uuid 数组的元素不含 NULL、不重复（count(DISTINCT) 不计 NULL，两种情形都会使等式不成立）
CREATE OR REPLACE FUNCTION lyx_11_uuid_array_is_set(a uuid[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(a) = (SELECT count(DISTINCT e) FROM unnest(a) AS e)
$$;

-- channel_account
ALTER TABLE channel_account ADD CONSTRAINT ck_channel_account_platform
  CHECK (platform IN ('douyin','wechat_channels'));
ALTER TABLE channel_account ADD CONSTRAINT ck_channel_account_account_type
  CHECK (account_type IN ('enterprise','personal','none'));
ALTER TABLE channel_account ADD CONSTRAINT ck_channel_account_status
  CHECK (status IN ('pending_verify','available','abnormal','unbound'));
ALTER TABLE channel_account ADD CONSTRAINT ck_channel_account_abnormal_source
  CHECK (abnormal_source IN ('verify','manual'));
-- 补：规范化值非空、已转小写、不含空白（规范化本身在应用层做，这里只挡明显没做的情况）
ALTER TABLE channel_account ADD CONSTRAINT ck_channel_account_account_uid_norm
  CHECK (account_uid_norm <> '' AND account_uid_norm = lower(account_uid_norm) AND account_uid_norm !~ '\s');
-- 补：异常时来源、原因、说明三列齐全；待核验与可用时三列为空（已解绑的行保留解绑前的值）
ALTER TABLE channel_account ADD CONSTRAINT ck_channel_account_abnormal_fields
  CHECK ((status <> 'abnormal'
          OR (abnormal_source IS NOT NULL AND abnormal_reason_code IS NOT NULL AND abnormal_note IS NOT NULL))
     AND (status NOT IN ('pending_verify','available')
          OR (abnormal_source IS NULL AND abnormal_reason_code IS NULL AND abnormal_note IS NULL)));
-- 补：核验时间与核验人同有同无；可用的账号必有核验记录与账号类型
ALTER TABLE channel_account ADD CONSTRAINT ck_channel_account_verified
  CHECK ((verified_at IS NULL) = (verified_by_staff_id IS NULL)
     AND (status <> 'available' OR (verified_at IS NOT NULL AND account_type IS NOT NULL)));
-- 补：已解绑 ⇔ 有解绑时间
ALTER TABLE channel_account ADD CONSTRAINT ck_channel_account_unbound
  CHECK ((status = 'unbound') = (unbound_at IS NOT NULL));
-- 同一账号不能同时绑定两家门店；已解绑的行不占键
CREATE UNIQUE INDEX uq_channel_account_platform_uid_active
  ON channel_account (platform, account_uid_norm) WHERE status <> 'unbound';

-- channel_account_submission
-- Prisma 给标量数组列建的是可空列（只带默认值），这里补 NOT NULL（M49）
ALTER TABLE channel_account_submission ALTER COLUMN screenshot_file_ids SET NOT NULL;
ALTER TABLE channel_account_submission ADD CONSTRAINT ck_channel_account_submission_kind
  CHECK (kind IN ('new_binding','resubmit'));
-- 第 1 轮是新绑定，之后各轮是重新提交
ALTER TABLE channel_account_submission ADD CONSTRAINT ck_channel_account_submission_round_no
  CHECK (round_no >= 1 AND (round_no = 1) = (kind = 'new_binding'));
-- 主页截图至少 1 张；不含 NULL、不重复
ALTER TABLE channel_account_submission ADD CONSTRAINT ck_channel_account_submission_screenshot_file_ids
  CHECK (cardinality(screenshot_file_ids) >= 1 AND lyx_11_uuid_array_is_set(screenshot_file_ids));
-- 填报快照是对象，且四个必填键齐全（M72：商家选的账号类型进快照）
ALTER TABLE channel_account_submission ADD CONSTRAINT ck_channel_account_submission_filled_snapshot
  CHECK (jsonb_typeof(filled_snapshot) = 'object'
     AND filled_snapshot ?& ARRAY['platform','accountName','accountUid','accountType']);
ALTER TABLE channel_account_submission ADD CONSTRAINT ck_channel_account_submission_compare_result
  CHECK (compare_result IS NULL
      OR CASE WHEN jsonb_typeof(compare_result) = 'array' THEN jsonb_array_length(compare_result) >= 1 ELSE false END);

-- launch_task
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_platform
  CHECK (platform IN ('douyin','wechat_channels'));
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_review_status
  CHECK (review_status IN ('pending','verifying','need_fix','passed','void'));
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_last_patrol_result
  CHECK (last_patrol_result IN ('normal','abnormal','recovered'));
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_void_reason
  CHECK (void_reason IN ('terminated','usage_expired','account_changed'));
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_counts
  CHECK (current_round_no >= 0 AND verified_episode_count >= 0);
-- 补：作废 ⇔ 有作废原因；只有未上线的任务会被作废（已上线的任务在使用期结束或终止时走 launch.settle）
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_void
  CHECK ((review_status = 'void') = (void_reason IS NOT NULL)
     AND (review_status <> 'void' OR NOT is_live));
-- 补：已上线 ⇔ 有上线时间；已上线 ⇒ 已核验集数 > 0（不变量 publish.I6 的行内部分）
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_live
  CHECK (is_live = (went_live_at IS NOT NULL)
     AND (NOT is_live OR verified_episode_count > 0));
-- 补：上线首日与已核验集数同有同无（都由“已通过的回填”算出）
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_verified
  CHECK ((first_launch_date IS NULL) = (verified_episode_count = 0));
-- 补：待回填的任务轮次为 0；核验中、需补充、已通过的任务至少回填过一轮
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_round
  CHECK ((review_status <> 'pending' OR current_round_no = 0)
     AND (review_status NOT IN ('verifying','need_fix','passed') OR current_round_no >= 1));
-- 补：满集核验通过的任务必已上线，且停在“已通过”
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_completed
  CHECK (completed_at IS NULL OR (is_live AND review_status = 'passed'));
-- 补：最近巡检时间与结论同有同无
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_patrol
  CHECK ((last_patrolled_at IS NULL) = (last_patrol_result IS NULL));
-- 巡检候选、下架任务生成、工单求值都只看已上线的任务
CREATE INDEX ix_launch_task_order_item_id_live ON launch_task (order_item_id) WHERE is_live;

-- launch_submission
ALTER TABLE launch_submission ALTER COLUMN evidence_file_ids SET NOT NULL;
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_link_kind
  CHECK (link_kind IN ('collection','episodes'));
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_result
  CHECK (result IN ('pending','passed','passed_partial','returned','revoked','withdrawn'));
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_round_no
  CHECK (round_no >= 1);
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_reported_episode_count
  CHECK (reported_episode_count >= 1);
-- 按链接形态必填：合集链接或逐集链接至少其一，且与 link_kind 对应
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_links
  CHECK ((link_kind = 'collection' AND collection_url IS NOT NULL)
      OR (link_kind = 'episodes' AND episode_urls IS NOT NULL));
-- 补：链接校验的数据库兜底——只接受 https，长度不超过 2000（完整校验在契约层与服务层）
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_collection_url
  CHECK (collection_url IS NULL
      OR (collection_url ~ '^https://[^/[:space:]]' AND char_length(collection_url) <= 2000));
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_episode_urls
  CHECK (episode_urls IS NULL
      OR CASE WHEN jsonb_typeof(episode_urls) = 'array' THEN jsonb_array_length(episode_urls) >= 1 ELSE false END);
-- 补：实际上线日期不晚于回填当天（按 Asia/Shanghai 取日）
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_actual_launch_date
  CHECK (actual_launch_date <= (submitted_at AT TIME ZONE 'Asia/Shanghai')::date);
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_submit_actor_type
  CHECK (submit_actor_type IN ('merchant','staff','system','partner'));
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_submit_client
  CHECK (submit_client IN ('weapp','portal','admin'));
-- 提交人：系统 ⇔ 无操作人 id ⇔ 无客户端来源；商家从小程序或下载页提交，员工从后台提交
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_submitter
  CHECK ((submit_actor_type = 'system') = (submit_actor_id IS NULL)
     AND (submit_actor_type = 'system') = (submit_client IS NULL)
     AND (submit_actor_type <> 'merchant' OR submit_client IN ('weapp','portal'))
     AND (submit_actor_type <> 'staff' OR submit_client = 'admin'));
-- 补：通过过的行（含之后被撤销的）必有核验集数，且在 1 与本次声明集数之间；其余结果没有核验集数
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_verified
  CHECK (CASE WHEN result IN ('passed','passed_partial','revoked')
              THEN verified_episode_count IS NOT NULL
                   AND verified_episode_count BETWEEN 1 AND reported_episode_count
              ELSE verified_episode_count IS NULL
         END);
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_reopen_of
  CHECK (reopen_of_launch_submission_id IS NULL OR reopen_of_launch_submission_id <> id);
-- 链接核验截图选填；有则不含 NULL、不重复
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_evidence_file_ids
  CHECK (lyx_11_uuid_array_is_set(evidence_file_ids));

-- patrol_batch
-- 周起始日是周一
ALTER TABLE patrol_batch ADD CONSTRAINT ck_patrol_batch_week_start_date
  CHECK (EXTRACT(ISODOW FROM week_start_date) = 1);
ALTER TABLE patrol_batch ADD CONSTRAINT ck_patrol_batch_counts
  CHECK (live_total >= 0 AND sampled_count >= 0 AND sampled_count <= live_total);

-- patrol_task
ALTER TABLE patrol_task ALTER COLUMN evidence_file_ids SET NOT NULL;
ALTER TABLE patrol_task ADD CONSTRAINT ck_patrol_task_source
  CHECK (source IN ('weekly_sample','manual','reissue'));
ALTER TABLE patrol_task ADD CONSTRAINT ck_patrol_task_status
  CHECK (status IN ('pending','normal','abnormal','recovered','void'));
-- 清单模板编码与版本同有同无；巡检只用 patrol.check；版本号从 1 起（M56）
ALTER TABLE patrol_task ADD CONSTRAINT ck_patrol_task_checklist
  CHECK ((checklist_code IS NULL) = (checklist_version_no IS NULL)
     AND (checklist_code IS NULL OR checklist_code = 'patrol.check')
     AND (checklist_version_no IS NULL OR checklist_version_no >= 1));
-- 清单结果为空或是非空 JSON 数组
ALTER TABLE patrol_task ADD CONSTRAINT ck_patrol_task_results
  CHECK (results IS NULL
      OR CASE WHEN jsonb_typeof(results) = 'array' THEN jsonb_array_length(results) >= 1 ELSE false END);
ALTER TABLE patrol_task ADD CONSTRAINT ck_patrol_task_remind_count
  CHECK (remind_count >= 0);
-- 补：结论时间与结论人同有同无；待巡检没有结论，正常、异常、已恢复必有结论
ALTER TABLE patrol_task ADD CONSTRAINT ck_patrol_task_checked
  CHECK ((checked_at IS NULL) = (checked_by_staff_id IS NULL)
     AND (status <> 'pending' OR checked_at IS NULL)
     AND (status NOT IN ('normal','abnormal','recovered') OR checked_at IS NOT NULL));
-- 补：正常与已恢复都要求清单全部通过，必有清单结果与模板版本
ALTER TABLE patrol_task ADD CONSTRAINT ck_patrol_task_passed
  CHECK (status NOT IN ('normal','recovered') OR (results IS NOT NULL AND checklist_code IS NOT NULL));
-- 补：异常四列与状态一致
ALTER TABLE patrol_task ADD CONSTRAINT ck_patrol_task_abnormal
  CHECK ((status NOT IN ('pending','normal')
          OR (abnormal_kind_code IS NULL AND found_at IS NULL AND notified_at IS NULL AND recovered_at IS NULL))
     AND (status NOT IN ('abnormal','recovered')
          OR (abnormal_kind_code IS NOT NULL AND note IS NOT NULL AND found_at IS NOT NULL))
     AND (status = 'recovered') = (recovered_at IS NOT NULL)
     AND (notified_at IS NULL OR found_at IS NOT NULL));
-- 补：巡检截图不含 NULL、不重复；给出结论（正常、异常、已恢复）时至少 1 张（03:319“人工检查并截图”）
ALTER TABLE patrol_task ADD CONSTRAINT ck_patrol_task_evidence_file_ids
  CHECK (lyx_11_uuid_array_is_set(evidence_file_ids)
     AND (status NOT IN ('normal','abnormal','recovered') OR cardinality(evidence_file_ids) >= 1));
-- 每周生成的行（每周抽样与补发后优先）按“批次 × 上线任务”幂等；手动发起的不受此限
CREATE UNIQUE INDEX uq_patrol_task_batch_launch_task_generated
  ON patrol_task (patrol_batch_id, launch_task_id) WHERE source <> 'manual';
-- 同一上线任务同时至多一条在办（待巡检、异常）的巡检
CREATE UNIQUE INDEX uq_patrol_task_launch_task_id_open
  ON patrol_task (launch_task_id) WHERE status IN ('pending','abnormal');

-- takedown_task
ALTER TABLE takedown_task ALTER COLUMN evidence_file_ids SET NOT NULL;
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_trigger_kind
  CHECK (trigger_kind IN ('expiry','early_end','platform_termination','terminated_after_delivery'));
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_basis
  CHECK (basis IN ('live','delivered_unverified'));
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_status
  CHECK (status IN ('pending_merchant','merchant_confirmed','checked','void'));
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_merchant_method
  CHECK (merchant_method IN ('delete','private','not_published'));
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_check_method
  CHECK (check_method IN ('evidence','sampled_out'));
-- 清单模板编码与版本同有同无；版本号从 1 起（M56）
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_checklist
  CHECK ((checklist_code IS NULL) = (checklist_version_no IS NULL)
     AND (checklist_code IS NULL OR checklist_code IN ('takedown.check','takedown.absence_check'))
     AND (checklist_version_no IS NULL OR checklist_version_no >= 1));
-- 清单结果为空或是非空 JSON 数组
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_results
  CHECK (results IS NULL
      OR CASE WHEN jsonb_typeof(results) = 'array' THEN jsonb_array_length(results) >= 1 ELSE false END);
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_counts
  CHECK (still_online_count >= 0 AND breach_notice_count >= 0);
-- 补：商家确认三列同有同无；已确认必有，待商家下架必空（抽查仍在线、依据变更退回时清空）
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_merchant_confirm
  CHECK ((merchant_method IS NULL) = (merchant_confirmed_at IS NULL)
     AND (merchant_method IS NULL) = (merchant_confirmed_by_user_id IS NULL)
     AND (status <> 'merchant_confirmed' OR merchant_method IS NOT NULL)
     AND (status <> 'pending_merchant' OR merchant_method IS NULL));
-- 补：核查时限与参数快照同有同无，快照是 JSON 对象；商家确认后必有，待商家下架时为空（M60：快照列名 sla_snapshot）
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_check_due
  CHECK ((check_due_at IS NULL) = (sla_snapshot IS NULL)
     AND (sla_snapshot IS NULL OR jsonb_typeof(sla_snapshot) = 'object')
     AND (status <> 'merchant_confirmed' OR check_due_at IS NOT NULL)
     AND (status <> 'pending_merchant' OR check_due_at IS NULL));
-- 补：已核查 ⇔ 有核查时间 ⇔ 有核查方式。
--     逐条核查（evidence）：有核查人、清单模板与结果、不少于 2 张不重复的证据截图（d3:1940）；
--     按抽查放行（sampled_out）：只能来自商家已确认的任务，没有核查人、清单与证据（d3:1998 的 takedown.check_mode）
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_checked
  CHECK ((status = 'checked') = (checked_at IS NOT NULL)
     AND (status = 'checked') = (check_method IS NOT NULL)
     AND (checked_by_staff_id IS NOT NULL) = COALESCE(check_method = 'evidence', false)
     AND (check_method IS DISTINCT FROM 'evidence'
          OR (checklist_code IS NOT NULL AND results IS NOT NULL AND cardinality(evidence_file_ids) >= 2))
     AND (check_method IS DISTINCT FROM 'sampled_out'
          OR (merchant_method IS NOT NULL AND checklist_code IS NULL AND results IS NULL
              AND cardinality(evidence_file_ids) = 0)));
-- 补：证据截图不含 NULL、不重复
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_evidence_file_ids
  CHECK (lyx_11_uuid_array_is_set(evidence_file_ids));
-- 同一订单项的同一账号至多一条未作废的下架任务
CREATE UNIQUE INDEX uq_takedown_task_item_account_active
  ON takedown_task (order_item_id, channel_account_id) WHERE status <> 'void';
