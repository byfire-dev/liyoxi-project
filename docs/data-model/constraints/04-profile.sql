-- 分组 04-profile：门店档案与资质审核（模块 profile）
-- 手写约束：CHECK、部分唯一索引、表达式索引、部分索引、数组列的 NOT NULL、防改触发器。外键全部由 Prisma 片段生成（M46、M47）。
-- 依据：docs/appendix/design/d9-profile.md 第 3.2–3.6、3.10 节；标“补”的是字段级阶段按写作规范补的列间关系。
-- 先执行 00-common.sql。本分组没有只增表；防改触发器用公共函数 lyx_forbid_column_change（M50）。

-- 公共：数组列的元素不重复、不含 NULL（count(DISTINCT) 不计 NULL，所以两种情形都会使等式不成立）
CREATE OR REPLACE FUNCTION lyx_04_text_array_is_set(a text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(a) = (SELECT count(DISTINCT e) FROM unnest(a) AS e)
$$;

-- store_profile
-- Prisma 的标量数组列建表时不带 NOT NULL，这里补上（d9:127、137 要求 NOT NULL 默认 '{}'；M49）
ALTER TABLE store_profile ALTER COLUMN selling_point_codes SET NOT NULL;
ALTER TABLE store_profile ALTER COLUMN copy_options SET NOT NULL;
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_contact_phone_source
  CHECK (contact_phone_source IN ('login', 'sms_verified', 'unverified'));
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_completeness_pct
  CHECK (completeness_pct BETWEEN 0 AND 100);
-- 卖点至多 5 个；不重复、不含 NULL
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_selling_point_codes
  CHECK (cardinality(selling_point_codes) <= 5 AND lyx_04_text_array_is_set(selling_point_codes));
-- 复制项只能是四个取值；不重复
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_copy_options
  CHECK (copy_options <@ ARRAY['basic', 'service', 'media', 'brand_assets']::text[] AND lyx_04_text_array_is_set(copy_options));
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_avg_spend_fen
  CHECK (avg_spend_fen >= 0);
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_last_edit_actor_type
  CHECK (last_edit_actor_type IN ('merchant', 'staff', 'system', 'partner'));
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_last_edit_client
  CHECK (last_edit_client IN ('weapp', 'portal', 'admin'));
-- 补：已填必填项数不超过全部必填项数
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_required_counts
  CHECK (required_filled >= 0 AND required_filled <= required_total);
-- 补：最近修改的四列同有同无；system 没有操作人 id 与客户端来源，其余类型两者都必有
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_last_edit
  CHECK (
    (last_edited_at IS NULL AND last_edit_actor_type IS NULL AND last_edit_actor_id IS NULL AND last_edit_client IS NULL)
    OR (
      last_edited_at IS NOT NULL AND last_edit_actor_type IS NOT NULL
      AND (last_edit_actor_type = 'system') = (last_edit_actor_id IS NULL)
      AND (last_edit_actor_type = 'system') = (last_edit_client IS NULL)
    )
  );
-- 补：联系人手机号的密文、脱敏串、来源同有同无
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_contact_phone
  CHECK (
    (contact_phone_enc IS NULL) = (contact_phone_mask IS NULL)
    AND (contact_phone_enc IS NULL) = (contact_phone_source IS NULL)
  );
-- 补：验证时间只在来源为短信验证时有
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_contact_phone_verified_at
  CHECK ((contact_phone_verified_at IS NOT NULL) = (contact_phone_source IS NOT DISTINCT FROM 'sms_verified'));
-- 补：经纬度成对出现并在合法范围内
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_geo
  CHECK (
    (latitude IS NULL) = (longitude IS NULL)
    AND (latitude IS NULL OR latitude BETWEEN -90 AND 90)
    AND (longitude IS NULL OR longitude BETWEEN -180 AND 180)
  );
-- 补：复制项只在有复制来源时出现；来源不能是自己
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_copy_source
  CHECK (
    (copied_from_store_id IS NOT NULL OR cardinality(copy_options) = 0)
    AND (copied_from_store_id IS NULL OR copied_from_store_id <> store_id)
  );
-- 补：营业时间的顶层必须是数组（防止写入 JSON null 或对象）
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_business_hours
  CHECK (jsonb_typeof(business_hours) = 'array');
-- 后台按功能区筛选
CREATE INDEX ix_store_profile_zone_code ON store_profile (zone_code) WHERE zone_code IS NOT NULL;
-- 补：归属列与复制来源、复制项创建后不可改
CREATE TRIGGER trg_store_profile_immutable BEFORE UPDATE ON store_profile
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('store_id', 'entity_id', 'copied_from_store_id', 'copy_options');

-- store_profile_media
ALTER TABLE store_profile_media ADD CONSTRAINT ck_store_profile_media_media_group
  CHECK (media_group IN ('door', 'interior', 'product', 'promo'));
ALTER TABLE store_profile_media ADD CONSTRAINT ck_store_profile_media_media_kind
  CHECK (media_kind IN ('image', 'video'));
ALTER TABLE store_profile_media ADD CONSTRAINT ck_store_profile_media_position
  CHECK (position >= 1);
-- 补：门头照片、店内环境只收图片
ALTER TABLE store_profile_media ADD CONSTRAINT ck_store_profile_media_group_kind
  CHECK (media_group NOT IN ('door', 'interior') OR media_kind = 'image');
ALTER TABLE store_profile_media ADD CONSTRAINT ck_store_profile_media_create_actor_type
  CHECK (create_actor_type IN ('merchant', 'staff', 'system', 'partner'));
ALTER TABLE store_profile_media ADD CONSTRAINT ck_store_profile_media_create_client
  CHECK (create_client IN ('weapp', 'portal', 'admin'));
-- 补：system 没有创建人 id 与客户端来源，其余类型两者都必有（M44）
ALTER TABLE store_profile_media ADD CONSTRAINT ck_store_profile_media_create_actor
  CHECK (
    (create_actor_type = 'system') = (create_actor_id IS NULL)
    AND (create_actor_type = 'system') = (create_client IS NULL)
  );
-- 补：复制来源不能是本门店
ALTER TABLE store_profile_media ADD CONSTRAINT ck_store_profile_media_copy_source
  CHECK (copied_from_store_id IS NULL OR copied_from_store_id <> store_id);
-- 同一组内同一个文件只出现一次（未移除的行）
CREATE UNIQUE INDEX uq_store_profile_media_active_file
  ON store_profile_media (store_id, media_group, file_id) WHERE removed_at IS NULL;
-- 按门店、分组、顺序读未移除的行
CREATE INDEX ix_store_profile_media_active_position
  ON store_profile_media (store_id, media_group, position) WHERE removed_at IS NULL;
-- 补：归属列、文件与创建人创建后不可改（替换文件 = 移除旧行、另起新行）
CREATE TRIGGER trg_store_profile_media_immutable BEFORE UPDATE ON store_profile_media
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'entity_id', 'store_id', 'file_id', 'copied_from_store_id', 'create_actor_type', 'create_actor_id', 'create_client');

