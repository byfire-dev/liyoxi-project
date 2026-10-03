#!/usr/bin/env python3
"""生成权限点与能力点注册表：docs/api/registry-permissions.md 与 tools/api-check/out/permissions.json。
数据依据 d4 7.1 / 5.2、裁决、约定、各文档清单；引用统计取自 routemap.json。"""
import json, os, re, collections, glob, sys
TOOL = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(TOOL, '..', '..'))
W = os.path.join(ROOT, 'docs', 'api', 'working')
OUT = os.path.join(TOOL, 'out')
os.makedirs(OUT, exist_ok=True)
OUT_MD = os.path.join(ROOT, 'docs', 'api', 'registry-permissions.md')
OUT_JSON = os.path.join(OUT, 'permissions.json')
rm = json.load(open(os.path.join(W, 'routemap.json'), encoding='utf8'))
def load_echo():
    """读各后台文档每个接口的“回显”栏：带 confirm 的记 True。"""
    secs = {}
    for f in sorted(glob.glob(os.path.join(ROOT, 'docs', 'api', 'a[0-9][0-9]-*.md'))):
        cur = None
        for l in open(f, encoding='utf8'):
            m = re.match(r'^#{3,4} [\d.a-z]+ +((?:admin|m|portal)\.[\w.]+)', l)
            if m:
                cur = m.group(1); secs[cur] = []; continue
            if re.match(r'^#{2,3} ', l):
                cur = None
            if cur:
                secs[cur].append(l)
    neg = r'不(另)?带 `confirm`|无 `confirm`|^\| 回显 \| 无'
    res = {}
    for op, ls in secs.items():
        t = ''.join(ls)
        echo = [l for l in ls if l.startswith('| 回显 |')]
        if echo:
            res[op] = ('confirm' in echo[0]) and not re.search(neg, echo[0])
        else:
            res[op] = bool(re.search(r'回显 ?`confirm`|\|\s*`confirm`\s*\|', t)) and not re.search(r'无 `confirm`', t)
    return res
ECHO = load_echo()
ALIAS = {'admin.store.reassignManager': 'admin.store.reassignDeliveryManager'}  # 路线图与文档 operationId 不同（A136）

# ---------- 1. 统计路线图引用 ----------
perm_ops = collections.defaultdict(list)
cap_ops = collections.defaultdict(list)
for e in rm:
    if e.get('permission'):
        perm_ops[e['permission']].append(e['operationId'])
    if e.get('capability'):
        cap_ops[e['capability']].append(e['operationId'])

def note_mentions(key):
    """路线图 notes 里提到该键、但路由字段不是该键的接口（处理器内判定或说明里引用）。"""
    pat = re.compile(r'(?<![\w.])' + re.escape(key) + r'(?![\w])')
    out = []
    for e in rm:
        if e.get('permission') == key or e.get('capability') == key:
            continue
        n = e.get('notes') or ''
        if pat.search(n) and not re.search(r'原路线图建议 ?' + re.escape(key), n) \
                and (e.get('permission') == 'assert-in-handler' or e.get('capability') == 'assert-in-handler'
                     or re.search(r'处理器|另需|另要', n)):
            out.append(e['operationId'])
    return out

# ---------- 2. 后台权限点 ----------
# 字段：key, name, grant, stepUp, pool, version, source；grant 里 * = 仅主管；超级管理员拥有全部
SA = '仅超级管理员'
P = []
def p(module, key, name, grant, step=None, pool='—', ver='V1.0', src='d4', note=''):
    step = step or ('待定' if ver == 'V1.1' else '否')
    P.append(dict(module=module, key=key, name=name, grant=grant, stepUp=step, pool=pool, version=ver, source=src, note=note))

M = '商家管理'
p(M, 'merchant.profile.proxy_edit', '代改门店档案', '客服、交付经理', src='d4（原型）')
p(M, 'merchant.manager.assign', '首次分配交付经理', '交付经理*', pool='`store_manager`', src='d4；A91；d3 `delivery.ticket.assign` 并入')
p(M, 'merchant.manager.transfer', '转移交付经理', '交付经理*', pool='`store_manager`', src='d4；A136')
p(M, 'merchant.qualification.review', '资质审核（通过、驳回、修正识别字段）', '客服（PRD 未指明岗位，待拍板）', src='d4')
p(M, 'merchant.qualification.override', '比对异常时放行（处理器追加判定）', SA, src='d4；a03 1.1')
p(M, 'merchant.asset.review', '素材复核（整理、确认肖像授权）', '交付经理', src='d4')
p(M, 'merchant.asset.demand.create', '发起与结束素材需求', '交付经理', src='d4')
p(M, 'merchant.asset.upload_on_behalf', '代商家上传素材与肖像授权材料', '交付经理、客服', src='A35、A129；a03')
p(M, 'merchant.user.disable', '禁用、启用商家账号', '客服*', step='要', src='d4')
p(M, 'merchant.user.force_logout', '强制商家账号下线', '客服', src='d4')
p(M, 'merchant.account_change.request', '发起账号变更（换绑手机号、老板更换、老板复核）', '客服', src='d4')
p(M, 'merchant.account_change.approve', '审批账号变更', '客服*', step='要（驳回豁免，C86）', src='d4；A127')
p(M, 'merchant.quota.override', '门店与成员上限覆盖', SA, step='要', src='d4')
p(M, 'merchant.entity.close', '后台关闭经营主体', SA, step='要', src='C66、A129；a03')
p(M, 'merchant.referral_code.manage', '渠道码登记、停用、启用', '客服*', src='C66、A129；a03')
p(M, 'pii.phone.reveal', '明文查看手机号', '客服、交付经理、财务', src='d4')
p(M, 'pii.license.view', '明文查看证照号与证照原图', '客服、交付经理、财务', src='d4')

