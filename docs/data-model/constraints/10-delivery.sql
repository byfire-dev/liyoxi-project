-- 分组 10-delivery：交付工单、方案、样片、成片、质检、成片包（delivery）的手写约束。
-- 依据：docs/appendix/design/d3-flow.md 第 7、8、10、11 节；d5-media.md 第 4.7、8 节；docs/data-model/10-delivery.md。
-- 只含 Prisma 表达不了的约束：CHECK、数组列的 NOT NULL、部分唯一索引、部分索引、触发器。
-- 外键（含归属复合外键、指向 staff / merchant_user 的多条关系）全部由 Prisma 片段生成（M46、M47）。

-- delivery_ticket
ALTER TABLE delivery_ticket ADD CONSTRAINT ck_delivery_ticket_step
  CHECK (step IN ('assigning','plan_confirm','ad_prep','sample_making','sample_confirm','batch_compose',
                  'delivering','awaiting_launch','launch_verify','in_service','takedown','archived','terminated'));
ALTER TABLE delivery_ticket ADD CONSTRAINT ck_delivery_ticket_waiting_on
  CHECK (waiting_on IN ('staff','merchant','none'));
-- 制作排期：取值与 billing 的 plan_revision、subscription_term 相同。
ALTER TABLE delivery_ticket ADD CONSTRAINT ck_delivery_ticket_schedule_priority
  CHECK (schedule_priority IN ('standard','priority','rush'));
ALTER TABLE delivery_ticket ADD CONSTRAINT ck_delivery_ticket_sample_no
  CHECK (sample_round_no >= 0 AND current_sample_version_no >= 1);
-- 暂停三列一致：未暂停时两列为空；暂停时有起始时间，剩余分钟不为负。
ALTER TABLE delivery_ticket ADD CONSTRAINT ck_delivery_ticket_pause
  CHECK (pause_count >= 0
         AND (pause_count > 0) = (paused_at IS NOT NULL)
         AND (pause_count > 0 OR pause_remaining_min IS NULL)
         AND pause_remaining_min >= 0);
-- 暂停只发生在步骤 1～9（待分配至上线核验）。
ALTER TABLE delivery_ticket ADD CONSTRAINT ck_delivery_ticket_pause_steps
  CHECK (pause_count = 0 OR step IN ('assigning','plan_confirm','ad_prep','sample_making','sample_confirm',
                                     'batch_compose','delivering','awaiting_launch','launch_verify'));
-- 离开待分配之后必有交付经理（从待分配直接终止的除外）。
ALTER TABLE delivery_ticket ADD CONSTRAINT ck_delivery_ticket_delivery_manager_required
  CHECK (step IN ('assigning','terminated') OR delivery_manager_id IS NOT NULL);
-- 终态与里程碑时间一一对应。
ALTER TABLE delivery_ticket ADD CONSTRAINT ck_delivery_ticket_archived
  CHECK ((step = 'archived') = (archived_at IS NOT NULL));
ALTER TABLE delivery_ticket ADD CONSTRAINT ck_delivery_ticket_terminated
  CHECK ((step = 'terminated') = (terminated_at IS NOT NULL));
-- 工单池与超时扫描：只扫在办工单。
CREATE INDEX ix_delivery_ticket_step_step_due_at ON delivery_ticket (step, step_due_at)
  WHERE step NOT IN ('archived','terminated');

-- delivery_ticket_stage
ALTER TABLE delivery_ticket_stage ADD CONSTRAINT ck_delivery_ticket_stage_step
  CHECK (step IN ('assigning','plan_confirm','ad_prep','sample_making','sample_confirm','batch_compose',
                  'delivering','awaiting_launch','launch_verify','in_service','takedown'));
ALTER TABLE delivery_ticket_stage ADD CONSTRAINT ck_delivery_ticket_stage_visit_no
  CHECK (visit_no >= 1);
ALTER TABLE delivery_ticket_stage ADD CONSTRAINT ck_delivery_ticket_stage_paused_minutes
  CHECK (paused_minutes >= 0);