-- store_service_item
ALTER TABLE store_service_item ADD CONSTRAINT ck_store_service_item_position
  CHECK (position >= 1);
ALTER TABLE store_service_item ADD CONSTRAINT ck_store_service_item_price_fen
  CHECK (price_fen > 0);
ALTER TABLE store_service_item ADD CONSTRAINT ck_store_service_item_original_price_fen
  CHECK (original_price_fen IS NULL OR original_price_fen >= price_fen);
-- 补：按门店、顺序读未移除的主推服务
CREATE INDEX ix_store_service_item_active_position
  ON store_service_item (store_id, position) WHERE removed_at IS NULL;
-- 补：归属列创建后不可改
CREATE TRIGGER trg_store_service_item_immutable BEFORE UPDATE ON store_service_item
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('entity_id', 'store_id');

-- qualification_submission
-- Prisma 的标量数组列建表时不带 NOT NULL，这里补上（d9:207 要求 NOT NULL 默认 '{}'；M49）
ALTER TABLE qualification_submission ALTER COLUMN changed_fields SET NOT NULL;
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_kind
  CHECK (kind IN ('initial', 'new_store', 'change'));
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_claimed_entity_type
  CHECK (claimed_entity_type IN ('enterprise', 'individual'));
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_outcome
  CHECK (outcome IN ('approved', 'rejected', 'withdrawn', 'discarded'));
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_approve_mode
  CHECK (approve_mode IN ('normal', 'corrected', 'override'));
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_system_reject_code
  CHECK (system_reject_code IN ('duplicate_entity'));
-- 变更类别只能是五个取值；不重复
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_changed_fields
  CHECK (
    changed_fields <@ ARRAY['store_name', 'address', 'industry', 'docs', 'entity_license']::text[]
    AND lyx_04_text_array_is_set(changed_fields)
  );
