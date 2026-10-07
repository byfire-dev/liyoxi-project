#!/usr/bin/env node
// W1-21：计划 §7.3 逐行登记，不把未来页面或未来功能冒充 M1 已实现。
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { cells, LEDGERS, readLedger, SKIPPED } from "./plan-ledger-lib.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const normalize = (text) => text.trim().replace(/\s+/g, " ");
const digestOf = (row) =>
  createHash("sha256")
    .update(JSON.stringify(row.map(normalize)))
    .digest("hex");
// 摘要绑定全部三列；计划内容或回补点变化时映射必须同步。每个目标是确切文件+回补里程碑。
// pages 类型只用于两行既有未来整页登记；不替代现有页面内部的功能桩（W1-19 三项已补记）。
export const STUB_MAP = [
  {
    row: "微信登录、手机号组件、短信",
    digest: "ba2a4dbd5218579d0b3f541618921d7fec55fc373b0db2f011e1d22b16ef7bd5",
    files: [
      ["m2-identity-login-wechat-fake.md", "M2"],
      ["m2-staff-activation-sms.md", "M2"],
    ],
  },
  {
    row: "后台配置页、建剧与定价页、协议正文",
    digest: "45b8ba840c3f3a8165ee2eb6bf6887188cb3183f74dd7331897389e5d71d371e",
    files: [
      ["m2-docs-agreement-placeholder-text.md", "M2"],
      ["m4-billing-finance-config-ui.md", "M4"],
    ],
    pages: [
      ["/sys/params", "M2", "参数配置"],
      ["/dramas", "M3", "短剧列表"],
      ["/dramas/$id", "M3", "编辑短剧"],
      ["/billing/pricing", "M3", "单剧积分价"],
      ["/billing/plans", "M4", "套餐管理"],
      ["/billing/params", "M4", "积分价模板与参数"],
    ],
  },
  {
    row: "通知",
    digest: "1e0d1a2a7bcd84e665beacd6e65ff16310aec711b7baee179eb972042636e484",
    files: [
      ["m2-billing-notification-scenes.md", "M2"],
      ["m2-delivery-notification-scenes.md", "M2"],
      ["m2-publish-notification-scenes.md", "M2"],
    ],
  },
  {
    row: "对象存储、分块上传、媒体侧的体检任务（probe、restamp）、AI 标识",
    digest: "924990ee1f10cfc3cdbfc9f5d9cd08c21ed88099da82799b23dd5b5d525f835d",
    files: [["m3-media-storage.md", "M3"]],
  },
  {
    row: "制作留痕的入库体检流水线（体检、AI 标识状态）与交付侧的接入（样片、成片）",
    digest: "638b1c65b495340717e8fa25920d6ca15590fe8b1e72469b3f12921db923c1da",
    files: [["m3-delivery-media-production-sync.md", "M3"]],
  },
  {
    row: "建档首页的三个聚合项（`m.storeProfile.get` 的成员摘要、素材总数、广告三态计数）",
    digest: "1ab0021135f067c8e2a3894f35158f0c4177299e6a0e9f7b373427be8e30a03e",
    files: [
      ["m2-profile-overview-members.md", "M2"],
      ["m3-profile-overview-assets.md", "M3"],
      ["m5-profile-overview-ads.md", "M5"],
    ],
  },
  {
    row: "交付经理按城市轮询分配",
    digest: "3eea500c0e478b61625bd1cb0bc8dd6aba2e3f8c5b4d2bb8048a27b4b8e98185",
    files: [["m2-staff-assignment-pool.md", "M2"]],
  },
  {
    row: "微信支付、续费升级、退款、对账、发票",
    digest: "ac9a0c37443399d7755e4429af32522308be727205d1656944c0bef5a3d56f1f",
    files: [
      ["m4-billing-payment-channels.md", "M4"],
      ["m4-billing-wechat-pay.md", "M4"],
      ["m4-billing-purchase-actions.md", "M4"],
      ["m4-billing-fulfill-upgrade-topup.md", "M4"],
      ["m4-billing-invoices.md", "M4"],
      ["m4-weapp-wallet-entries.md", "M4"],
      ["m4-weapp-wechat-payment.md", "M4"],
    ],
  },
  {
    row: "取消、暂停、改派、补发、环节时限、授权书、广告",
    digest: "82e29731d03b0def711bbb3e2bccab7bcdeaf4161f618512595ce4660c7f2c8c",
    files: [
      ["m5-delivery-ad-license-ready.md", "M5"],
      ["m5-delivery-pause-reissue-invariants.md", "M5"],
      ["m5-delivery-stage-sla.md", "M5"],
      ["m5-order-aftersales-licenses.md", "M5"],
    ],
  },
  {
    row: "使用期到期定时器、下架、巡检、整包下载",
    digest: "af6ac4568a485aaa6cba149f50fce442b86da58367a735dbb0263e11303af749",
    files: [
      ["m6-delivery-package-zip-usage.md", "M6"],
      ["m6-delivery-saved-progress.md", "M6"],
      ["m7-delivery-package-download-track.md", "M7"],
    ],
  },
  {
    row: "两条内网探活（资金、流程）",
    digest: "db49f6beb9b528722fc979c1d9e138020b1d9af7eeea92bf758c3d64002cf91d",
    files: [
      ["m4-ops-probe-finance.md", "M4"],
      ["m7-ops-probe-flow.md", "M7"],
    ],
  },
  {
    row: "文本内容安全检测",
    digest: "4650dc28057dd04babb0ca29c7eecb45902114e099e63e8057d2b580079be77f",
    files: [["m2-profile-text-moderation.md", "M2"]],
  },
  {
    row: "图片与视频的内容安全审核",
    digest: "90bdb8c7d7ab45b39d4149d832cfbf13a75a7a45c2585e65511997c1dd6e850c",
    files: [
      ["m2-media-image-moderation.md", "M2"],
      ["m3-media-video-moderation.md", "M3"],
    ],
  },
  {
    row: "样片水印版",
    digest: "46423935afc40bd4c6df4cf6339b00d41930fe2e9288cd621b6afdd9cb6aabcf",
    files: [["m3-delivery-media-production-sync.md", "M3"]],
  },
  {
    row: "登录页、逐集下载页的真实形态",
    digest: "f8fa0ea5c5f551d858a343a0c3dced564ed6e50b5350811d958a254b713a80aa",
    files: [
      ["m2-identity-login-wechat-fake.md", "M2"],
      ["W1-20-m6-episode-save.md", "M6"],
    ],
  },
  {
    row: "通知场景解析函数、提醒端口、用例事务内直记埋点",
    digest: "1a66d9252f7891f30d1b6632a0436e26ae85b4ca3798fb4caf910e5ce06992bb",
    files: [
      ["m2-order-notify-read.md", "M2"],
      ["m2-billing-notification-scenes.md", "M2"],
      ["m2-delivery-notification-scenes.md", "M2"],
      ["m2-publish-notification-scenes.md", "M2"],
      ["m7-order-analytics-consumer.md", "M7"],
      ["m7-publish-outbox-analytics.md", "M7"],
    ],
  },
  {
    row: "订阅点位、端上埋点上报",
    digest: "9fcd6029e2dfc965cc0c7f2f2ca195ced883e64a0be3b4575622095f09c82c46",
    files: [
      ["m2-identity-bootstrap-subscribe.md", "M2"],
      ["m2-weapp-analytics-report.md", "M2"],
    ],
  },
  {
    row: "我的待审批",
    digest: "b1c6a914ddbd8ef71ffda6505e32ab776d37b330fad9ed9d25b0c30977b429ce",
    files: [],
    pages: [["/approvals", "M2", "我的待审批", "M4、M5 各补一段"]],
  },
  {
    row: "M1 内的端口桩（定义方先合并，实现方后到）",
    digest: "fa19ac73440310c73ed4df2dd6a0be0c78d9443a785f9bb119ae62bee5d12e9d",
    files: [
      ["m1-content-order-counts.md", "M1"],
      ["m1-delivery-order-side.md", "M1"],
      ["m1-order-read-fulfillment.md", "M1"],
      ["m1-order-start.md", "M1"],
      ["m1-profile-delivery-manager-assign.md", "M1"],
      ["m1-profile-order-manager-sync.md", "M1"],
      ["m1-publish-launch-reevaluate.md", "M1"],
      ["m1-tenant-billing-account-port.md", "M1"],
      ["m1-tenant-store-facts.md", "M1"],
    ],
  },
  {
    row: "读侧事实端口其余的键（未读数、素材数、广告待确认、工单待确认）",
    digest: "97596af7997bbdd14a0dc14a8ed2e8e4c9cb52f0c15e6ddaccb17c416b8b36e6",
    files: [
      ["m2-identity-overview-notify.md", "M2"],
      ["m3-tenant-store-facts-asset.md", "M3"],
      ["m5-identity-overview-ad.md", "M5"],
      ["m7-identity-overview-support.md", "M7"],
    ],
  },
  {
    row: "协议版本的 PDF 读地址；已签署协议里付款单的标题",
    digest: "3f4dfd659cb690956bce316ed03e11d140f1e28f77c7ab09d718b93684ca3851",
    files: [
      ["m2-docs-agreement-pdf-url.md", "M2"],
      ["m4-docs-signed-agreement-biz-title.md", "M4"],
    ],
  },
  {
    row: "手机号登录休眠检查里“移出休眠店员”“空草稿让位”两支",
    digest: "a71e33e41e6df98fa37cc923a788c5d717817ce29ce8e40f6f4818270fd362da",
    files: [["m2-identity-dormant-branches.md", "M2"]],
  },
  {
    row: "企业微信联系人回填；在线客服配置",
    digest: "08fe020f9ce3650ca4c0c090d3ba9cee92dce5cb4b2df7a51524264b0228babc",
    files: [
      ["m7-identity-wecom-contact-backfill.md", "M7"],
      ["m7-identity-bootstrap-support.md", "M7"],
    ],
  },
  {
    row: "员工激活码短信；发布专员的指派",
    digest: "a197dac21d00a27d9830cea6e3fd61c954a7219f38e6a417d11babec38a2242b",
    files: [
      ["m2-staff-activation-sms.md", "M2"],
      ["m2-staff-assignment-pool.md", "M2"],
    ],
  },
  {
    row: "资质的 `change`、`new_store` 轮次与终局驳回；后台商家列表与详情的跨层聚合项",
    digest: "cfad34f443bc92721802399e4eac99c5a35e7844fe3f85d9b617e36a83db4f43",
    files: [
      ["m2-profile-qualification-rounds.md", "M2"],
      ["m2-profile-admin-facts.md", "M2"],
    ],
  },
  {
    row: "证照识别与字段比对",
    digest: "911a600155eb232d29386eebcd4ceb890bef5b01adc9c0c3ce368176cafb22e8",
    files: [["m3-profile-qualification-recognition.md", "M3"]],
  },
  {
    row: "对公凭证的时限定时器与回单识别；对公大额二人复核",
    digest: "085bc25e847103f17393106ebaf6ddb3ca644f208b3e5e53345425bcc8732f59",
    files: [
      ["m4-billing-proof-ocr-sla.md", "M4"],
      ["m4-billing-second-review.md", "M4"],
      ["m4-billing-payment-reminders.md", "M4"],
    ],
  },
  {
    row: "原片与预告片就绪；版权到期定时器与 `content.I3`；近 30 天订购统计；首页公告条；列表关键词",
    digest: "afde3ec4ef562c8bbdb835fcc3de79c840e35722f49b684422f82e15b0f787a5",
    files: [
      ["m3-content-media-readiness.md", "M3"],
      ["m3-content-license-expiry.md", "M3"],
      ["m3-content-stats.md", "M3"],
      ["m3-content-home-notice.md", "M3"],
      ["m3-content-title-search.md", "M3"],
    ],
  },
  {
    row: "订购时选广告、带参考素材；门店数额度校验；订单读侧的待办、售后、授权书",
    digest: "e8b6be0111ffb89db90cebf9b1bebd5e85dc91531a4c0f43b8a5970ef168e8a6",
    files: [
      ["m5-order-ads.md", "M5"],
      ["m5-weapp-order-ads.md", "M5"],
      ["m3-order-reference-assets.md", "M3"],
      ["m3-weapp-order-reference-assets.md", "M3"],
      ["m2-order-store-quota.md", "M2"],
      ["m7-order-todos.md", "M7"],
      ["m5-order-aftersales-licenses.md", "M5"],
    ],
  },
  {
    row: "剪辑师认领；资质驳回后的 `order.rejected_stale` 与整店取消",
    digest: "0014639cb899a941954368e6bef682f603d5abc02bc08a6dff5168379516b717",
    files: [
      ["m5-delivery-editor-claim.md", "M5"],
      ["m5-order-qualification-reject-followup.md", "M5"],
    ],
  },
  {
    row: "发布清单编辑、预打包、成片包的到期与下架定时器、逐集保存的回报",
    digest: "75fcf7667dff7c5bf2093c0a404967398358cde4c116cdeba25fbb294f65e6f0",
    files: [
      ["m6-delivery-publish-list-invariants.md", "M6"],
      ["m6-delivery-publish-list-prefill.md", "M6"],
      ["m6-delivery-package-zip-usage.md", "M6"],
      ["m6-delivery-saved-progress.md", "M6"],
      ["W1-20-m6-episode-save.md", "M6"],
    ],
  },
  {
    row: "小程序首页待办区、搜索入口、店员视图的“素材需求”“我上传的”",
    digest: "7ec594d271b6771edb23c9db9fa5498afd93f897bb4cc50b3db7ab93c65aa1c7",
    files: [
      ["m7-weapp-home-todo.md", "M7"],
      ["m3-weapp-mall-search.md", "M3"],
      ["m3-weapp-clerk-assets.md", "M3"],
    ],
  },
  {
    row: "后台订购单页的付款单页签；方案表单里改选发布账号；成片批量上传",
    digest: "6b040dd38bd93340fd02014f6a7b6d173d15f954bd2699bb0fede8408234a442",
    files: [
      ["m4-admin-order-payment-tab.md", "M4"],
      ["m6-admin-plan-channel-selection.md", "M6"],
      ["m3-admin-output-batch-upload.md", "M3"],
    ],
  },
  {
    row: "样片页的“提出修改意见”“在电脑上预览”与内嵌播放；发布任务页的下架一侧",
    digest: "29bbe221e91b12d93e70ac3276079e0b4cb2834e56df02699e0ba5c1fdcbef0a",
    files: [
      ["W1-20-m5-sample-feedback.md", "M5"],
      ["W1-20-m6-sample-computer.md", "M6"],
      ["W1-20-m6-publish-future.md", "M6"],
    ],
  },
];

