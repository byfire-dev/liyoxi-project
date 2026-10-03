-- 分组 12-support：客服工单（support 模块）的手写约束。
-- 依据：docs/appendix/design/d3-flow.md 第 18 节；docs/data-model/12-support.md。
-- 只含 Prisma 表达不了的约束：CHECK、数组列的 NOT NULL、部分索引与部分唯一索引、触发器。
-- 建表、普通索引、全部外键（含门店归属复合外键、条目指向工单的三列复合外键）由 Prisma 片段生成（M46、M47）。
-- 触发器函数只用公共文件 00-common.sql 里的（M50），本分组不定义函数。

-- service_ticket
-- Prisma 的标量数组列建表时不带 NOT NULL。
ALTER TABLE service_ticket ALTER COLUMN image_file_ids SET NOT NULL;
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_source
  CHECK (source IN ('weapp','online_chat','phone'));
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_priority
  CHECK (priority IN ('high','mid','low'));
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_status
  CHECK (status IN ('pending','processing','awaiting_confirm','resolved','closed'));
-- 关闭原因是系统枚举（M55：状态机依赖 withdrawn）。
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_close_reason
  CHECK (close_reason IN ('duplicate','invalid','withdrawn'));
-- 撤回原因是字典 ticket_withdraw_reason 的编码，不逐值校验（M55：不参与逻辑的保持为字典）。
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_withdraw_reason_code
  CHECK (withdraw_reason_code <> '');
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_resolved_via
  CHECK (resolved_via IN ('merchant','auto'));
-- 小程序提交：有提交人、没有登记人；后台登记：有登记人，提交人可空。
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_creator
  CHECK ((source = 'weapp') = (registered_by_staff_id IS NULL)
         AND (source <> 'weapp' OR submitter_user_id IS NOT NULL));
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_type_code
  CHECK (type_code <> '');
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_description
  CHECK (btrim(description) <> '');
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_image_file_ids
  CHECK (cardinality(image_file_ids) <= 9);
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_contact_phone
  CHECK ((contact_phone_enc IS NULL) = (contact_phone_mask IS NULL));
-- 待受理只出现在小程序提交的工单上，且此时还没有首次回复。
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_pending
  CHECK (status <> 'pending' OR (source = 'weapp' AND first_response_at IS NULL));
-- 响应截止时间只在待受理、处理中期间有值（回复后、结束后清空）。
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_response_due
  CHECK (response_due_at IS NULL OR status IN ('pending','processing'));
-- 提交处理结果即视为给出方案：进入待商家确认、已解决时必有方案时间。
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_solution
  CHECK (status NOT IN ('awaiting_confirm','resolved') OR solution_at IS NOT NULL);
-- 自动解决时间只在待商家确认期间有值，且晚于进入待确认的时间。
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_awaiting
  CHECK ((status = 'awaiting_confirm') = (auto_resolve_at IS NOT NULL)
         AND (status <> 'awaiting_confirm' OR awaiting_confirm_at IS NOT NULL)
         AND (auto_resolve_at IS NULL OR awaiting_confirm_at IS NULL OR auto_resolve_at > awaiting_confirm_at));
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_resolved
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)
         AND (resolved_at IS NULL) = (resolved_via IS NULL));
-- 关闭：时间与原因同有同无；撤回原因只在商家撤回时有；关闭时“关闭说明”与“撤回原因”至少有一个。
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_closed
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)
         AND (closed_at IS NULL) = (close_reason IS NULL)
         AND (withdraw_reason_code IS NULL OR (close_reason IS NOT NULL AND close_reason = 'withdrawn'))
         AND (close_note IS NULL OR (closed_at IS NOT NULL AND btrim(close_note) <> ''))
         AND (closed_at IS NULL OR close_note IS NOT NULL OR withdraw_reason_code IS NOT NULL));
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_reopened_count
  CHECK (reopened_count >= 0);
-- 有截止时间时，快照里必有对应的一段，且这一段是对象（JSON null 不算）；方案时限必有，solution 段恒在。
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_sla_snapshot
  CHECK (jsonb_typeof(sla_snapshot) = 'object'
         AND jsonb_typeof(sla_snapshot -> 'solution') = 'object'
         AND (response_due_at IS NULL OR jsonb_typeof(sla_snapshot -> 'response') = 'object')
         AND (auto_resolve_at IS NULL OR jsonb_typeof(sla_snapshot -> 'autoResolve') = 'object'));
-- 工单池“仅看响应超时”、工作台“响应超时数”、timers.I7 的检查项：只索引还在等待响应的工单。
CREATE INDEX ix_service_ticket_response_due_at ON service_ticket (response_due_at)
  WHERE response_due_at IS NOT NULL;
-- 没有负责人的未结工单（没有当班客服时留空），进入客服主管待办，可“分配”。
CREATE INDEX ix_service_ticket_unassigned ON service_ticket (created_at)
  WHERE owner_staff_id IS NULL AND status IN ('pending','processing','awaiting_confirm');