-- 完成时间与离开事件同时有或同时无；完成不早于进入。
ALTER TABLE delivery_ticket_stage ADD CONSTRAINT ck_delivery_ticket_stage_completed
  CHECK ((completed_at IS NULL) = (exit_event IS NULL) AND completed_at >= entered_at);
ALTER TABLE delivery_ticket_stage ADD CONSTRAINT ck_delivery_ticket_stage_exit_event
  CHECK (exit_event ~ '^[a-z][a-z0-9_.]{1,63}$');
ALTER TABLE delivery_ticket_stage ADD CONSTRAINT ck_delivery_ticket_stage_sla_snapshot
  CHECK (sla_snapshot IS NULL OR jsonb_typeof(sla_snapshot) = 'object');
-- 一张工单同时至多一个未完成的环节。
CREATE UNIQUE INDEX uq_delivery_ticket_stage_open ON delivery_ticket_stage (delivery_ticket_id)
  WHERE completed_at IS NULL;
-- 超时环节统计（按环节、周期分组）。
CREATE INDEX ix_delivery_ticket_stage_breached ON delivery_ticket_stage (step, entered_at)
  WHERE is_breached;

-- delivery_ticket_pause
ALTER TABLE delivery_ticket_pause ADD CONSTRAINT ck_delivery_ticket_pause_reason
  CHECK (reason IN ('cancel_review','plan_amendment'));
ALTER TABLE delivery_ticket_pause ADD CONSTRAINT ck_delivery_ticket_pause_ref_type
  CHECK (ref_type IN ('approval_request','delivery_plan_version'));
-- 原因决定引用对象：取消审批引用审批单，方案修订引用方案版本。
ALTER TABLE delivery_ticket_pause ADD CONSTRAINT ck_delivery_ticket_pause_reason_ref
  CHECK ((reason = 'cancel_review' AND ref_type = 'approval_request')
      OR (reason = 'plan_amendment' AND ref_type = 'delivery_plan_version'));
ALTER TABLE delivery_ticket_pause ADD CONSTRAINT ck_delivery_ticket_pause_actor_type
  CHECK (actor_type IN ('merchant','staff','system','partner'));
ALTER TABLE delivery_ticket_pause ADD CONSTRAINT ck_delivery_ticket_pause_client
  CHECK (client IN ('weapp','portal','admin'));
-- 系统动作没有操作人 id 与客户端来源；其余类型两者都有（M44）。
ALTER TABLE delivery_ticket_pause ADD CONSTRAINT ck_delivery_ticket_pause_actor
  CHECK ((actor_type = 'system') = (actor_id IS NULL)
         AND (actor_type = 'system') = (client IS NULL));
ALTER TABLE delivery_ticket_pause ADD CONSTRAINT ck_delivery_ticket_pause_release_event
  CHECK (release_event IN ('rejected','withdrawn','voided','plan_confirmed','superseded','terminated','self_heal'));
ALTER TABLE delivery_ticket_pause ADD CONSTRAINT ck_delivery_ticket_pause_released
  CHECK ((released_at IS NULL) = (release_event IS NULL));
-- 解除事件与原因匹配：驳回、撤回、通过后作废只属于取消审批（与 cancel_request.close_reason 同名，M54）；
-- 方案确认、被新版本取代只属于方案修订。
ALTER TABLE delivery_ticket_pause ADD CONSTRAINT ck_delivery_ticket_pause_release_event_reason
  CHECK (release_event IS NULL
      OR release_event IN ('terminated','self_heal')
      OR (reason = 'cancel_review' AND release_event IN ('rejected','withdrawn','voided'))
      OR (reason = 'plan_amendment' AND release_event IN ('plan_confirmed','superseded')));
-- 未解除的暂停原因：求 pause_count、恢复时判断集合是否为空。
CREATE INDEX ix_delivery_ticket_pause_open ON delivery_ticket_pause (delivery_ticket_id)
  WHERE released_at IS NULL;