M = '订单管理'
p(M, 'order.refund.request', '发起套餐退款、订购取消、广告取消', '客服', src='d4（D2 同名）')
p(M, 'order.payment.create_offline', '线下开单', '财务（D2 确认）', step='要', src='d4；A46')
p(M, 'billing.extension.request', '发起补偿延长有效期', '交付经理', src='d4（D1 同名）')
p(M, 'billing.extension.approve', '审批补偿延长', '交付经理*', step='否（驳回已登记 C86）', src='d4；A127')
p(M, 'billing.adjust.request', '发起积分调整', '客服、交付经理', src='d4（D1 同名）')
p(M, 'order.license_letter.manage', '授权书更正、作废并重出', '客服*', src='C66；a05')
p(M, 'order.renewal.remind', '套餐到期人工提醒', '交付经理、客服', src='a07（proto-admin-b.md:292）')
p(M, 'refund.override.request', '规则外套餐退款（发起）', SA, step='要', src='C66；a07（d2:1486）')

M = '交付管理'
p(M, 'delivery.ticket.assign_editor', '指派剪辑师', '交付经理', pool='`ticket_editor`', src='d4（D3）')
p(M, 'delivery.ticket.assign_publisher', '改派发布专员', '交付经理、发布专员*', pool='`ticket_publisher`', src='d4（D3 §28 第 8 项）')
p(M, 'delivery.ticket.rework', '工单返工', '交付经理*', src='d4 → D3 附录 A；默认取 a05')
p(M, 'delivery.plan.edit', '编辑方案', '交付经理', src='d4 `delivery.plan.*`；a05')
p(M, 'delivery.plan.push', '推送方案', '交付经理', src='d4 `delivery.plan.*`；a05')
p(M, 'delivery.plan.reschedule', '方案改期', '交付经理', src='d4 `delivery.plan.*`；a05')
p(M, 'delivery.sample.upload', '上传样片', '剪辑师（本人任务）', src='d4 `delivery.sample.*`；a05')
p(M, 'delivery.sample.qc', '样片质检', '交付经理', src='d4 `delivery.sample.*`；a05')
p(M, 'delivery.sample.push', '推送样片；登记广告版本的企业微信发送', '交付经理', src='d4 `delivery.sample.*`；A129')
p(M, 'delivery.sample.feedback_on_behalf', '代录样片意见', '交付经理', src='d4 `delivery.sample.*`；a05')
p(M, 'delivery.episode.register', '成片登记与成片批次上传', '剪辑师（本人任务）', src='d4 `delivery.episode.*`；a05')
p(M, 'delivery.episode.qc', '成片质检', '交付经理', src='d4 `delivery.episode.*`；a05')
p(M, 'delivery.ad.assign', '指派广告剪辑师', '交付经理', pool='`ad_editor`', src='d4（D3）')
p(M, 'delivery.ad.upload', '上传广告版本', '剪辑师（本人任务）', src='d4（D3）')
p(M, 'delivery.ad.return', '退回补充素材', '剪辑师、交付经理', src='d4（D3）；a05')
p(M, 'delivery.download', '员工下载成片与原片', '交付经理、剪辑师、发布专员', src='d4（D5）')
p(M, 'delivery.package.reissue', '发起、取消补发', '交付经理', src='d3 附录 A；a05')
p(M, 'production.normalize', '成片规范化重做', '交付经理', src='C66；d5:2143；a05')
p(M, 'production.restamp', '成片重打水印', '交付经理', src='C66；d5:2143；a05')
p(M, 'production.recheck', '成片重新检测', '交付经理', src='C66；a05')

M = '发布管理'
p(M, 'publish.link.verify', '链接核验（通过、驳回）', '发布专员', src='d4')
p(M, 'publish.link.verify_revoke', '撤销链接核验通过', '发布专员*、交付经理*', src='C66、A129；a06')
p(M, 'publish.account.verify', '渠道账号核验（角色队列）', '发布专员', src='d4')
p(M, 'publish.account.mark_abnormal', '标记渠道账号异常', '发布专员', src='d4')
p(M, 'publish.package.push', '推送成片包、发布补发', '发布专员、交付经理', src='d4')
p(M, 'publish.list.edit', '编辑、导入发布清单', '发布专员、交付经理', src='d4')
p(M, 'publish.patrol.do', '巡检', '发布专员', src='d4')
p(M, 'publish.takedown.check', '下架核查', '发布专员', src='d4')
p(M, 'publish.takedown.breach_notice', '违约提醒', '发布专员', src='d4')

M = '客服工单'
p(M, 'service.ticket.register', '登记工单', '客服、交付经理', src='d4（D3）')
p(M, 'service.ticket.reply', '提交处理结果；改类型与优先级、增删关联；工单附件上传', '客服、交付经理', src='d4；A92')
p(M, 'service.ticket.close', '关闭工单', '客服、交付经理', src='d4')
p(M, 'service.ticket.transfer', '负责人转出；主管可改派任意工单', '客服、交付经理', src='d4；A129 改含义')
p(M, 'service.ticket.assign', '分配无负责人的工单', '客服*', pool='`service_ticket`', src='d4；A129 改含义')

M = '短剧库管理'
p(M, 'drama.shelf', '上架与下架', '内容运营', src='d4（原型）')
p(M, 'drama.copyright.revise', '修订版权期限', '内容运营', src='A129；a04（d8:531）')
p(M, 'drama.media.manage', '原片与预告片管理', '内容运营', src='A129；a04（d5:2143）')

M = '套餐与积分'
p(M, 'billing.plan.edit', '套餐与价目修订', '内容运营', src='d4（D1）')
p(M, 'billing.pack.edit', '积分包维护', '内容运营', src='d4（D1）')
p(M, 'billing.param.edit', '计费参数变更', '内容运营', src='d4（D1）')
p(M, 'billing.price.edit', '等级模板价与单剧调价', '内容运营', src='d4（D1）')

