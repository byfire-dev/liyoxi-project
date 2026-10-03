-- 分组 06-media：文件、媒体任务、素材、素材理解、证照识别、ZIP 缓存（模块 media）的手写约束。
-- 依据：docs/appendix/design/d5-media.md 第 4 节；docs/data-model/06-media.md。
-- 只含 Prisma 表达不了的约束：CHECK、部分索引、部分唯一索引、数组列的 NOT NULL、触发器，另有一条依赖扩展的 GIN 索引。
-- 外键（含归属复合外键）都在 Prisma 片段里（M46、M47）；pg_trgm 扩展在 00-common.sql（M49），本文件不再启用。
-- 三元组 GIN 索引 ix_store_asset_search 仍写在这里：它的操作符类依赖 pg_trgm，而校验与合并先执行 Prisma 的建表语句。
-- 本组没有只增表；触发器只用公共函数 lyx_forbid_delete()、lyx_forbid_column_change()（M50），没有自定义函数。

-- file_object
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_bucket
  CHECK (bucket IN ('secure','asset','media','pub'));
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_incoming_bucket
  CHECK (incoming_bucket IN ('secure','asset','media'));
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_category
  CHECK (category IN (
    'kyc_license','kyc_permit','pay_receipt','invoice','legal_doc','seal_image','consent_digest',
    'drama_license_doc','evidence','export',
    'profile_image','profile_video','profile_promo','store_asset','channel_screenshot','ticket_attachment','video_cover',
    'drama_master','trailer_src','ad_video','sample_video','sample_wm','final_episode','package_zip','publish_list',
    'trailer_out','poster','banner',
    'pay_bill','wecom_qr','account_proof','portrait_auth'));
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_scope_type
  CHECK (scope_type IN ('platform','entity','store'));
-- 归属列随范围：平台级两列为空；主体级只有 entity_id；门店级两列齐全。
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_scope
  CHECK ((scope_type = 'platform' AND entity_id IS NULL AND store_id IS NULL)
      OR (scope_type = 'entity' AND entity_id IS NOT NULL AND store_id IS NULL)
      OR (scope_type = 'store' AND entity_id IS NOT NULL AND store_id IS NOT NULL));
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_upload_actor_type
  CHECK (upload_actor_type IN ('merchant','staff','system'));
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_upload_client
  CHECK (upload_client IN ('weapp','portal','admin'));
-- 系统生成的文件没有上传人与客户端来源；其余两列必填。
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_upload_actor_system
  CHECK ((upload_actor_type = 'system' AND upload_actor_id IS NULL AND upload_client IS NULL)
      OR (upload_actor_type <> 'system' AND upload_actor_id IS NOT NULL AND upload_client IS NOT NULL));
-- 代传门店只出现在员工上传的文件上。
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_on_behalf
  CHECK (on_behalf_store_id IS NULL OR upload_actor_type = 'staff');
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_status
  CHECK (status IN ('pending','promoting','stored','rejected','expired','deleting','deleted'));
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_reject_reason
  CHECK (reject_reason IN ('size_mismatch','bad_magic','changed_after_confirm','copy_verify_failed','stamp_failed'));
-- 拒收原因与拒收状态同时出现。
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_reject_reason_status
  CHECK ((status = 'rejected') = (reject_reason IS NOT NULL));
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_upload_mode
  CHECK (upload_mode IN ('post','multipart','server'));
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_moderation_state
  CHECK (moderation_state IN ('none','pending','pass','review','block'));
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_declared_size
  CHECK (declared_size >= 0);
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_size_bytes
  CHECK (size_bytes >= 0);
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_sts_issued
  CHECK (sts_issued BETWEEN 0 AND 30);
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_sha256
  CHECK (sha256 ~ '^[0-9a-f]{64}$');
-- 续传标识只来自客户端上传。
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_client_token_actor
  CHECK (client_token IS NULL OR upload_actor_type <> 'system');
-- 已入库（含清除中、已清除）的文件必有入库时间与实际大小。
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_stored_facts
  CHECK (status NOT IN ('stored','deleting','deleted') OR (stored_at IS NOT NULL AND size_bytes IS NOT NULL));
-- 写入区键只出现在待确认、入库中、被拒收的文件上（d5 不变量 I9 的单行部分）。
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_incoming_key_status
  CHECK (incoming_key IS NULL OR status IN ('pending','promoting','rejected'));