-- delivery_plan
ALTER TABLE delivery_plan ADD CONSTRAINT ck_delivery_plan_status
  CHECK (status IN ('drafting','pending_confirm','revising','confirmed'));
ALTER TABLE delivery_plan ADD CONSTRAINT ck_delivery_plan_draft
  CHECK (jsonb_typeof(draft) = 'object');
ALTER TABLE delivery_plan ADD CONSTRAINT ck_delivery_plan_version_no
  CHECK (draft_lock_version >= 0 AND current_version_no >= 0
         AND confirmed_version_no BETWEEN 1 AND current_version_no);
-- 起草中当且仅当尚未推送过。
ALTER TABLE delivery_plan ADD CONSTRAINT ck_delivery_plan_drafting
  CHECK ((status = 'drafting') = (current_version_no = 0)
         AND (current_version_no = 0) = (pushed_at IS NULL));
-- 已确认：确认的就是当前版本；确认版本号与确认时间同时有或同时无。
ALTER TABLE delivery_plan ADD CONSTRAINT ck_delivery_plan_confirmed
  CHECK ((confirmed_version_no IS NULL) = (confirmed_at IS NULL)
         AND (status <> 'confirmed'
              OR (confirmed_version_no IS NOT NULL AND confirmed_version_no = current_version_no)));

-- delivery_plan_version
ALTER TABLE delivery_plan_version ADD CONSTRAINT ck_delivery_plan_version_version_no
  CHECK (version_no >= 1);
ALTER TABLE delivery_plan_version ADD CONSTRAINT ck_delivery_plan_version_content_snapshot
  CHECK (jsonb_typeof(content_snapshot) = 'object');
ALTER TABLE delivery_plan_version ADD CONSTRAINT ck_delivery_plan_version_decision
  CHECK (decision IN ('confirmed','change_requested','superseded'));
ALTER TABLE delivery_plan_version ADD CONSTRAINT ck_delivery_plan_version_decide_actor_type
  CHECK (decide_actor_type IN ('merchant','staff','system','partner'));
ALTER TABLE delivery_plan_version ADD CONSTRAINT ck_delivery_plan_version_decide_client
  CHECK (decide_client IN ('weapp','portal','admin'));
-- 决定、时间、决定人类型同时有或同时无；系统动作没有操作人 id 与客户端来源，其余类型两者都有（M44）。
ALTER TABLE delivery_plan_version ADD CONSTRAINT ck_delivery_plan_version_decided
  CHECK ((decision IS NULL) = (decided_at IS NULL)
         AND (decision IS NULL) = (decide_actor_type IS NULL)
         AND (decide_actor_type IS NULL
              OR ((decide_actor_type = 'system') = (decide_actor_id IS NULL)
                  AND (decide_actor_type = 'system') = (decide_client IS NULL)))
         AND (decide_actor_type IS NOT NULL OR (decide_actor_id IS NULL AND decide_client IS NULL)));
-- 内容快照不可变：只允许把决定相关的五列从空写一次，其余列不可改，不可删。
CREATE TRIGGER trg_delivery_plan_version_write_once BEFORE UPDATE OR DELETE ON delivery_plan_version
  FOR EACH ROW EXECUTE FUNCTION lyx_write_once('decision', 'decided_at', 'decide_actor_type', 'decide_actor_id', 'decide_client');

-- delivery_plan_change_request
-- Prisma 给标量数组列建的是可空列，这里补 NOT NULL。
ALTER TABLE delivery_plan_change_request ALTER COLUMN kinds SET NOT NULL;
ALTER TABLE delivery_plan_change_request ADD CONSTRAINT ck_delivery_plan_change_request_kinds
  CHECK (cardinality(kinds) >= 1
         AND kinds <@ ARRAY['launch_date','account','customization','placement','ad','other']::text[]);
ALTER TABLE delivery_plan_change_request ADD CONSTRAINT ck_delivery_plan_change_request_note
  CHECK (char_length(btrim(note)) > 0);