M = '财务管理'
p(M, 'finance.refund.approve', '审批取消与退款', '财务', step='要（驳回豁免，C86）', src='d4；A127')
p(M, 'finance.refund.execute', '执行退款与退回', '财务', step='要', src='d4')
p(M, 'billing.adjust.approve', '审批积分调整', '财务', step='要（驳回豁免，C86）', src='d4；A127')
p(M, 'finance.receipt.confirm', '对公收款确认、二人复核', '财务', step='要（复核退回豁免，C86）', src='d4；A127')
p(M, 'finance.receipt.reject', '驳回对公凭证', '财务', src='d4')
p(M, 'finance.invoice.issue', '开票', '财务', src='d4')
p(M, 'finance.invoice.red', '红冲', '财务', src='d4')
p(M, 'finance.recon.resolve', '对账差异处理', '财务', step='要', src='d4；A46（数据模型 `reconcile.resolve` 改名）')
p(M, 'finance.config.propose', '提议受控财务配置', '财务', step='要', src='C66；a07（d2:1446）')
p(M, 'finance.config.approve', '审批受控财务配置', '财务', step='要（驳回豁免，C86）', src='C66；a07')
p(M, 'billing.month.close', '月结', '财务', src='d4（D1）')
p(M, 'billing.invariant.resolve', '处理资金类不变量违规', '财务', src='d4（D1）；a01')
p(M, 'pii.bank.reveal', '明文查看银行账号', '财务', src='d4')

M = '数据报表'
p(M, 'report.month_close.reissue', '月结报表重出', '财务', step='要', src='A129；a02')

M = '运营管理'
p(M, 'notify.resend', '人工重发外部通道投递', '内容运营、客服', src='C66；a09（d6:966）')
p(M, 'agreement.short_notice', '协议公告期不足时保存待生效', SA, step='要', src='C66；a09（d6:1071）')
p(M, 'docs.consent.evidence', '明文查看同意记录的手机号与信用代码', SA + '（法务取证时临时授予）', step='要', src='C66；a09')

M = '系统设置'
p(M, 'sys.staff.manage', '员工新增、编辑、启用、移交、重新生成激活码、解除锁定、设置分配池', SA, src='d4；A46 改为不要求再验证')
p(M, 'sys.staff.secure_ops', '员工禁用、重置密码、重置第二因子', SA, step='要', src='A46、A88（并入原 `sys.staff.mfa_reset`）')
p(M, 'sys.staff.wecom_bind', '员工企业微信绑定', SA, src='d4')
p(M, 'sys.session.revoke', '在线会话、强制下线', SA, src='d4')
p(M, 'sys.role.edit', '保存角色权限', SA, step='要', src='d4')
p(M, 'sys.param.edit', '系统参数', SA, src='d4')
p(M, 'sys.dict.edit', '字典', SA, src='d4')
p(M, 'flow.checklist.manage', '核对清单模板', SA, src='d4（a01 写含内容运营，见第 5 节）')
p(M, 'audit.export', '操作日志导出', SA, step='要', src='d4（原型）')
p(M, 'sys.super_admin', '只限超级管理员的操作（开关、部署核对、差异核销、场景总开关、协议升主版本、工作台视角）', SA, src='A45、A129（不设再验证）')
p(M, 'self.mfa.reset', '本人重新绑定动态口令（自助标记）', '全体员工（标记，不进角色配置）', step='要', src='A60、A88、A129')
p(M, 'flow.ops.view', '流程运维只读列表', SA, src='A129（a01、a02 共用）')
p(M, 'flow.ops.manage', '定时器重排与取消、死信重投、回调重置、手动校验', SA, src='C66；a01、a05')
p(M, 'flow.admin.transition', '人工纠偏（强制迁移）', SA, step='要', src='C66、A129；d3:3498')
p(M, 'sys.health.manage', '认领、关闭告警；处理非资金类违规', '财务*', src='A45；a01')
p(M, 'media.job.retry', '媒体任务人工重试', '内容运营', src='C66；a01')
p(M, 'files.purge.approve', '放行、驳回文件清除运行', SA, step='要（驳回豁免，C86）', src='A45、A149；a01')
p(M, 'files.restore', '恢复已清除文件', SA, src='C66；a01')
p(M, 'files.erase', '彻底删除文件（个人信息删除请求）', SA, step='要', src='A36；a01')

M = '各模块导出'
VIEW = '有该模块查看权的角色（默认开）'
for k, n, s in [('order.export', '订单管理导出', 'd4（D7 §5.6）'), ('finance.export', '财务管理导出', 'd4'),
                ('merchant.export', '商家管理导出', 'd4'), ('report.export', '数据报表导出（D1 `billing.report.export` 并入）', 'd4'),
                ('delivery.export', '交付管理导出', 'A88；a02'), ('service.export', '客服工单导出', 'A88；a02'),
                ('drama.export', '短剧库导出', 'A88；a02、a04'), ('billing.export', '套餐与积分导出', 'A88；a02')]:
    p(M, k, n, VIEW, src=s)
p(M, 'export.unmasked', '明文导出（另需原因）', '财务', step='要', src='d4（D6 §5.4）')

M = 'V1.1'
p(M, 'order.price_override.request', '改价发起', '见原型', ver='V1.1', src='d4')
p(M, 'order.price_override.approve', '改价审批', '见原型', ver='V1.1', src='d4')
p(M, 'publish.proxy', '代发布', '见原型', ver='V1.1', src='d4')
p(M, 'partner.*', '渠道管理（服务商、结算、等级）；届时拆成具体键', '见原型', ver='V1.1', src='d4；a03、a07 路线图')
p(M, 'publish.metrics.enter', '投放数据录入与审核', '发布专员', ver='V1.1', src='A129；a06')
p(M, 'service.quick_reply.manage', '快捷回复维护', '客服*', ver='V1.1', src='a08')
p(M, 'channel.export', '渠道管理导出', VIEW, ver='V1.1', src='a02')

# 按接口的回显情况（二次确认回显，C54）
ECHO_MANUAL = {
    'sys.super_admin': '部分：差异核销 `written_off` 随 `admin.paymentException.resolve` 的回显（a07 3.79）',
    'refund.override.request': '要：随 `admin.paymentOrder.refundRequest.create` 的 `{ orderNo, amountFen }`（a07 3.55）',
    'flow.ops.view': '—', 'self.mfa.reset': '否',
}

# ---------- 3. 商家端能力点 ----------
C = []
def c(key, meaning, owner, clerk, arch, src):
    C.append(dict(key=key, meaning=meaning, owner=owner, clerk=clerk, archivedOwner=arch, source=src))