export function planRows(text) {
  const section = text.match(/^### 7\.3[^\n]*\n([\s\S]*?)(?=^### 7\.4[^\n]*$)/m)?.[1];
  if (!section) throw new Error("找不到计划第 7.3 节");
  const lines = section.split("\n");
  const start = lines.findIndex((line) => cells(line)?.join("|") === "留桩|骨架里的做法|回补");
  if (start === -1) throw new Error("找不到计划留桩表");
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    const row = cells(line);
    if (!row) break;
    if (row.length !== 3) throw new Error("计划留桩表必须三列");
    rows.push(row.map(normalize));
  }
  if (!rows.length) throw new Error("计划留桩表为空");
  return rows;
}

function registeredPages(text) {
  if (!text.includes("计入应实现，不算留桩"))
    throw new Error("页面清单缺少入口隐藏页面不算留桩的既有规范");
  const section = text.match(/^## 2\. 运营管理后台\n([\s\S]*?)(?=^## 3\.|$(?![\s\S]))/m)?.[1];
  if (!section) throw new Error("页面清单缺少后台登记");
  const rows = [];
  for (const line of section.split("\n")) {
    const row = cells(line);
    if (!row || ![9, 10].includes(row.length)) continue;
    const path = row[2].replace(/^`|`$/g, "");
    const milestone = row[row.length === 10 ? 7 : 5];
    rows.push({ path, milestone, title: row[1], note: row.length === 9 ? row[8] : "" });
  }
  return rows;
}

export function checkStubs({ plan, stubs, pages }) {
  const rows = planRows(readFileSync(plan, "utf8"));
  const { records, problems } = readLedger(stubs, LEDGERS.stubs);
  const errors = [...problems];
  const mappedRows = new Map(STUB_MAP.map((item) => [item.row, item]));
  const seen = new Set();
  for (const row of rows) {
    const item = mappedRows.get(row[0]);
    if (!item || item.digest !== digestOf(row)) errors.push(`计划留桩行映射未同步：${row[0]}`);
    if (seen.has(row[0])) errors.push(`计划留桩行重复：${row[0]}`);
    seen.add(row[0]);
  }
  for (const item of STUB_MAP) if (!seen.has(item.row)) errors.push(`计划缺少登记行：${item.row}`);
  const expectedFiles = new Map();
  for (const item of STUB_MAP) {
    if (!item.files.length && !item.pages?.length) errors.push(`登记行没有回补目标：${item.row}`);
    for (const [file, milestone] of item.files) {
      if (expectedFiles.has(file) && expectedFiles.get(file) !== milestone)
        errors.push(`文件回补点登记冲突：${file}`);
      expectedFiles.set(file, milestone);
    }
  }
  const files = readdirSync(stubs).filter(
    (file) => file.endsWith(".md") && !SKIPPED.includes(file),
  );
  for (const file of expectedFiles.keys())
    if (!files.includes(file)) errors.push(`缺少登记文件：${file}`);
  for (const file of files)
    if (!expectedFiles.has(file)) errors.push(`留桩文件没有计划行映射：${file}`);
  const counts = new Map();
  for (const record of records) {
    counts.set(record.file, (counts.get(record.file) ?? 0) + 1);
    if (Object.keys(record.fields).join("|") !== LEDGERS.stubs.keys.join("|"))
      errors.push(`${record.file}：模板键必须齐全且顺序不变，不加列`);
    for (const key of LEDGERS.stubs.keys)
      if (!record.fields[key]?.trim()) errors.push(`${record.file}：${key}不能为空`);
    const milestone = record.fields["回补里程碑"]?.match(/^M[0-8](?=$|[，,（(、\s])/)?.[0];
    if (!milestone) errors.push(`${record.file}：回补里程碑不合法，只接受计划 M0–M8`);
    else {
      if (expectedFiles.get(record.file) !== milestone)
        errors.push(
          `${record.file}：回补点与精确映射不一致，应为 ${expectedFiles.get(record.file)}`,
        );
      if (["M0", "M1"].includes(milestone) && record.fields["状态"] !== "已回补")
        errors.push(`${record.file}：${milestone} 留桩尚未回补`);
    }
  }
  for (const [file, count] of counts)
    if (count !== 1) errors.push(`${file}：一个回补点一个文件，只接受一份登记`);
  const registered = registeredPages(readFileSync(pages, "utf8"));
  const pageKeys = new Set();
  for (const item of STUB_MAP)
    for (const [path, milestone, title, note] of item.pages ?? []) {
      const found = registered.filter((row) => row.path === path);
      if (
        found.length !== 1 ||
        found[0].milestone !== milestone ||
        found[0].title !== title ||
        (note && !found[0].note.includes(note))
      )
        errors.push(`未来页面登记缺失或回补说明不符：${path}（${milestone}，${title}）`);
      pageKeys.add(path);
    }
  return { errors, rows: rows.length, files: files.length, pages: pageKeys.size };
}

function main() {
  const defaults = {
    "--plan": join(repoRoot, "docs/08-development-plan.md"),
    "--stubs": join(repoRoot, "docs/plan/stubs"),
    "--pages": join(repoRoot, "docs/plan/pages.md"),
  };
  const args = process.argv.slice(2);
  const seen = new Set();
  try {
    for (let i = 0; i < args.length; i += 2) {
      if (
        !(args[i] in defaults) ||
        seen.has(args[i]) ||
        !args[i + 1] ||
        args[i + 1].startsWith("--")
      )
        throw new Error(`参数无效：${args[i]}`);
      seen.add(args[i]);
      defaults[args[i]] = resolve(args[i + 1]);
    }
    const result = checkStubs({
      plan: defaults["--plan"],
      stubs: defaults["--stubs"],
      pages: defaults["--pages"],
    });
    if (result.errors.length) {
      console.error(`留桩清单检查未通过：\n- ${result.errors.join("\n- ")}`);
      process.exitCode = 1;
    } else
      console.log(
        `留桩清单通过：${result.rows} 行计划 → ${result.files} 个功能文件 + ${result.pages} 个未来页面登记；M0/M1 留桩已清零`,
      );
  } catch (err) {
    console.error(`留桩清单检查：${err.message}`);
    process.exitCode = 2;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