-- 清除完成时间与已清除状态同时出现；恢复时置空。
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_deleted_at
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL));
-- 彻底删除标记只出现在已清除的文件上（A141）；有标记的文件不再恢复（应用守卫）。
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_erased_at
  CHECK (erased_at IS NULL OR status = 'deleted');
-- 续传幂等：同一上传人、分类、归属、批次下，待确认的 client_token 唯一。
-- 草案用 COALESCE(列, 0) 作哨兵，改为三条部分唯一索引：批次内、门店内、无门无批次。
CREATE UNIQUE INDEX uq_file_object_client_token_batch ON file_object
  (upload_actor_type, upload_actor_id, category, upload_batch_id, client_token)
  WHERE status = 'pending' AND client_token IS NOT NULL AND upload_batch_id IS NOT NULL;
CREATE UNIQUE INDEX uq_file_object_client_token_store ON file_object
  (upload_actor_type, upload_actor_id, category, store_id, client_token)
  WHERE status = 'pending' AND client_token IS NOT NULL AND upload_batch_id IS NULL AND store_id IS NOT NULL;
CREATE UNIQUE INDEX uq_file_object_client_token_noscope ON file_object
  (upload_actor_type, upload_actor_id, category, client_token)
  WHERE status = 'pending' AND client_token IS NOT NULL AND upload_batch_id IS NULL AND store_id IS NULL;
-- 清扫：待确认且过期的文件。
CREATE INDEX ix_file_object_pending ON file_object (upload_expires_at)
  WHERE status = 'pending';
-- 清扫：已入库但从未被引用的文件。
CREATE INDEX ix_file_object_orphan ON file_object (stored_at)
  WHERE status = 'stored' AND first_linked_at IS NULL AND purge_after IS NULL;
-- 清除任务的候选扫描。
CREATE INDEX ix_file_object_purge ON file_object (purge_after)
  WHERE status = 'stored' AND purge_after IS NOT NULL;
-- 批次名下的文件。
CREATE INDEX ix_file_object_upload_batch_id ON file_object (upload_batch_id)
  WHERE upload_batch_id IS NOT NULL;
-- 识别结果在同一主体内复用：按主体、CRC64、大小找同内容文件。
CREATE INDEX ix_file_object_entity_crc64 ON file_object (entity_id, crc64, size_bytes)
  WHERE status = 'stored' AND entity_id IS NOT NULL AND crc64 IS NOT NULL;
-- 后台“已清除文件”列表。
CREATE INDEX ix_file_object_deleted ON file_object (deleted_at DESC)
  WHERE status = 'deleted';
-- 清扫：被拒收但写入区对象还没删的文件（每 10 分钟）。
CREATE INDEX ix_file_object_rejected_incoming ON file_object (updated_at)
  WHERE status = 'rejected' AND incoming_key IS NOT NULL;
-- 文件行不物理删除（留痕；行没了桶里的对象就成了无主对象）。
CREATE TRIGGER trg_file_object_no_delete BEFORE DELETE ON file_object
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_file_object_no_truncate BEFORE TRUNCATE ON file_object
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();
-- 归属与落点创建后不可改。
CREATE TRIGGER trg_file_object_immutable BEFORE UPDATE ON file_object
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'entity_id', 'store_id', 'scope_type', 'bucket', 'object_key', 'category');

-- file_ref
ALTER TABLE file_ref ADD CONSTRAINT ck_file_ref_state
  CHECK (state IN ('live','released'));