Y, N = '✔', '✘'
c('catalog.read', '浏览短剧商城', Y, '✔（游客视图）', Y, 'd4')
c('store.profile.read', '看门店档案', Y, '✔（裁剪）', Y, 'd4')
c('store.profile.edit', '改门店档案', Y, N, N, 'd4')
c('store.qualification.edit', '提交、修改资质', Y, N, N, 'd4')
c('store.create', '新建门店', Y, N, N, 'd4')
c('store.archive', '停用门店', Y, N, N, 'd4')
c('store.restore', '恢复门店', Y, N, Y, 'd4')
c('asset.read', '看本店素材', Y, Y, Y, 'd4')
c('asset.demand.read', '看素材需求', Y, Y, Y, 'd4')
c('asset.upload', '上传素材', Y, Y, N, 'd4（另受门店审核状态门控）')
c('asset.feedback', '素材反馈', Y, Y, N, 'A87；m03')
c('member.list', '看成员列表', Y, '✔（裁剪）', N, 'd4')
c('member.manage', '邀请、调整、移除、撤回成员', Y, N, N, 'd4')
c('cart.*', '购物车（组键）', Y, N, N, 'd4；A128')
c('order.create', '下订购单', Y, N, N, 'd4')
c('order.read', '看订购单', Y, N, Y, 'd4')
c('plan.purchase', '购买与续费套餐', Y, N, '✔（主体级）', 'd4')
c('points.topup', '加购积分', Y, N, '✔（主体级）', 'd4')
c('wallet.read', '看积分账户', Y, N, '✔（主体级）', 'd4')
c('ledger.read', '看积分明细', Y, N, '✔（主体级）', 'd4')
c('delivery.confirm_plan', '确认方案', Y, N, N, 'd4（V1.1 可委托）')
c('delivery.confirm_sample', '确认样片', Y, N, N, 'd4（V1.1 可委托）')
c('ad.request', '申请广告、提修改', Y, N, N, 'd4（V1.1 可委托）')
c('ad.confirm', '确认广告版本', Y, N, N, 'd4（V1.1 可委托）')
c('channel.manage', '管理渠道账号', Y, N, N, 'd4')
c('publish.submit_link', '提交上线链接', Y, N, N, 'd4')
c('publish.read', '看发布任务', Y, N, Y, 'd4')
c('publish.takedown_confirm', '确认到期下架', Y, N, Y, 'd4')
c('delivery.download', '下载成片（小程序与下载页）', Y, N, Y, 'd4')
c('portal.authorize', '授权电脑下载页', Y, N, Y, 'd4')
c('contract.read', '合同页数据、协议同意计数', Y, N, '✔（主体级）', 'd4；A53')
c('invoice.*', '开票申请（组键）', Y, N, '✔（主体级）', 'd4；A128')
c('ticket.*', '客服工单（组键）', Y, N, Y, 'd4（店员默认不能，d4 §12）；A128')
c('message.read', '站内消息（门店上下文）', Y, '✔（仅“门店”类）', Y, 'd4；A139（处理器内判定）')
c('me.*', '本人资料、账号与安全、退出、注销、退出门店（组键）', Y, Y, Y, 'd4；A128')
c('todo.read', '首页待办', Y, '✔（仅素材相关）', Y, 'A87；m04')
c('support.manager.read', '服务经理名片', Y, Y, Y, 'A87、A128；m08')
c('sample.view', '下载页预览样片', Y, N, Y, 'A65、A87；p01（仅下载页会话）')
c('ad.view', '下载页预览广告', Y, N, Y, 'A65、A87；p01（仅下载页会话）')