ALTER TABLE delivery_plan_change_request ADD CONSTRAINT ck_delivery_plan_change_request_on_version_no
  CHECK (on_version_no >= 1);
-- 只能被更晚的版本解决。
ALTER TABLE delivery_plan_change_request ADD CONSTRAINT ck_delivery_plan_change_request_resolved_by_version_no
  CHECK (resolved_by_version_no > on_version_no);
-- 未解决的修改请求：推送新版本时回写 resolved_by_version_no。
CREATE INDEX ix_delivery_plan_change_request_open ON delivery_plan_change_request (delivery_plan_id)
  WHERE resolved_by_version_no IS NULL;

-- sample
-- Prisma 给标量数组列建的是可空列，这里补 NOT NULL。
ALTER TABLE sample ALTER COLUMN preview_channels SET NOT NULL;
ALTER TABLE sample ALTER COLUMN feedback_file_ids SET NOT NULL;
ALTER TABLE sample ADD CONSTRAINT ck_sample_status
  CHECK (status IN ('uploaded','check_rejected','qc_rejected','qc_passed','pushed','confirmed','change_requested','superseded'));
ALTER TABLE sample ADD CONSTRAINT ck_sample_version_no
  CHECK (version_no >= 1);
-- 时长在体检通过时回写：进入质检及以后的状态必有，且大于 0。
ALTER TABLE sample ADD CONSTRAINT ck_sample_duration_ms
  CHECK (duration_ms > 0
         AND (status NOT IN ('qc_rejected','qc_passed','pushed','confirmed','change_requested')
              OR duration_ms IS NOT NULL));
ALTER TABLE sample ADD CONSTRAINT ck_sample_ad_slots
  CHECK (jsonb_typeof(ad_slots) = 'array');
ALTER TABLE sample ADD CONSTRAINT ck_sample_ad_versions_used
  CHECK (jsonb_typeof(ad_versions_used) = 'array');
ALTER TABLE sample ADD CONSTRAINT ck_sample_preview_channels
  CHECK (preview_channels <@ ARRAY['weapp','album','portal','wecom']::text[]);
ALTER TABLE sample ADD CONSTRAINT ck_sample_confirm_viewed_via
  CHECK (confirm_viewed_via IN ('weapp','album','portal','wecom'));
ALTER TABLE sample ADD CONSTRAINT ck_sample_decide_client
  CHECK (decide_client IN ('weapp','portal','admin'));
-- 决定人：决定时间、客户端来源与决定人同时有或同时无；决定人恰为商家用户或代录员工之一；代录来自后台，商家不从后台决定。
ALTER TABLE sample ADD CONSTRAINT ck_sample_decided
  CHECK ((decided_at IS NULL) = (decide_client IS NULL)
         AND (decided_at IS NULL) = (decided_by_user_id IS NULL AND on_behalf_staff_id IS NULL)
         AND NOT (decided_by_user_id IS NOT NULL AND on_behalf_staff_id IS NOT NULL)
         AND (on_behalf_staff_id IS NULL OR decide_client = 'admin')
         AND (decided_by_user_id IS NULL OR decide_client <> 'admin'));
ALTER TABLE sample ADD CONSTRAINT ck_sample_feedback_kind
  CHECK (feedback_kind IN ('compose','ad_content'));
ALTER TABLE sample ADD CONSTRAINT ck_sample_feedback_time_ms
  CHECK (feedback_time_ms >= 0);
-- 质检过的版本必有质检记录。
ALTER TABLE sample ADD CONSTRAINT ck_sample_qc_record
  CHECK (status NOT IN ('qc_rejected','qc_passed','pushed','confirmed','change_requested') OR qc_record_id IS NOT NULL);