-- 引用类型与角色是代码登记表的键，这里只约束写法（小写蛇形，长度上限）。
ALTER TABLE file_ref ADD CONSTRAINT ck_file_ref_ref_type
  CHECK (ref_type ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE file_ref ADD CONSTRAINT ck_file_ref_role
  CHECK (role ~ '^[a-z][a-z0-9_]{1,23}$');
-- 在用的引用没有保留期与释放时间；已释放的两者都有。
ALTER TABLE file_ref ADD CONSTRAINT ck_file_ref_state_times
  CHECK ((state = 'live' AND keep_until IS NULL AND released_at IS NULL)
      OR (state = 'released' AND keep_until IS NOT NULL AND released_at IS NOT NULL));
-- 清除复核：文件是否还有在用的引用。
CREATE INDEX ix_file_ref_live ON file_ref (file_id)
  WHERE state = 'live';

-- file_purge_run
-- Prisma 给标量数组列建的是可空列，这里补 NOT NULL。
ALTER TABLE file_purge_run ALTER COLUMN candidate_ids SET NOT NULL;
ALTER TABLE file_purge_run ADD CONSTRAINT ck_file_purge_run_mode
  CHECK (mode IN ('list_only','auto'));
ALTER TABLE file_purge_run ADD CONSTRAINT ck_file_purge_run_state
  CHECK (state IN ('proposed','held','approved','running','done','aborted','rejected'));
ALTER TABLE file_purge_run ADD CONSTRAINT ck_file_purge_run_candidate_count
  CHECK (candidate_count BETWEEN 0 AND 5000 AND candidate_count = cardinality(candidate_ids));
ALTER TABLE file_purge_run ADD CONSTRAINT ck_file_purge_run_candidate_bytes
  CHECK (candidate_bytes >= 0);
ALTER TABLE file_purge_run ADD CONSTRAINT ck_file_purge_run_counts
  CHECK (deleted_count >= 0 AND guard_trips >= 0);
ALTER TABLE file_purge_run ADD CONSTRAINT ck_file_purge_run_by_category
  CHECK (jsonb_typeof(by_category) = 'object');
-- 决定人与决定时间同时出现。
ALTER TABLE file_purge_run ADD CONSTRAINT ck_file_purge_run_decided
  CHECK ((decided_by_staff_id IS NULL) = (decided_at IS NULL));
-- 放行、驳回必有决定；只出清单的运行进入执行（含其后的完成、中止）也必有放行。
-- auto 模式未熔断时直接建为 running，没有决定。
ALTER TABLE file_purge_run ADD CONSTRAINT ck_file_purge_run_decided_state
  CHECK (decided_at IS NOT NULL
      OR (state NOT IN ('approved','rejected')
          AND NOT (mode = 'list_only' AND state IN ('running','done','aborted'))));
-- 同一时刻只有一个清除运行在执行。
CREATE UNIQUE INDEX uq_file_purge_run_running ON file_purge_run ((true))
  WHERE state = 'running';

-- media_info
ALTER TABLE media_info ADD CONSTRAINT ck_media_info_kind
  CHECK (kind IN ('video','audio','image'));
ALTER TABLE media_info ADD CONSTRAINT ck_media_info_rotation
  CHECK (rotation IN (0, 90, 180, 270));
ALTER TABLE media_info ADD CONSTRAINT ck_media_info_non_negative
  CHECK (duration_ms >= 0 AND width >= 0 AND height >= 0 AND display_width >= 0 AND display_height >= 0
     AND fps_num >= 0 AND fps_den > 0 AND audio_sample_rate >= 0 AND audio_channels >= 0
     AND audio_stream_count >= 0 AND bitrate_kbps >= 0 AND av_drift_ms >= 0);
ALTER TABLE media_info ADD CONSTRAINT ck_media_info_probe_version
  CHECK (probe_version >= 1);

-- media_check
ALTER TABLE media_check ADD CONSTRAINT ck_media_check_profile
  CHECK (profile IN ('master','trailer_src','ad','sample','final','asset'));
ALTER TABLE media_check ADD CONSTRAINT ck_media_check_gate
  CHECK (gate IN ('pass','reject'));
ALTER TABLE media_check ADD CONSTRAINT ck_media_check_rule_version
  CHECK (rule_version >= 1);
ALTER TABLE media_check ADD CONSTRAINT ck_media_check_items_array
  CHECK (jsonb_typeof(hard) = 'array' AND jsonb_typeof(soft) = 'array');

-- upload_batch
ALTER TABLE upload_batch ADD CONSTRAINT ck_upload_batch_purpose
  CHECK (purpose IN ('drama_master','final_release'));
ALTER TABLE upload_batch ADD CONSTRAINT ck_upload_batch_variant
  CHECK (variant IN ('common','douyin','wechat_channels'));
ALTER TABLE upload_batch ADD CONSTRAINT ck_upload_batch_state
  CHECK (state IN ('matching','uploading','verifying','ready','committed','canceled','expired'));
ALTER TABLE upload_batch ADD CONSTRAINT ck_upload_batch_scope
  CHECK (scope IN ('full','partial'));
ALTER TABLE upload_batch ADD CONSTRAINT ck_upload_batch_expected_count
  CHECK (expected_count >= 1);
-- 成片批次必须带整批的 AI 使用声明。
ALTER TABLE upload_batch ADD CONSTRAINT ck_upload_batch_final_ai_usage
  CHECK (purpose <> 'final_release' OR ai_usage IS NOT NULL);
-- 提交时间与已提交状态同时出现。
ALTER TABLE upload_batch ADD CONSTRAINT ck_upload_batch_committed_at
  CHECK ((state = 'committed') = (committed_at IS NOT NULL));
ALTER TABLE upload_batch ADD CONSTRAINT ck_upload_batch_note_len
  CHECK (char_length(note) <= 200);
-- 替换原因三选一（选“其他”时说明写 note）；只出现在原片批次上。
ALTER TABLE upload_batch ADD CONSTRAINT ck_upload_batch_replace_reason
  CHECK (replace_reason IN ('quality_fix','license_info_fix','other'));
ALTER TABLE upload_batch ADD CONSTRAINT ck_upload_batch_replace_reason_purpose
  CHECK (replace_reason IS NULL OR purpose = 'drama_master');
-- 过期扫描：未结束的批次。
CREATE INDEX ix_upload_batch_open ON upload_batch (expires_at)
  WHERE state IN ('matching','uploading','verifying','ready');

-- upload_batch_item
ALTER TABLE upload_batch_item ADD CONSTRAINT ck_upload_batch_item_match_method
  CHECK (match_method IN ('pattern','sequence','manual'));
ALTER TABLE upload_batch_item ADD CONSTRAINT ck_upload_batch_item_state
  CHECK (state IN ('pending','uploaded','checked','rejected','skipped','replaced'));
ALTER TABLE upload_batch_item ADD CONSTRAINT ck_upload_batch_item_episode_no
  CHECK (episode_no >= 1);
-- 同一批次内一集只有一个有效条目（被跳过、被替换的不算）。
CREATE UNIQUE INDEX uq_upload_batch_item_episode ON upload_batch_item (upload_batch_id, episode_no)
  WHERE episode_no IS NOT NULL AND state NOT IN ('skipped','replaced');

-- media_job
ALTER TABLE media_job ADD CONSTRAINT ck_media_job_kind
  CHECK (kind IN ('promote','probe','restamp',
                  'transcode_mp4','watermark_sample','normalize','zip_package',
                  'audit_image','audit_image_wx','audit_video','audit_text',
                  'asr','vision','doc_extract','digest','ocr'));
ALTER TABLE media_job ADD CONSTRAINT ck_media_job_mode
  CHECK (mode IN ('local','remote'));
ALTER TABLE media_job ADD CONSTRAINT ck_media_job_subject_type
  CHECK (subject_type IN ('file_object','zip_bundle','store_asset','ocr_result'));
ALTER TABLE media_job ADD CONSTRAINT ck_media_job_parent_type
  CHECK (parent_type IN ('store_asset','playable_asset','upload_batch','production_record','zip_bundle'));
ALTER TABLE media_job ADD CONSTRAINT ck_media_job_parent
  CHECK ((parent_type IS NULL) = (parent_id IS NULL));
ALTER TABLE media_job ADD CONSTRAINT ck_media_job_state
  CHECK (state IN ('queued','running','submitting','submitted','succeeded','failed','canceled'));
ALTER TABLE media_job ADD CONSTRAINT ck_media_job_attempts
  CHECK (attempt_no >= 0 AND max_attempts >= 1);
-- 结束时间与结束状态同时出现；人工重试回到 queued 时清空。
ALTER TABLE media_job ADD CONSTRAINT ck_media_job_finished_at
  CHECK ((state IN ('succeeded','failed','canceled')) = (finished_at IS NOT NULL));
ALTER TABLE media_job ADD CONSTRAINT ck_media_job_billable
  CHECK (billable_qty >= 0 AND est_cost_micro >= 0 AND (billable_qty IS NULL) = (billable_unit IS NULL));
-- 执行循环：到期的未结束任务（next_run_at 对 running、submitting 即租约到期时间）。
CREATE INDEX ix_media_job_due ON media_job (next_run_at)
  WHERE state IN ('queued','running','submitting','submitted');
-- 收尾与收敛扫描：父对象名下的任务。
CREATE INDEX ix_media_job_parent ON media_job (parent_type, parent_id)
  WHERE parent_id IS NOT NULL;
-- 后台“媒体任务”失败列表。
CREATE INDEX ix_media_job_failed ON media_job (finished_at DESC)
  WHERE state = 'failed';
-- 微信内容安全的异步结果按 trace_id 找任务。
CREATE INDEX ix_media_job_external_job_id ON media_job (external_job_id)
  WHERE external_job_id IS NOT NULL;

-- production_record
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_kind
  CHECK (kind IN ('sample','final','ad'));
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_variant
  CHECK (variant IN ('common','douyin','wechat_channels'));
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_source
  CHECK (source IN ('manual_upload','normalized','restamped','render','ai_assisted'));
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_production_tier
  CHECK (production_tier IN ('standard','advanced','top'));
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_master_source
  CHECK (master_source IN ('checkout','declared','current_fallback'));
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_aigc_state
  CHECK (aigc_state IN ('not_required','pending','verified','failed'));
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_aigc_origin
  CHECK (aigc_origin IN ('upstream','stamped'));
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_pipeline_state
  CHECK (pipeline_state IN ('uploading','checking','ready','rejected'));
-- 样片、成片必有订购项；广告必有广告 id。
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_order_item
  CHECK (kind = 'ad' OR order_item_id IS NOT NULL);
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_ad
  CHECK (kind <> 'ad' OR ad_id IS NOT NULL);
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_episode_no
  CHECK (episode_no >= 1);
-- 原片版本与认定方式同时出现。
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_master
  CHECK ((drama_episode_master_id IS NULL) = (master_source IS NULL));
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_ai_usage
  CHECK (jsonb_typeof(ai_usage) = 'object');
-- 流水线就绪时，AI 标识要么不需要、要么已回读验证（d5 不变量 I15 的单行部分）。
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_ready_aigc
  CHECK (pipeline_state <> 'ready' OR aigc_state IN ('not_required','verified'));
-- 就绪的成片必有集号（批次里未匹配的条目登记时集号可以为空）。
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_final_episode
  CHECK (kind <> 'final' OR pipeline_state <> 'ready' OR episode_no IS NOT NULL);
-- 按订购项取制作文件。
CREATE INDEX ix_production_record_order_item ON production_record (order_item_id, kind, episode_no)
  WHERE order_item_id IS NOT NULL;
-- 收敛扫描：流水线未结束的制作文件。
CREATE INDEX ix_production_record_pipeline ON production_record (pipeline_state)
  WHERE pipeline_state IN ('uploading','checking');

-- master_checkout
ALTER TABLE master_checkout ADD CONSTRAINT ck_master_checkout_episode_no
  CHECK (episode_no >= 1);
ALTER TABLE master_checkout ADD CONSTRAINT ck_master_checkout_checkout_count
  CHECK (checkout_count >= 1);

-- playable_asset
ALTER TABLE playable_asset ADD CONSTRAINT ck_playable_asset_kind
  CHECK (kind IN ('trailer','sample','ad'));
ALTER TABLE playable_asset ADD CONSTRAINT ck_playable_asset_owner_type
  CHECK (owner_type IN ('drama','order_item','ad'));
-- 资产种类与属主类型一一对应。
ALTER TABLE playable_asset ADD CONSTRAINT ck_playable_asset_kind_owner
  CHECK ((kind = 'trailer' AND owner_type = 'drama')
      OR (kind = 'sample' AND owner_type = 'order_item')
      OR (kind = 'ad' AND owner_type = 'ad'));
-- 预告片是平台级资产，归属列为空；样片与广告归门店，两列齐全。
ALTER TABLE playable_asset ADD CONSTRAINT ck_playable_asset_tenant
  CHECK ((kind = 'trailer' AND entity_id IS NULL AND store_id IS NULL)
      OR (kind <> 'trailer' AND entity_id IS NOT NULL AND store_id IS NOT NULL));
ALTER TABLE playable_asset ADD CONSTRAINT ck_playable_asset_state
  CHECK (state IN ('processing','ready','failed','retired'));
ALTER TABLE playable_asset ADD CONSTRAINT ck_playable_asset_spec_version
  CHECK (spec_version >= 1);
ALTER TABLE playable_asset ADD CONSTRAINT ck_playable_asset_ready_at
  CHECK (state <> 'ready' OR ready_at IS NOT NULL);
ALTER TABLE playable_asset ADD CONSTRAINT ck_playable_asset_retired_at
  CHECK ((state = 'retired') = (retired_at IS NOT NULL));
ALTER TABLE playable_asset ADD CONSTRAINT ck_playable_asset_renditions
  CHECK (jsonb_typeof(renditions) = 'array');
-- 收敛扫描：停在处理中的资产。
CREATE INDEX ix_playable_asset_processing ON playable_asset (updated_at)
  WHERE state = 'processing';
-- 归属、种类、来源与属主创建后不可改。
CREATE TRIGGER trg_playable_asset_immutable BEFORE UPDATE ON playable_asset
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'entity_id', 'store_id', 'kind', 'source_file_id', 'owner_type', 'owner_id');