# assert-in-handler 判定（取自 C66 与文档 / 路线图说明）
AIH_ADMIN = {
    'admin.alert.list': 'system ≥ v，或财务模块 ≥ v 且是主管（只读）',
    'admin.approval.list': '按审批类型的查看等级 + 数据范围过滤；`channel_account` 持 `publish.account.verify` 看全部',
    'admin.approval.summary': '同 `admin.approval.list`',
    'admin.approval.get': '同 `admin.approval.list`；无权 404',
    'admin.assignmentPoolMember.list': 'system ≥ v 看全部池；否则只看有读权的池（客服主管看客服池）',
    'admin.auditLog.list': '`stream = ops` 要 system ≥ v；`stream = access` 只给超级管理员',
    'admin.auditLog.get': '按该行 `stream`，同上；无权 404',
    'admin.checklistTemplate.list': '已登录读启用版本；草稿与历史版本要 `flow.checklist.manage`',
    'admin.dictItem.list': '已登录读启用项；引用计数与停用项要 system ≥ v',
    'admin.file.create': '按文件分类（a01 2.17 矩阵）：如证照代传 `merchant.profile.proxy_edit`，发票 `finance.invoice.issue` / `.red`，发布截图 `publish.takedown.check` / `publish.patrol.do` / `publish.link.verify`，工单附件 `service.ticket.reply`，预告片源 `drama.media.manage`',
    'admin.file.get': '上传人本人，或对该分类有签发读权',
    'admin.file.complete': '上传人本人',
    'admin.file.refreshCredentials': '上传人本人',
    'admin.file.cancel': '上传人本人，否则 404',
    'admin.file.downloadUrls': '按文件分类（a01 2.17“后台签发”栏）+ 数据范围；成片对 `delivery.download`；`consent_digest` 对 `docs.consent.evidence`',
    'admin.invariantViolation.list': 'system ≥ v，或 `flow.ops.view`，或财务主管只读',
    'admin.invariantViolation.resolve': '资金类要 `billing.invariant.resolve`；其余要 `flow.ops.manage` 或 `sys.health.manage`',
    'admin.outboxDelivery.list': 'system ≥ v 或 `flow.ops.view`',
    'admin.timer.list': 'system ≥ v 或 `flow.ops.view`',
    'admin.webhookEvent.list': 'system ≥ v 或 `flow.ops.view`',
    'admin.piiReveal.create': '按字段：`pii.phone.reveal`、`pii.license.view`（或 `merchant.qualification.review`）、`pii.bank.reveal`、`docs.consent.evidence`（要再验证）；限流 `admin.pii_reveal`',
    'admin.staff.list': 'system ≥ v 看完整列表；选人模式按池的读权（交付经理池对 `service.ticket.assign` / `.transfer` 只读开放）',
    'admin.staff.duty.update': '客服本人，或持 `service.ticket.assign` 的主管',
    'admin.exportJob.create': '按 `exportKey` 登记表：该模块 ≥ v 且持 `<模块>.export`；明文另要 `export.unmasked`（要再验证）；`audit_logs.list` 要 `audit.export`（要再验证）',
    'admin.exportJob.downloadUrls': '申请人本人，且仍持对应导出权限点（明文另要 `export.unmasked`）',
    'admin.accountChangeRequest.withdraw': '提交人本人；发起人已停用时由 `merchant.account_change.approve` 持有人代撤（要再验证）',
    'admin.assignmentHistory.markContacted': '该行接收人本人或其主管',
    'admin.followUp.list': '按对象所在模块查看（a03 3.41 对照表）',
    'admin.followUp.create': '对象所在模块 ≥ v 且对象在数据范围内',
    'admin.followUp.summary': '同 `admin.followUp.list`（V1.1）',
    'admin.followUp.update': '负责人本人、其主管或数据范围为全部',
    'admin.followUp.complete': '负责人本人、其主管或数据范围为全部',
    'admin.uploadBatch.create': '按用途：原片 `drama.media.manage`；成片 `delivery.episode.register` + 任务归属',
    'admin.uploadBatch.get': '批次持有人，或持该用途权限点的员工；否则 404',
    'admin.uploadBatch.cancel': '只限批次持有人（否则 404）；持有人已无该用途权限 403',
    'admin.uploadBatch.start': '同上',
    'admin.uploadBatch.refreshCredentials': '同上',
    'admin.uploadBatchItem.update': '同上',
    'admin.uploadBatchItem.complete': '同上',
    'admin.ad.remind': '广告在数据范围内，且是该广告剪辑师、门店交付经理或交付模块主管',
    'admin.deliveryTicket.remind': '工单在数据范围内，且是本单交付经理、发布专员（`golive`）或交付模块主管',
    'admin.cancelRequest.withdraw': '提交人本人；发起人已停用或对象失效时由 `finance.refund.approve` 持有人代撤（要再验证）',
    'admin.financeConfigRevision.withdraw': '提议人本人；代撤要 `finance.config.approve`（要再验证）',
    'admin.pointAdjustmentRequest.withdraw': '提交人本人；代撤要 `billing.adjust.approve`（要再验证）',
    'admin.refundRequest.withdraw': '申请人本人；代撤要 `finance.refund.approve`（要再验证）',
    'admin.termExtensionRequest.withdraw': '提交人本人；代撤要 `billing.extension.approve`',
    'admin.plan.quote': 'billing 或 order 任一 ≥ v；带 `pointAccountId` 时套数据范围',
    'admin.pointAdjustmentRequest.get': 'billing 或 finance 任一 ≥ v + 数据范围（发起人总能看）',
    'admin.refundRequest.get': 'finance 或 order 任一 ≥ v + 数据范围（发起人总能看）',
    'admin.termExtensionRequest.get': 'order 或 billing 任一 ≥ v + 数据范围（发起人总能看）',
    'admin.transferProof.get': 'order 或 finance 任一 ≥ v',
    'admin.pricingChange.create': '按变更内容：模板价要 `billing.price.edit`，计费参数要 `billing.param.edit`',
    'admin.agreementVersion.schedule': 'ops = e；会员协议、积分规则公告期不足另要 `agreement.short_notice`',
    'admin.agreement.agreementVersion.create': 'ops = e；`bumpMajor = true` 另要 `sys.super_admin`',
    'admin.notificationDelivery.list': 'ops 或 service 任一 ≥ v',
    'admin.siteNotice.list': 'ops 或 billing 任一 ≥ v',
}
AIH_M = {
    'm.playable.get': '按资产种类：预告片匿名可看；广告要 `ad.request`、样片要 `delivery.confirm_sample`（仅老板，版本已推送且查看方式含 weapp）；匿名 401、非成员 403 `NOT_A_MEMBER`、店员 403 `ROLE_FORBIDDEN`（A87）',
    'm.file.create': '按上传分类判权（A139；m08 3.21 分类表）：档案图片与视频 `store.profile.edit`；证照 `store.qualification.edit`；素材与肖像授权 `asset.upload`（店员可）；渠道截图 `channel.manage`；工单附件 `ticket.*`、`delivery.confirm_sample`、`ad.confirm` 任一；对公回单 `plan.purchase` 或 `points.topup`',
    'm.message.list': '带 `X-Store-Id` 时校验成员关系与 `message.read`；不带只看账号级消息（A139）',
    'm.message.summary': '同 `m.message.list`',
    'm.message.read': '同 `m.message.list`',
    'm.message.batchRead': '同 `m.message.list`',
}

# C86 登记表（原样）
conv = open(os.path.join(ROOT, 'docs', 'api', '00-conventions.md'), encoding='utf8').read()
m86 = re.search(r'\*\*C86 驳回的再验证豁免.*?\n\n(\| operationId \|.*?)\n\n(不登记的：.*?)\n', conv, re.S)
C86_TABLE, C86_TAIL = m86.group(1), m86.group(2)

# ---------- 4. 组装 ----------
def fmt_ops(ops, n=4):
    ops = list(dict.fromkeys(ops))
    if not ops:
        return '—'
    s = '、'.join(f'`{o}`' for o in ops[:n])
    return s + (f' 等 {len(ops)} 条' if len(ops) > n else '')

def echo_of(key, ops):
    if key in ECHO_MANUAL:
        return ECHO_MANUAL[key]
    known = [o for o in ops if ALIAS.get(o, o) in ECHO]
    if not known:
        return '—'
    yes = [o for o in known if ECHO[ALIAS.get(o, o)]]
    if not yes:
        return '否'
    if len(yes) == len(known):
        return '要'
    return '部分：' + '、'.join(f'`{o}`' for o in yes)