-- 推送人与推送时间同时有或同时无；推送过的版本必有；推送时至少确定一种查看方式。
ALTER TABLE sample ADD CONSTRAINT ck_sample_pushed
  CHECK ((pushed_at IS NULL) = (pushed_by_staff_id IS NULL)
         AND (status NOT IN ('pushed','confirmed','change_requested') OR pushed_at IS NOT NULL)
         AND (pushed_at IS NULL OR cardinality(preview_channels) >= 1));
-- 线下提供：时间与操作人同时有或同时无；查看方式含企业微信时必须已标记“已发送”。
ALTER TABLE sample ADD CONSTRAINT ck_sample_offline_sent
  CHECK ((offline_sent_at IS NULL) = (offline_sent_by_staff_id IS NULL)
         AND (NOT ('wecom' = ANY (preview_channels)) OR offline_sent_at IS NOT NULL));
-- “我已查看”的勾选：时间与用户同时有或同时无。
ALTER TABLE sample ADD CONSTRAINT ck_sample_viewed_ack
  CHECK ((viewed_ack_at IS NULL) = (viewed_ack_by_user_id IS NULL));
-- 已确认：由商家本人确认，带查看方式，且查看方式在推送时确定的集合内；不是小程序内播放的必须勾选过“我已查看”。
ALTER TABLE sample ADD CONSTRAINT ck_sample_confirmed
  CHECK (status <> 'confirmed'
      OR (decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL AND on_behalf_staff_id IS NULL
          AND confirm_viewed_via IS NOT NULL AND confirm_viewed_via = ANY (preview_channels)
          AND (confirm_viewed_via = 'weapp' OR viewed_ack_at IS NOT NULL)));
-- 查看方式声明只在确认时填写。
ALTER TABLE sample ADD CONSTRAINT ck_sample_confirm_viewed_via_status
  CHECK (confirm_viewed_via IS NULL OR status IN ('confirmed','superseded'));
-- 提出修改：有类型、有意见；由商家提出或交付经理代录，二者必居其一。
ALTER TABLE sample ADD CONSTRAINT ck_sample_change_requested
  CHECK (status <> 'change_requested'
      OR (decided_at IS NOT NULL AND feedback_kind IS NOT NULL
          AND feedback_note IS NOT NULL AND char_length(btrim(feedback_note)) > 0
          AND (decided_by_user_id IS NOT NULL) <> (on_behalf_staff_id IS NOT NULL)));
-- 修改意见的类型与正文同时有或同时无。
ALTER TABLE sample ADD CONSTRAINT ck_sample_feedback
  CHECK ((feedback_kind IS NULL) = (feedback_note IS NULL)
         AND (feedback_kind IS NOT NULL OR (feedback_time_ms IS NULL AND cardinality(feedback_file_ids) = 0)));
-- 一张工单同时至多一个“活着”的样片版本（待质检、质检通过、已推送、已确认）；上传新版本前先把旧版本置 superseded。
CREATE UNIQUE INDEX uq_sample_live ON sample (delivery_ticket_id)
  WHERE status IN ('uploaded','qc_passed','pushed','confirmed');

-- episode_output
ALTER TABLE episode_output ADD CONSTRAINT ck_episode_output_variant
  CHECK (variant IN ('common','douyin','wechat_channels'));
-- normalized：云端规格化产物（admin.productionRecord.normalize 生成，剪辑师登记；接口裁决 A142）。
ALTER TABLE episode_output ADD CONSTRAINT ck_episode_output_source
  CHECK (source IN ('manual_upload','normalized','sample_adopted','restamped','auto_compose'));
ALTER TABLE episode_output ADD CONSTRAINT ck_episode_output_status
  CHECK (status IN ('uploaded','check_rejected','qc_passed','qc_rejected','replaced'));
ALTER TABLE episode_output ADD CONSTRAINT ck_episode_output_no
  CHECK (episode_no >= 1 AND revision_no >= 1);
ALTER TABLE episode_output ADD CONSTRAINT ck_episode_output_size
  CHECK (size_bytes > 0 AND duration_ms > 0);
