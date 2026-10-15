# 同提交的发布检查选择（W2-28）

`release-checks.mjs`只读两份已经取回的GitHub Actions运行清单，不联网、不轮询、不部署。调用方式：

```sh
GITHUB_REPOSITORY=owner/repository EXPECTED_SHA=<完整40位提交号> \
  node infra/ci/release-checks.mjs <images运行清单.json> <mixed运行清单.json>
```

后继工作流分别请求`releaseCheckRequests(repository, source)`返回的两条GET路径，各一次，不加`status=success`过滤（会掩盖同提交更新的失败或运行中结果），不自动重试。403、429及Retry-After由调用者停止并保留失败。返回页必须完整，至多100条；缺页不继续翻页或猜测通过。接口字段依据[GitHub官方工作流运行说明](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow)。

两个清单都须严格来自同仓、main、push和同一个完整SHA，分别匹配固定images/mixed-smoke工作流路径、名称及唯一workflow_id。按各工作流run_number选最新一次，要求completed/success；缺失、等待、失败、取消、错仓/分支/SHA或重复/不完整记录均拒绝。接受GitHub返回的无后缀路径和明确`@main`/`@完整SHA`路径。一次运行的重跑沿API当前run_attempt，不接受旧的成功作为替代。

成功仅输出提交、仓库、两条run ID/attempt及`compatibility: passed`，不透传API响应中的用户、标题、URL或任何额外字段。命令失败不输出输入正文或文件路径。调用者必须在创建SSH文件、节点pull和部署之前执行选择，并使用选中的imagesRunId下载相同运行的摘要，继续原validateRelease/镜像身份核验。

本片尚未改工作流或发布入口：真实双版本四步仍在实现，后继独立gate片会同时消费images和mixed-smoke完成事件，并保留默认关闭、同仓/main/push门控。该纯选择器通过不代表远端CI、真实混跑或部署放行。