reg_keys = {x['key'] for x in P}
cap_keys = {x['key'] for x in C}
for x in P:
    x['ops'] = perm_ops.get(x['key'], [])
    x['handlerOps'] = note_mentions(x['key'])
    x['confirm'] = echo_of(x['key'], x['ops'])
for x in C:
    x['ops'] = cap_ops.get(x['key'], [])
    x['handlerOps'] = note_mentions(x['key']) if x['key'] not in ('me.*',) else []

# 导出键：都经 admin.exportJob.create / downloadUrls 在处理器内按 exportKey 判定（a02 2.14）
EXPORT_KEYS = {
    'order.export': 'orders.list、payment_orders.list、subscription_terms.list',
    'finance.export': 'payment_transactions.list、reconciliations.detail',
    'merchant.export': 'stores.list', 'report.export': 'report.overview、report.points（V1.1 另 5 个报表）',
    'delivery.export': 'delivery_tickets.list', 'service.export': 'service_tickets.list',
    'drama.export': 'dramas.list', 'billing.export': 'point_accounts.list', 'audit.export': 'audit_logs.list',
    'export.unmasked': '任一导出键的 isMasked = false', 'channel.export': 'partners.list、commission_statements.list（V1.1）',
}
for x in P:
    if x['key'] in EXPORT_KEYS:
        x['handlerOps'] = ['admin.exportJob.create', 'admin.exportJob.downloadUrls']
        x['exportKeys'] = EXPORT_KEYS[x['key']]
        x['confirm'] = '否'

# ---------- 5. 不一致与待定 ----------
issues = []
def issue(kind, key, desc, sug):
    issues.append(dict(kind=kind, key=key, desc=desc, suggestion=sug))

for k in sorted(perm_ops):
    if k not in reg_keys and k != 'assert-in-handler':
        issue('路线图有、注册表无', k, f'后台权限点被 {len(perm_ops[k])} 条接口引用：{fmt_ops(perm_ops[k])}', '补进注册表或改路线图')
for k in sorted(cap_ops):
    if k not in cap_keys and k != 'assert-in-handler':
        issue('路线图有、注册表无', k, f'能力点被 {len(cap_ops[k])} 条接口引用：{fmt_ops(cap_ops[k])}', '补进注册表或改路线图')

V11 = {x['key'] for x in P if x['version'] == 'V1.1'}
for x in P:
    if x['key'] in V11:
        continue
    if not x['ops']:
        via = x['handlerOps']
        if via:
            issue('注册表有、路由字段未引用', x['key'], f'只在处理器内判定中用到：{fmt_ops(via, 3)}', '保留；契约测试按 C66 核对处理器判定规则里出现的键')
        else:
            issue('注册表有、没有接口用', x['key'], '路线图与说明都未引用', None)
for x in C:
    if not x['ops']:
        via = x['handlerOps']
        if via:
            issue('注册表有、路由字段未引用', x['key'], f'只在处理器内判定中用到：{fmt_ops(via, 3)}', '保留')
        else:
            issue('注册表有、没有接口用', x['key'], '路线图与说明都未引用', None)

# 店员列与路线图 clerkView 的一致性
for x in C:
    cvs = collections.Counter(e.get('clerkView') for e in rm if e.get('capability') == x['key'])
    clerk_yes = x['clerk'] != N
    bad = [v for v in cvs if v is not None and ((v == 'none') == clerk_yes)]
    if bad:
        issue('店员列与 clerkView 不符', x['key'], f'注册表店员列 {x["clerk"]}，路线图 clerkView {dict(cvs)}', '以注册表为准改路线图，或改注册表')

# 人工核对出的不一致与待定
issue('注册表有、没有接口用', 'billing.month.close',
      'd4 财务行登记了“月结”，路线图没有接口用它；月结由定时任务做，重出用 `report.month_close.reissue`（a02）',
      '从注册表删去，或并入 `report.month_close.reissue`；d4 不回改（A129），在本表标“作废”即可')
issue('默认授予不一', 'flow.checklist.manage', 'd4：仅超级管理员；a01 1.1：超级管理员、内容运营',
      '取 d4（仅超级管理员）；若要内容运营维护清单，由业务拍板后改本表')
issue('默认授予不一', 'order.refund.request', 'd4：客服；D3 草案允许交付经理发起广告取消（a05 第 6 节第 9 项）',
      '维持客服；交付经理要发起广告取消时由业务拍板，再给交付经理默认开')
issue('默认授予不一', 'delivery.ticket.rework', 'd4 只写“见 D3 附录 A”，D3 附录 A 没有默认值；a05 写交付经理（仅主管）',
      '取 a05：交付经理*')
issue('默认授予不一', 'delivery.ticket.assign_publisher', 'd4 写“交付经理、发布专员*”；a05 写“交付经理、发布专员（仅主管）”，“仅主管”是否也限交付经理有歧义',
      '定为：交付经理不限主管，发布专员仅主管（同 d4 写法）；a05 1.2 措辞按此改')
issue('待拍板', 'merchant.qualification.review', 'd4 默认客服，注明“PRD 未指明岗位，待拍板”',
      '先按客服落库，业务拍板后只改本表默认值')
issue('待拍板', 'order.payment.create_offline', 'd4 默认财务，注明“默认值由 D2 确认”；D2 未见明确结论',
      '先按财务落库，待财务确认')
issue('回显说法不一', 'drama.copyright.revise', 'a04 2.1 写本文权限点（含 `billing.price.edit`）“都不要求二次确认回显”；但 a04 的版权期限修订（`confirm.prevEndDate`）与单剧调价（`confirm.currentPoints`）都要求 `confirm`',
      '以接口为准（要回显）；改 a04 2.1 的说法')
if any('不登记' in str(x.get('note', '')) and x.get('key') == 'files.purge.approve' for x in json.load(open(os.path.join(W, 'frag', 'a01-system.json'), encoding='utf8')).get('permissionSupplements', []) if isinstance(x, dict)):
    issue('清单说明过期', 'files.purge.approve', 'a01 清单 `permissionSupplements` 的备注写“驳回不登记 C86”；A149 已把 `admin.purgeRun.reject` 登记进 C86',
          '删去 a01 清单该备注')