-- 提交标记与审批单同有同无（提交时用一条 UPDATE 写齐）
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_submitted
  CHECK ((submitted_at IS NULL) = (approval_request_id IS NULL));
-- 关闭时间与结论同有同无
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_closed
  CHECK ((closed_at IS NULL) = (outcome IS NULL));
-- 丢弃只发生在未提交的草稿上
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_discarded
  CHECK (outcome <> 'discarded' OR submitted_at IS NULL);
-- 终局驳回只出现在被驳回的 initial、new_store 轮次（结论为空时同样拦住）
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_final_rejected
  CHECK (final_rejected_at IS NULL OR (outcome IS NOT DISTINCT FROM 'rejected' AND kind <> 'change'));
-- 补：轮次号从 1 起
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_round_no
  CHECK (round_no >= 1);
-- 补：轮次号、提交人与提交时间同有同无
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_submit_fields
  CHECK (
    (submitted_at IS NULL) = (round_no IS NULL)
    AND (submitted_at IS NULL) = (submitted_by_user_id IS NULL)
  );
-- 补：已提交的轮次，送审值四项填全（d9:204-206“提交时填全”；提交的那一条 UPDATE 同时写入）
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_submitted_proposed
  CHECK (
    submitted_at IS NULL
    OR (proposed_store_name IS NOT NULL AND proposed_industry_code IS NOT NULL
        AND proposed_category_code IS NOT NULL AND proposed_address_snapshot IS NOT NULL)
  );
-- 补：已提交的 initial 轮次必有所选主体类型（通过时写 entity.entity_type，ck_entity_verified_fields 要求非空）
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_initial_entity_type
  CHECK (kind <> 'initial' OR submitted_at IS NULL OR claimed_entity_type IS NOT NULL);
-- 补：通过、驳回、撤回只发生在已提交的轮次上
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_decided_submitted
  CHECK (outcome IS NULL OR outcome = 'discarded' OR submitted_at IS NOT NULL);
-- 补：通过方式只在结论为通过时有，且通过时必有
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_approve_mode_outcome
  CHECK ((approve_mode IS NOT NULL) = (outcome IS NOT DISTINCT FROM 'approved'));
-- 补：系统驳回原因只出现在被驳回的轮次上
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_system_reject_outcome
  CHECK (system_reject_code IS NULL OR outcome IS NOT DISTINCT FROM 'rejected');
-- 补：信息确认的时间与文案版本同有同无；已提交的轮次必有信息确认
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_declaration
  CHECK (
    (declaration_confirmed_at IS NULL) = (declaration_version IS NULL)
    AND (submitted_at IS NULL OR declaration_confirmed_at IS NOT NULL)
  );
-- 补：变更类别只出现在 change 轮次
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_changed_fields_kind
  CHECK (kind = 'change' OR cardinality(changed_fields) = 0);
-- 补：上一轮不能是自己
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_resubmit_of
  CHECK (resubmit_of_qualification_submission_id IS NULL OR resubmit_of_qualification_submission_id <> id);
-- 补：三个 jsonb 列的顶层必须是对象
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_proposed_address_snapshot
  CHECK (proposed_address_snapshot IS NULL OR jsonb_typeof(proposed_address_snapshot) = 'object');
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_contact_snapshot
  CHECK (contact_snapshot IS NULL OR jsonb_typeof(contact_snapshot) = 'object');
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_check_summary
  CHECK (check_summary IS NULL OR jsonb_typeof(check_summary) = 'object');
-- 在途唯一（M12）：一家门店同时只有一轮未关闭（草稿或在审）
CREATE UNIQUE INDEX uq_qualification_submission_open
  ON qualification_submission (store_id) WHERE closed_at IS NULL;
-- 主体未认证时，同一主体同时只有一轮带主体营业执照
CREATE UNIQUE INDEX uq_qualification_submission_entity_open
  ON qualification_submission (entity_id) WHERE closed_at IS NULL AND kind = 'initial';
-- 补：归属列、轮次类型、上一轮与创建人创建后不可改
CREATE TRIGGER trg_qualification_submission_immutable BEFORE UPDATE ON qualification_submission
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'entity_id', 'store_id', 'kind', 'resubmit_of_qualification_submission_id', 'created_by_user_id');

-- qualification_doc
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_doc_type
  CHECK (doc_type IN ('business_license', 'branch_license', 'industry_permit'));
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_scope
  CHECK (scope IN ('entity', 'store'));
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_origin
  CHECK (origin IN ('uploaded', 'carried'));
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_principal_role
  CHECK (principal_role IN ('legal_rep', 'operator', 'branch_head'));
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_subject_type
  CHECK (subject_type IN ('enterprise', 'individual', 'branch', 'unknown'));
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_verdict
  CHECK (verdict IN ('accepted', 'rejected'));