-- zip_bundle
ALTER TABLE zip_bundle ADD CONSTRAINT ck_zip_bundle_owner_type
  CHECK (owner_type IN ('delivery_release'));
ALTER TABLE zip_bundle ADD CONSTRAINT ck_zip_bundle_zip_state
  CHECK (zip_state IN ('none','building','ready','failed'));
ALTER TABLE zip_bundle ADD CONSTRAINT ck_zip_bundle_zip_gen
  CHECK (zip_gen >= 0);
-- 只有就绪时才有 ZIP 文件（d5 不变量 I8 的单行部分）。
ALTER TABLE zip_bundle ADD CONSTRAINT ck_zip_bundle_file_state
  CHECK ((zip_state = 'ready') = (zip_file_id IS NOT NULL));
-- 发布清单文件与 ZIP 同代次生成，只在就绪时出现（清单文本为空时没有）。
ALTER TABLE zip_bundle ADD CONSTRAINT ck_zip_bundle_publish_list_file
  CHECK (publish_list_file_id IS NULL OR zip_state = 'ready');
-- 清除后钩子按 ZIP 文件找到所属缓存行；一个 ZIP 文件只属于一行。
CREATE UNIQUE INDEX uq_zip_bundle_zip_file_id ON zip_bundle (zip_file_id)
  WHERE zip_file_id IS NOT NULL;