issue('规则例外', 'flow.ops.view', '查看类键，与“查看类不设权限点”（d4 7.1 第 2 条）相抵；A129 已采纳',
      '保留为登记的例外：只在处理器内与模块等级“或”判定；不再新增同类键')
issue('命名', 'refund.override.request', '领域段 `refund` 不是服务模块名（d4 7.1 第 1 条要求取拥有该动作的服务模块）',
      '建议改名 `order.refund.override_request`（与 `order.refund.request` 同组）；改名前不阻塞')
issue('d3 旧键未登记', 'delivery.sample.download_watermarked', 'd3 附录 A 列了“下载水印版（用于企业微信发送）”，d4 与路线图都没有；水印版签发现走样片推送与 `admin.file.downloadUrls`',
      '不登记；在 d3 待回写清单里注明由 `delivery.sample.push` / `delivery.download` 覆盖')
issue('能力点待定', '（V1.1 占位）', '商家端 V1.1 占位接口没有能力点：`m.delegation.create`、`m.cancelRequest.create`、`m.favorite.create`、`m.favorite.delete`、`m.performanceReport.list`、`m.performanceUpload.create`、`m.faq.list`、`m.siteNotice.list`',
      'V1.1 设计时补键；V1.0 不挂载，不阻塞')
if any(e['operationId'] == 'admin.store.reassignManager' for e in rm):
    issue('operationId 不一', 'merchant.manager.transfer', '路线图写 `admin.store.reassignManager`，a03 已按 A136 改名 `admin.store.reassignDeliveryManager`',
          '路线图按 A136 改名（不影响权限点）')

# ---------- 6. 核对：路线图出现的键都在册 ----------
missing_p = sorted(k for k in perm_ops if k != 'assert-in-handler' and k not in reg_keys)
missing_c = sorted(k for k in cap_ops if k != 'assert-in-handler' and k not in cap_keys)
CHECK_TEXT = '全部在本表' if not (missing_p or missing_c) else '本表缺 ' + str(len(missing_p) + len(missing_c)) + ' 个：' + '、'.join(missing_p + missing_c)
aih_admin = [e['operationId'] for e in rm if e.get('permission') == 'assert-in-handler']
aih_m = [e['operationId'] for e in rm if e.get('capability') == 'assert-in-handler']
miss_aih = [o for o in aih_admin if o not in AIH_ADMIN] + [o for o in aih_m if o not in AIH_M]

# ---------- 7. 渲染 ----------
def esc(s):
    return str(s).replace('|', '\\|')

def ops_cell(x):
    if x['ops']:
        s = fmt_ops(x['ops'])
        extra = [o for o in x['handlerOps'] if o not in x['ops']]
        if extra and x['key'] not in EXPORT_KEYS:
            s += '；处理器内另见 ' + fmt_ops(extra, 2)
        return s
    if x.get('exportKeys'):
        return f'处理器内：`admin.exportJob.create`、`admin.exportJob.downloadUrls`（{"" if x["exportKeys"].startswith("任一") else "导出键 "}{x["exportKeys"]}）'
    if x['handlerOps']:
        return '处理器内：' + fmt_ops(x['handlerOps'], 3)
    return '—'

v10 = [x for x in P if x['version'] == 'V1.0']
v11 = [x for x in P if x['version'] == 'V1.1']
modules = list(dict.fromkeys(x['module'] for x in v10))
L = ['# 权限点与能力点注册表', '']
L += ['| 项 | 内容 |', '| --- | --- |',
      '| 状态 | 评审稿（2026-10-03）；接口契约的唯一来源 |',
      '| 依据 | d4-identity.md 第 7.1 节（后台权限点）、第 5.2 节（商家能力点）；裁决 A13、A15、A36、A45、A46、A53、A60、A65、A87、A88、A92、A127、A128、A129、A136、A139、A140、A149；约定 C54、C56、C66、C67、C86；各文档第 1 节与清单 |',
      '| 生成方式 | 脚本 `tools/api-check/gen_permissions.py` 读路线图（`routemap.json`）统计每个键被哪些接口引用，读各文档“回显”栏算二次确认回显；键的默认值由汇总人按上述依据统一 |',
      f'| 核对 | 路线图引用的后台权限点 {len([k for k in perm_ops if k != "assert-in-handler"])} 个、能力点 {len([k for k in cap_ops if k != "assert-in-handler"])} 个，{CHECK_TEXT} |', '']
L += ['说明：',
      '- **本表是唯一来源**。代码落在 `packages/contract/src/permissions.ts`（后台）与 `packages/contract/src/authz/merchant-caps.ts`（商家端）。路由只能引用表里的键，写错编译不过（d4 7.1 第 3 条）。d4 附录的旧表不再回改（A129）；d4 里作废的旧名不列。',
      '- **查看类不设权限点**，由模块等级表达（`need: view`）。例外只有 `flow.ops.view`（A129，见第 5 节）。',
      '- **再验证**以本表为准，接口不另声明（A13）。窗口 10 分钟，超出 403 `STEP_UP_REQUIRED`。唯一例外是第 4 节登记的驳回接口（`x-step-up: skip`）。处理器内取到的键若标了再验证，处理器同样校验。商家端 V1.0 没有再验证。',
      '- **默认授予**：`*` = 仅主管；超级管理员拥有全部，不逐行写。“仅超级管理员”表示其他角色默认都不开。',
      '- **待分配池**：持有该键且是主管的员工，能看到负责人为空的对应资源（d4 7.3）。',
      '- **二次确认回显**（C54）：按各文档接口的“回显”栏统计。“要”= 用到该键的接口都带 `confirm`；“部分”列出带的接口；“—”= 只在处理器内用到，回显随所在接口。',
      '- **`assert-in-handler`**：权限取决于对象或请求体的接口，路由声明这个值，判定规则见第 3 节（A45、A87）。', '']