-- 归属、单号、来源、提交人与提交内容不可改。
CREATE TRIGGER trg_service_ticket_immutable
  BEFORE UPDATE OF ticket_no, entity_id, store_id, source, submitter_user_id, registered_by_staff_id,
                   description, image_file_ids, created_at
  ON service_ticket
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'ticket_no', 'entity_id', 'store_id', 'source', 'submitter_user_id', 'registered_by_staff_id',
    'description', 'image_file_ids', 'created_at');

-- service_ticket_entry
ALTER TABLE service_ticket_entry ALTER COLUMN image_file_ids SET NOT NULL;
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_kind
  CHECK (kind IN ('merchant_message','staff_reply','internal_note','system_event'));
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_tag
  CHECK (tag IN ('submit','supplement','reopen','reply','solution','result','transfer','status','biz_event'));
-- 标签按条目类型取值；回复与系统事件必有标签。
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_kind_tag
  CHECK (CASE kind
           WHEN 'merchant_message' THEN tag IS NULL OR tag IN ('submit','supplement','reopen')
           WHEN 'staff_reply'      THEN tag IS NOT NULL AND tag IN ('reply','solution','result')
           WHEN 'internal_note'    THEN tag IS NULL OR tag = 'transfer'
           WHEN 'system_event'     THEN tag IS NOT NULL AND tag IN ('transfer','status','biz_event')
           ELSE false
         END);
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_actor_type
  CHECK (actor_type IN ('merchant','staff','system','partner'));
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_client
  CHECK (client IN ('weapp','portal','admin'));
-- 系统动作没有操作人 id 与客户端；其余操作人两列都必填（M44）。
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_actor
  CHECK ((actor_type = 'system') = (actor_id IS NULL)
         AND (actor_type = 'system') = (client IS NULL));
-- 商家消息由商家写（后台登记时的提交条目由登记人代录）；回复与内部备注由员工写；关联业务事件由系统写。
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_kind_actor
  CHECK (CASE kind
           WHEN 'merchant_message' THEN actor_type = 'merchant'
                                        OR (actor_type = 'staff' AND tag IS NOT NULL AND tag = 'submit')
           WHEN 'staff_reply'      THEN actor_type = 'staff'
           WHEN 'internal_note'    THEN actor_type = 'staff'
           ELSE tag IS DISTINCT FROM 'biz_event' OR actor_type = 'system'
         END);
-- 内部备注商家不可见；商家消息与回复商家可见；系统事件逐条决定。
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_visible
  CHECK (CASE kind
           WHEN 'internal_note' THEN NOT is_visible_to_merchant
           WHEN 'system_event'  THEN true
           ELSE is_visible_to_merchant
         END);
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_body
  CHECK (body IS NULL OR btrim(body) <> '');
-- 系统事件必有正文、不带图片；其余条目正文与图片至少有一样。
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_content
  CHECK (CASE WHEN kind = 'system_event'
              THEN body IS NOT NULL AND cardinality(image_file_ids) = 0
              ELSE body IS NOT NULL OR cardinality(image_file_ids) > 0
         END);
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_image_file_ids
  CHECK (cardinality(image_file_ids) <= 9);
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_merchant_body
  CHECK (merchant_body IS NULL
         OR (kind = 'system_event' AND is_visible_to_merchant AND btrim(merchant_body) <> ''));
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_solution
  CHECK (is_solution = (kind = 'staff_reply' AND tag IS NOT NULL AND tag IN ('solution','result')));
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_link
  CHECK (link IS NULL OR (jsonb_typeof(link) = 'object' AND link ? 'route'));
-- 来源出站事件：关联业务事件条目必有，其余条目没有。
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_outbox_event
  CHECK ((outbox_event_id IS NOT NULL) = (tag IS NOT NULL AND tag = 'biz_event'));
-- 同一事件在同一张工单上只写一条（重复投递、一个事件命中同一工单的多条关联行时都靠它兜底）。
CREATE UNIQUE INDEX uq_service_ticket_entry_outbox_event_id ON service_ticket_entry (service_ticket_id, outbox_event_id)
  WHERE outbox_event_id IS NOT NULL;
-- 条目写入后不改（没有编辑、撤回消息的功能）。
CREATE TRIGGER trg_service_ticket_entry_no_update
  BEFORE UPDATE ON service_ticket_entry
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_update();

-- service_ticket_ref
ALTER TABLE service_ticket_ref ADD CONSTRAINT ck_service_ticket_ref_ref_type
  CHECK (ref_type IN ('drama_order','billing_order','delivery_ticket','ad','approval_request'));
-- 关联行只增删，不改；关联错的行允许物理删除（M95），所以不拦 DELETE。
-- 增删的状态守卫与“审批单关联不可删”在应用层判断（12-support.md 2.3；A92），库里不拦。
CREATE TRIGGER trg_service_ticket_ref_no_update
  BEFORE UPDATE ON service_ticket_ref
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_update();