-- 同上，发布清单文件。
CREATE UNIQUE INDEX uq_zip_bundle_publish_list_file_id ON zip_bundle (publish_list_file_id)
  WHERE publish_list_file_id IS NOT NULL;

-- drama_trailer
-- 没有手写约束。

-- drama_episode_master
ALTER TABLE drama_episode_master ADD CONSTRAINT ck_drama_episode_master_episode_no
  CHECK (episode_no >= 1);
ALTER TABLE drama_episode_master ADD CONSTRAINT ck_drama_episode_master_rev_no
  CHECK (rev_no >= 1);
ALTER TABLE drama_episode_master ADD CONSTRAINT ck_drama_episode_master_state
  CHECK (state IN ('ready','superseded'));
-- 当前版本一定是 ready。
ALTER TABLE drama_episode_master ADD CONSTRAINT ck_drama_episode_master_current_ready
  CHECK (NOT is_current OR state = 'ready');
-- 替换原因从批次复制，取值同 upload_batch.replace_reason。
ALTER TABLE drama_episode_master ADD CONSTRAINT ck_drama_episode_master_replace_reason
  CHECK (replace_reason IN ('quality_fix','license_info_fix','other'));
-- 每集至多一个当前版本。
CREATE UNIQUE INDEX uq_drama_episode_master_current ON drama_episode_master (drama_id, episode_no)
  WHERE is_current;