L += [f'## 1. 后台权限点（V1.0，{len(v10)} 个）', '']
COLS = '| 键 | 名称 | 默认授予 | 再验证 | 待分配池 | 二次确认回显 | 起始版本 | 用到的接口 | 来源 |'
SEP = '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
for i, mod in enumerate(modules, 1):
    rows = [x for x in v10 if x['module'] == mod]
    L += [f'### 1.{i} {mod}（{len(rows)} 个）', '', COLS, SEP]
    for x in rows:
        L.append(f'| `{x["key"]}` | {esc(x["name"])} | {esc(x["grant"])} | {x["stepUp"]} | {x["pool"]} | {esc(x["confirm"])} | {x["version"]} | {ops_cell(x)} | {esc(x["source"])} |')
    L.append('')
L += [f'### 1.{len(modules) + 1} V1.1 的键（{len(v11)} 个，V1.0 不挂载）', '', COLS, SEP]
for x in v11:
    L.append(f'| `{x["key"]}` | {esc(x["name"])} | {esc(x["grant"])} | {x["stepUp"]} | {x["pool"]} | — | {x["version"]} | {ops_cell(x)} | {esc(x["source"])} |')
L += ['', 'd4 已作废、本表不列的：`sys.staff.mfa_reset`（并入 `sys.staff.secure_ops`，A88、A129），以及 d4 7.1 “来源与作废的旧名”一列里的全部旧名。', '']

L += [f'## 2. 商家端能力点（{len(C)} 个）', '',
      '能力点只回答“这个角色在这种门店状态下能不能做这类事”；门店是否认证、套餐是否生效等业务状态由各业务服务判断（d4 5.2）。`me.*`、`cart.*`、`invoice.*`、`ticket.*` 是**单个组键**，不是通配符（A128）。店员列为“✘”的路由 `clerkView = none`，直接 403 `ROLE_FORBIDDEN`。', '',
      '| 键 | 含义 | 老板 | 店员 | 已停用门店的老板 | 用到的接口 | 来源 |', '| --- | --- | --- | --- | --- | --- | --- |']
for x in C:
    L.append(f'| `{x["key"]}` | {esc(x["meaning"])} | {x["owner"]} | {x["clerk"]} | {x["archivedOwner"]} | {ops_cell(x)} | {esc(x["source"])} |')
L += ['', '下载页（`portal`）会话代表授权它的老板：`delivery.download`、`sample.view`、`ad.view` 在下载页按老板判定（C5）。', '']

L += ['## 3. 处理器内判定（`assert-in-handler`）', '',
      '路由声明 `assert-in-handler`，处理器取到对象或读到请求体后再判。契约自测允许这个值，但要求接口文档写出判定规则（C66）。另有“路由声明固定键、处理器再追加键”的写法（如资质审核 `mode = override` 另要 `merchant.qualification.override`，退款申请 `ruleCode = override` 另要 `refund.override.request`），不在下表。', '',
      f'### 3.1 后台（{len(aih_admin)} 条）', '', '| operationId | 文档 | 判定 |', '| --- | --- | --- |']
docof = {e['operationId']: e['doc'] for e in rm}
for o in aih_admin:
    L.append(f'| `{o}` | {docof[o]} | {esc(AIH_ADMIN.get(o, "（未登记）"))} |')
L += ['', f'### 3.2 商家端（{len(aih_m)} 条）', '', '| operationId | 文档 | 判定 |', '| --- | --- | --- |']
for o in aih_m:
    L.append(f'| `{o}` | {docof[o]} | {esc(AIH_M.get(o, "（未登记）"))} |')
L += ['']

L += ['## 4. 驳回豁免再验证的接口（约定 C86 登记表，原样引用）', '', C86_TABLE, '', C86_TAIL, '']

seen = {}
for i in issues:
    seen[(i['kind'], i['key'])] = i  # 人工条目覆盖同键的自动条目
issues = list(seen.values())
counted = [i for i in issues if i['kind'] != '注册表有、路由字段未引用']
info = [i for i in issues if i['kind'] == '注册表有、路由字段未引用']
L += [f'## 5. 不一致与待定（{len(counted)} 条）', '']
L += [f'- 路线图引用了、本表没有的键：{len(missing_p) + len(missing_c)} 个。']
L += ['', '| # | 类别 | 键 | 情况 | 建议 |', '| --- | --- | --- | --- | --- |']
for n, i in enumerate(counted, 1):
    L.append(f'| {n} | {i["kind"]} | `{i["key"]}` | {esc(i["desc"])} | {esc(i["suggestion"] or "")} |' if not i['key'].startswith('（') else
             f'| {n} | {i["kind"]} | {i["key"]} | {esc(i["desc"])} | {esc(i["suggestion"] or "")} |')
L += ['', f'只在处理器内用到、路由字段不直接引用的键（{len(info)} 个，属正常，不计入上表）：' +
      '、'.join(f'`{i["key"]}`' for i in info) + '。契约测试按 C66 核对它们出现在处理器判定规则里。', '']
L += ['## 6. 修订记录', '', '| 日期 | 内容 |', '| --- | --- |',
      f'| 2026-10-03 | 初稿：后台权限点 {len(P)} 个（V1.0 {len(v10)}、V1.1 {len(v11)}），能力点 {len(C)} 个；由 d4 7.1、5.2 与各文档增补汇总 |', '']
open(OUT_MD, 'w', encoding='utf8').write('\n'.join(L))

out = dict(generatedAt='2026-10-03', permissions=P, capabilities=C,
           assertInHandler=dict(admin={o: AIH_ADMIN.get(o) for o in aih_admin}, merchant={o: AIH_M.get(o) for o in aih_m}),
           stepUpSkip=[r.split('|')[1].strip().strip('`') for r in C86_TABLE.split('\n')[2:]],
           issues=counted, handlerOnlyKeys=[i['key'] for i in info],
           check=dict(missingPermissions=missing_p, missingCapabilities=missing_c, unregisteredAssertInHandler=miss_aih))
json.dump(out, open(OUT_JSON, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
print(f'permissions={len(P)} (V1.0 {len(v10)}, V1.1 {len(v11)}) capabilities={len(C)} issues={len(counted)} handlerOnly={len(info)}')
print('missing', missing_p, missing_c, 'aih-unregistered', miss_aih)
if missing_p or missing_c or miss_aih:
    sys.exit(2)