-- 当前版本必须质检通过。
ALTER TABLE episode_output ADD CONSTRAINT ck_episode_output_current
  CHECK (NOT is_current OR status = 'qc_passed');
-- 质检过的版本必有质检记录。
ALTER TABLE episode_output ADD CONSTRAINT ck_episode_output_qc_record
  CHECK (status NOT IN ('qc_passed','qc_rejected') OR qc_record_id IS NOT NULL);
-- 每集每变体至多一个当前版本；换版时先把旧行的 is_current 置假。
CREATE UNIQUE INDEX uq_episode_output_current ON episode_output (delivery_ticket_id, episode_no, variant)
  WHERE is_current;

-- qc_record
-- 成片包级质检在推送之前，对象是工单（M70）。
ALTER TABLE qc_record ADD CONSTRAINT ck_qc_record_target_type
  CHECK (target_type IN ('sample','episode_output','delivery_ticket'));
-- 成片包级质检的对象就是本行所属的工单。
ALTER TABLE qc_record ADD CONSTRAINT ck_qc_record_target_id
  CHECK (target_type <> 'delivery_ticket' OR target_id = delivery_ticket_id);
-- 对象类型决定清单模板。
ALTER TABLE qc_record ADD CONSTRAINT ck_qc_record_checklist_code
  CHECK ((target_type = 'sample' AND checklist_code = 'qc.sample')
      OR (target_type = 'episode_output' AND checklist_code = 'qc.episode')
      OR (target_type = 'delivery_ticket' AND checklist_code = 'qc.package'));
ALTER TABLE qc_record ADD CONSTRAINT ck_qc_record_checklist_version_no
  CHECK (checklist_version_no >= 1);
ALTER TABLE qc_record ADD CONSTRAINT ck_qc_record_results
  CHECK (jsonb_typeof(results) = 'array');
ALTER TABLE qc_record ADD CONSTRAINT ck_qc_record_verdict
  CHECK (verdict IN ('pass','fail'));
-- 不通过必须写原因（去掉首尾空白后非空）；通过不写原因。
ALTER TABLE qc_record ADD CONSTRAINT ck_qc_record_reject_reason
  CHECK ((verdict = 'fail') = (reject_reason IS NOT NULL)
         AND (reject_reason IS NULL OR char_length(btrim(reject_reason)) > 0));
-- 质检记录是证据：不可改、不可删、不可截断（M70）。
CREATE TRIGGER trg_qc_record_no_update BEFORE UPDATE ON qc_record
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_update();
CREATE TRIGGER trg_qc_record_no_delete BEFORE DELETE ON qc_record
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_qc_record_no_truncate BEFORE TRUNCATE ON qc_record
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();

-- delivery_release
-- Prisma 给标量数组列建的是可空列，这里补 NOT NULL。
ALTER TABLE delivery_release ALTER COLUMN changed_episode_nos SET NOT NULL;
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_variant
  CHECK (variant IN ('common','douyin','wechat_channels'));
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_kind
  CHECK (kind IN ('initial','reissue'));
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_state
  CHECK (state IN ('pushed','superseded','closed'));
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_close_reason
  CHECK (close_reason IN ('cancelled','usage_ended'));
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_counts
  CHECK (release_no >= 1 AND episode_count >= 1 AND total_bytes > 0 AND checklist_version_no >= 1);
-- 交付前检查的清单模板编码固定（M56：清单引用一律是编码 + 版本号）。
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_checklist_code
  CHECK (checklist_code = 'delivery.precheck');
-- 变更集号：没有空元素，都不小于 1。
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_changed_episode_nos
  CHECK (array_position(changed_episode_nos, NULL) IS NULL AND 1 <= ALL (changed_episode_nos));
-- 清单是数组，条数等于集数。
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_manifest_snapshot
  CHECK (jsonb_typeof(manifest_snapshot) = 'array' AND jsonb_array_length(manifest_snapshot) = episode_count);
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_precheck_results
  CHECK (jsonb_typeof(precheck_results) = 'array');