-- store_asset
-- Prisma 给标量数组列建的是可空列，这里补 NOT NULL（M49、M80）。
ALTER TABLE store_asset ALTER COLUMN portrait_auth_file_ids SET NOT NULL;
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_type
  CHECK (type IN ('image','video','recording','audio','document','text'));
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_upload_actor_type
  CHECK (upload_actor_type IN ('merchant','staff'));
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_upload_client
  CHECK (upload_client IN ('weapp','portal','admin'));
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_upload_actor_role
  CHECK (upload_actor_role IN ('owner','clerk'));
-- 商家上传必有角色快照；员工代传没有。
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_upload_actor_role_merchant
  CHECK ((upload_actor_type = 'merchant') = (upload_actor_role IS NOT NULL));
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_processing_state
  CHECK (processing_state IN ('pending','processing','processed'));
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_review_state
  CHECK (review_state IN ('unreviewed','reviewed'));
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_usability
  CHECK (usability IN ('ready','reference_only','need_reshoot','need_portrait_auth'));
-- 未复核时没有可用性与复核人；已复核时三者齐全。
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_review
  CHECK ((review_state = 'unreviewed' AND usability IS NULL AND reviewed_by_staff_id IS NULL AND reviewed_at IS NULL)
      OR (review_state = 'reviewed' AND usability IS NOT NULL AND reviewed_by_staff_id IS NOT NULL AND reviewed_at IS NOT NULL));
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_moderation_state
  CHECK (moderation_state IN ('none','pending','pass','review','block'));
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_adopted_count
  CHECK (adopted_count >= 0);