-- 营业执照属主体，其余属门店
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_scope_doc_type
  CHECK ((doc_type = 'business_license') = (scope = 'entity'));
-- 行业许可证必填许可证类型，其余证照不填
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_permit_type
  CHECK ((doc_type = 'industry_permit') = (permit_type IS NOT NULL));
-- 带入的行必有来源行，新上传的行没有
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_carried
  CHECK ((origin = 'carried') = (carried_from_qualification_doc_id IS NOT NULL));
-- 被取代的行必定生效过
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_superseded
  CHECK (superseded_at IS NULL OR effective_at IS NOT NULL);
-- 补：生效的行本轮结论必为通过
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_effective_accepted
  CHECK (effective_at IS NULL OR verdict IS NOT DISTINCT FROM 'accepted');
-- 补：已移除的行不会有结论，也不会生效
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_removed
  CHECK (removed_at IS NULL OR (verdict IS NULL AND effective_at IS NULL));
-- 补：证件号的密文与脱敏串同有同无；盲索引不单独存在
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_cert_no
  CHECK (
    (cert_no_enc IS NULL) = (cert_no_mask IS NULL)
    AND (cert_no_bidx IS NULL OR cert_no_enc IS NOT NULL)
  );
-- 补：营业执照行的信用代码三件套同有同无（通过时写 entity.uscc_*，ck_entity_uscc_triple 要求三列同有同无）
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_license_bidx
  CHECK (doc_type <> 'business_license' OR (cert_no_enc IS NULL) = (cert_no_bidx IS NULL));
-- 补：盲索引是 HMAC-SHA256，32 字节（同 ck_entity_uscc_bidx_len）
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_cert_no_bidx_len
  CHECK (cert_no_bidx IS NULL OR octet_length(cert_no_bidx) = 32);
-- 补：负责人姓名的密文与脱敏串同有同无
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_principal_name
  CHECK ((principal_name_enc IS NULL) = (principal_name_mask IS NULL));
-- 补：截止日不早于起始日；营业期限为“长期”时没有截止日
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_valid_range
  CHECK (
    (valid_start_date IS NULL OR valid_end_date IS NULL OR valid_end_date >= valid_start_date)
    AND (NOT is_long_term OR valid_end_date IS NULL)
  );
-- 补：比对结论的顶层必须是数组
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_field_checks
  CHECK (jsonb_typeof(field_checks) = 'array');
-- 一轮里每种证照一行（未移除的行）
CREATE UNIQUE INDEX uq_qualification_doc_round_type
  ON qualification_doc (qualification_submission_id, doc_type, COALESCE(permit_type, ''))
  WHERE removed_at IS NULL;
-- 生效唯一：每个主体至多一张生效的营业执照
CREATE UNIQUE INDEX uq_qualification_doc_effective_entity
  ON qualification_doc (entity_id)
  WHERE scope = 'entity' AND effective_at IS NOT NULL AND superseded_at IS NULL;
-- 生效唯一：每家门店每种门店级证照至多一张生效
CREATE UNIQUE INDEX uq_qualification_doc_effective_store
  ON qualification_doc (store_id, doc_type, COALESCE(permit_type, ''))
  WHERE scope = 'store' AND effective_at IS NOT NULL AND superseded_at IS NULL;
-- 信用代码查重：按营业执照行的盲索引找其他主体的轮次（已移除的行不参与）
CREATE INDEX ix_qualification_doc_license_bidx
  ON qualification_doc (cert_no_bidx) WHERE doc_type = 'business_license' AND removed_at IS NULL;
-- 证照到期提醒：按截止日扫生效证照
CREATE INDEX ix_qualification_doc_expiring
  ON qualification_doc (valid_end_date)
  WHERE effective_at IS NOT NULL AND superseded_at IS NULL AND valid_end_date IS NOT NULL;
-- 补：归属、所属轮次、类型、文件、来源与上传人创建后不可改（重新上传 = 移除旧行、另起新行）
CREATE TRIGGER trg_qualification_doc_immutable BEFORE UPDATE ON qualification_doc
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'entity_id', 'store_id', 'qualification_submission_id', 'doc_type', 'permit_type', 'scope',
    'file_id', 'origin', 'carried_from_qualification_doc_id', 'uploaded_by_user_id');