-- 发布清单文本不超过 200KB。
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_publish_list_text
  CHECK (octet_length(publish_list_text) <= 204800);
-- 补发必须写原因，且有变更的集。
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_reissue
  CHECK (kind <> 'reissue' OR (reason_code IS NOT NULL AND cardinality(changed_episode_nos) >= 1));
-- 状态与时间一致：已取代必有取代时间；已关闭必有关闭时间与原因，重开后三者清空。
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_state_times
  CHECK ((state = 'superseded') = (superseded_at IS NOT NULL)
         AND (state = 'closed') = (closed_at IS NOT NULL)
         AND (closed_at IS NULL) = (close_reason IS NULL));
-- 同一订单项同一变体至多一个生效中的成片包。
CREATE UNIQUE INDEX uq_delivery_release_live ON delivery_release (order_item_id, variant)
  WHERE state = 'pushed';
-- 清单快照不可变：只允许改状态与发布清单相关的列，不可删。
CREATE OR REPLACE FUNCTION lyx_10_delivery_release_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := ARRAY['state','superseded_at','closed_at','close_reason',
                          'publish_list_text','updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'table delivery_release: DELETE not allowed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable) THEN
    RAISE EXCEPTION 'table delivery_release: only columns % may be updated (manifest is immutable)', mutable
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_delivery_release_guard BEFORE UPDATE OR DELETE ON delivery_release
  FOR EACH ROW EXECUTE FUNCTION lyx_10_delivery_release_guard();

-- delivery_reissue
-- Prisma 给标量数组列建的是可空列，这里补 NOT NULL。
ALTER TABLE delivery_reissue ALTER COLUMN episode_nos SET NOT NULL;
ALTER TABLE delivery_reissue ADD CONSTRAINT ck_delivery_reissue_status
  CHECK (status IN ('open','published','cancelled'));
-- 至少 1 个集号；没有空元素，都不小于 1（1 <= ALL 遇到空元素得 NULL，须另判）。
ALTER TABLE delivery_reissue ADD CONSTRAINT ck_delivery_reissue_episode_nos
  CHECK (cardinality(episode_nos) >= 1
         AND array_position(episode_nos, NULL) IS NULL AND 1 <= ALL (episode_nos));
ALTER TABLE delivery_reissue ADD CONSTRAINT ck_delivery_reissue_note
  CHECK (char_length(btrim(note)) > 0);
-- 在途当且仅当未关闭；已发布当且仅当有对应的成片包。
ALTER TABLE delivery_reissue ADD CONSTRAINT ck_delivery_reissue_closed
  CHECK ((status = 'open') = (closed_at IS NULL)
         AND (status = 'published') = (published_delivery_release_id IS NOT NULL));
-- 同一工单同时只有一张在途补发单。
CREATE UNIQUE INDEX uq_delivery_reissue_open ON delivery_reissue (delivery_ticket_id)
  WHERE status = 'open';

-- download_grant
ALTER TABLE download_grant ADD CONSTRAINT ck_download_grant_grantee_type
  CHECK (grantee_type IN ('entity','partner'));
-- 被授权方是主体时，就是本行的归属主体。
ALTER TABLE download_grant ADD CONSTRAINT ck_download_grant_grantee
  CHECK (grantee_type <> 'entity' OR grantee_id = entity_id);
ALTER TABLE download_grant ADD CONSTRAINT ck_download_grant_state
  CHECK (state IN ('active','superseded','revoked'));
ALTER TABLE download_grant ADD CONSTRAINT ck_download_grant_valid_days
  CHECK (valid_days BETWEEN 1 AND 30);
ALTER TABLE download_grant ADD CONSTRAINT ck_download_grant_expires_at
  CHECK (expires_at > created_at);
ALTER TABLE download_grant ADD CONSTRAINT ck_download_grant_actor_type
  CHECK (actor_type IN ('merchant','staff','system','partner'));
ALTER TABLE download_grant ADD CONSTRAINT ck_download_grant_client
  CHECK (client IN ('weapp','portal','admin'));