-- 文字类素材必有正文，其余类型没有。
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_text_body
  CHECK ((type = 'text') = (text_body IS NOT NULL));
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_lengths
  CHECK (char_length(title) <= 60 AND char_length(text_body) <= 500 AND char_length(note) <= 200);
-- 复核截止时间与时限参数快照同时出现。
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_due
  CHECK ((due_at IS NULL) = (sla_snapshot IS NULL));
-- 确认肖像授权必有授权材料，且确认后可用性不再是“需肖像授权”。
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_portrait_auth
  CHECK (portrait_authorized_at IS NULL
      OR (cardinality(portrait_auth_file_ids) >= 1 AND usability IS DISTINCT FROM 'need_portrait_auth'));
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_lock_version
  CHECK (lock_version >= 0);
-- 门店素材列表（未删除，按上传倒序）。
CREATE INDEX ix_store_asset_store ON store_asset (store_id, id DESC)
  WHERE deleted_at IS NULL;
-- 复核队列：已处理完、未删除。
CREATE INDEX ix_store_asset_review ON store_asset (review_state, id)
  WHERE deleted_at IS NULL AND processing_state = 'processed';
-- 复核时限：未复核素材按截止时间排序，供待办的派生查询与“审核时效”指标。
CREATE INDEX ix_store_asset_review_due ON store_asset (due_at)
  WHERE deleted_at IS NULL AND review_state = 'unreviewed' AND due_at IS NOT NULL;
-- 收敛扫描：停在处理中的素材。
CREATE INDEX ix_store_asset_stuck ON store_asset (updated_at)
  WHERE processing_state IN ('pending','processing');
-- 某条素材需求已收到的素材。
CREATE INDEX ix_store_asset_store_asset_demand_id ON store_asset (store_asset_demand_id)
  WHERE store_asset_demand_id IS NOT NULL;
-- 关键词检索（模糊匹配）。gin_trgm_ops 来自 00-common.sql 的 pg_trgm；Prisma 的建表语句先于公共文件执行，所以这条索引留在这里。
CREATE INDEX ix_store_asset_search ON store_asset USING gin (search_text gin_trgm_ops);
-- 归属、类型、上传人与复制来源创建后不可改。
CREATE TRIGGER trg_store_asset_immutable BEFORE UPDATE ON store_asset
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'entity_id', 'store_id', 'type', 'upload_actor_type', 'upload_actor_id', 'source_store_asset_id');

-- store_asset_file
ALTER TABLE store_asset_file ADD CONSTRAINT ck_store_asset_file_position
  CHECK (position >= 1);

-- store_asset_insight
ALTER TABLE store_asset_insight ADD CONSTRAINT ck_store_asset_insight_kind
  CHECK (kind IN ('transcript','vision','doc_text','structured_items','digest','tech_spec'));
ALTER TABLE store_asset_insight ADD CONSTRAINT ck_store_asset_insight_status
  CHECK (status IN ('ok','skipped','failed'));
ALTER TABLE store_asset_insight ADD CONSTRAINT ck_store_asset_insight_prompt_version
  CHECK (prompt_version >= 1);
ALTER TABLE store_asset_insight ADD CONSTRAINT ck_store_asset_insight_content
  CHECK (jsonb_typeof(content) = 'object');
-- 一个素材、一个文件、一个步骤、一个提示词版本只有一行；汇总步骤没有文件，单独一条。
-- 草案用 COALESCE(file_id, 0) 作哨兵，改为两条部分唯一索引。
CREATE UNIQUE INDEX uq_store_asset_insight_file_step ON store_asset_insight (store_asset_id, file_id, kind, prompt_version)
  WHERE file_id IS NOT NULL;
CREATE UNIQUE INDEX uq_store_asset_insight_asset_step ON store_asset_insight (store_asset_id, kind, prompt_version)
  WHERE file_id IS NULL;

-- store_asset_tag
ALTER TABLE store_asset_tag ADD CONSTRAINT ck_store_asset_tag_dimension
  CHECK (dimension IN ('content','usage','timeliness'));
ALTER TABLE store_asset_tag ADD CONSTRAINT ck_store_asset_tag_source
  CHECK (source IN ('auto','uploader','reviewer'));
-- 日期区间只用于时效维度，且起不晚于止。
ALTER TABLE store_asset_tag ADD CONSTRAINT ck_store_asset_tag_valid_range
  CHECK ((dimension = 'timeliness' OR (valid_start_date IS NULL AND valid_end_date IS NULL))
     AND (valid_start_date IS NULL OR valid_end_date IS NULL OR valid_start_date <= valid_end_date));

-- store_asset_usage
ALTER TABLE store_asset_usage ADD CONSTRAINT ck_store_asset_usage_used_by_type
  CHECK (used_by_type IN ('ad','drama_order','order_item','ad_version','episode_output'));
ALTER TABLE store_asset_usage ADD CONSTRAINT ck_store_asset_usage_role
  CHECK (role IN ('reference','adopted'));

-- store_asset_demand
ALTER TABLE store_asset_demand ADD CONSTRAINT ck_store_asset_demand_status
  CHECK (status IN ('open','done','canceled'));
ALTER TABLE store_asset_demand ADD CONSTRAINT ck_store_asset_demand_notify_scope
  CHECK (notify_scope IN ('owner_and_clerks','owner_only'));
ALTER TABLE store_asset_demand ADD CONSTRAINT ck_store_asset_demand_lengths
  CHECK (char_length(title) BETWEEN 1 AND 20 AND char_length(shooting_note) <= 200);
-- 结束时间与结束状态同时出现。
ALTER TABLE store_asset_demand ADD CONSTRAINT ck_store_asset_demand_closed_at
  CHECK ((status = 'open') = (closed_at IS NULL));
-- 到期扫描：进行中的需求按完成日期排序。
CREATE INDEX ix_store_asset_demand_open_due ON store_asset_demand (due_date)
  WHERE status = 'open';
-- 归属创建后不可改。
CREATE TRIGGER trg_store_asset_demand_immutable BEFORE UPDATE ON store_asset_demand
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('entity_id', 'store_id');

-- ocr_result
ALTER TABLE ocr_result ADD CONSTRAINT ck_ocr_result_doc_type
  CHECK (doc_type IN ('business_license','industry_permit','bank_receipt'));
ALTER TABLE ocr_result ADD CONSTRAINT ck_ocr_result_status
  CHECK (status IN ('pending','ok','unavailable','unreadable'));
ALTER TABLE ocr_result ADD CONSTRAINT ck_ocr_result_request_actor_type
  CHECK (request_actor_type IN ('merchant','staff','system'));
ALTER TABLE ocr_result ADD CONSTRAINT ck_ocr_result_request_client
  CHECK (request_client IN ('weapp','portal','admin'));
-- 系统发起的识别没有操作人与客户端来源；其余两列必填。
ALTER TABLE ocr_result ADD CONSTRAINT ck_ocr_result_request_actor_system
  CHECK ((request_actor_type = 'system' AND request_actor_id IS NULL AND request_client IS NULL)
      OR (request_actor_type <> 'system' AND request_actor_id IS NOT NULL AND request_client IS NOT NULL));
-- 许可证类型只出现在行业许可证上。
ALTER TABLE ocr_result ADD CONSTRAINT ck_ocr_result_permit_type
  CHECK (doc_type = 'industry_permit' OR permit_type IS NULL);
-- 识别成功必有字段密文。
ALTER TABLE ocr_result ADD CONSTRAINT ck_ocr_result_ok_fields
  CHECK (status <> 'ok' OR fields_enc IS NOT NULL);
-- 原始返回在库时必有清空时间。
ALTER TABLE ocr_result ADD CONSTRAINT ck_ocr_result_raw_purge
  CHECK (raw_enc IS NULL OR raw_purge_at IS NOT NULL);
ALTER TABLE ocr_result ADD CONSTRAINT ck_ocr_result_warnings
  CHECK (jsonb_typeof(warnings) = 'array');
ALTER TABLE ocr_result ADD CONSTRAINT ck_ocr_result_latency_ms
  CHECK (latency_ms >= 0);
-- 原始返回到期清空的扫描。
CREATE INDEX ix_ocr_result_raw_purge ON ocr_result (raw_purge_at)
  WHERE raw_enc IS NOT NULL;
-- 归属、被识别的文件与证照类型创建后不可改。
CREATE TRIGGER trg_ocr_result_immutable BEFORE UPDATE ON ocr_result
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('entity_id', 'store_id', 'file_id', 'doc_type');