-- 系统动作没有操作人 id 与客户端来源；其余类型两者都有（M44）。
ALTER TABLE download_grant ADD CONSTRAINT ck_download_grant_actor
  CHECK ((actor_type = 'system') = (actor_id IS NULL)
         AND (actor_type = 'system') = (client IS NULL));
-- 有效当且仅当没有结束时间；撤销原因只出现在已撤销的行上。
ALTER TABLE download_grant ADD CONSTRAINT ck_download_grant_ended
  CHECK ((state = 'active') = (ended_at IS NULL)
         AND (revoke_reason IS NULL OR state = 'revoked'));
-- 同一成片包、同一被授权方至多一条有效授权。
CREATE UNIQUE INDEX uq_download_grant_active ON download_grant (delivery_release_id, grantee_type, grantee_id)
  WHERE state = 'active';

-- delivery_download_log
ALTER TABLE delivery_download_log ADD CONSTRAINT ck_delivery_download_log_kind
  CHECK (kind IN ('episode','zip','publish_list'));
-- 单集下载必有集号，其余没有。
ALTER TABLE delivery_download_log ADD CONSTRAINT ck_delivery_download_log_episode_no
  CHECK ((kind = 'episode') = (episode_no IS NOT NULL) AND episode_no >= 1);
ALTER TABLE delivery_download_log ADD CONSTRAINT ck_delivery_download_log_actor_type
  CHECK (actor_type IN ('merchant','staff','partner'));
ALTER TABLE delivery_download_log ADD CONSTRAINT ck_delivery_download_log_client
  CHECK (client IN ('weapp','portal','admin'));
-- 员工只从后台下载且不经授权表；商家与服务商凭授权下载。
ALTER TABLE delivery_download_log ADD CONSTRAINT ck_delivery_download_log_actor
  CHECK ((actor_type = 'staff') = (client = 'admin')
         AND (actor_type = 'staff') = (download_grant_id IS NULL));
ALTER TABLE delivery_download_log ADD CONSTRAINT ck_delivery_download_log_url_ttl_sec
  CHECK (url_ttl_sec > 0);
ALTER TABLE delivery_download_log ADD CONSTRAINT ck_delivery_download_log_client_ack
  CHECK (client_ack IN ('saved','failed'));
ALTER TABLE delivery_download_log ADD CONSTRAINT ck_delivery_download_log_client_ack_at
  CHECK ((client_ack IS NULL) = (client_ack_at IS NULL));
-- 后台“商家已保存 45 / 80”：按成片包数已保存的集。
CREATE INDEX ix_delivery_download_log_saved ON delivery_download_log (delivery_release_id, episode_no)
  WHERE client_ack = 'saved';
-- 只增表：只允许把回执两列从空写一次，其余列不可改，不可删；另拦 TRUNCATE。
CREATE TRIGGER trg_delivery_download_log_write_once BEFORE UPDATE OR DELETE ON delivery_download_log
  FOR EACH ROW EXECUTE FUNCTION lyx_write_once('client_ack', 'client_ack_at');
CREATE TRIGGER trg_delivery_download_log_no_truncate BEFORE TRUNCATE ON delivery_download_log
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();

-- publish_list
-- Prisma 给标量数组列建的是可空列，这里补 NOT NULL。
ALTER TABLE publish_list ALTER COLUMN topics SET NOT NULL;
-- 保存人与保存时间同时有或同时无。
ALTER TABLE publish_list ADD CONSTRAINT ck_publish_list_saved
  CHECK ((saved_at IS NULL) = (saved_by_staff_id IS NULL));

-- publish_list_episode
ALTER TABLE publish_list_episode ADD CONSTRAINT ck_publish_list_episode_episode_no
  CHECK (episode_no >= 1);
ALTER TABLE publish_list_episode ADD CONSTRAINT ck_publish_list_episode_changed_in_release_no
  CHECK (changed_in_release_no >= 2);
