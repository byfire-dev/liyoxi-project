# W5-14 真实广告验收 runner 与测试口令独立门禁前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | 受保护的 live runner 仅为已存在的 W514 fixture 生成实际三秒广告输入并运输具名 scope；缺 fixture 的默认完整链仍走原路径，显式本目标缺 fixture 明确失败。密钥扫描仅增加一条 generic-api-key + 精确 fixture 路径 + 唯一完整测试值的 AND 误报放行。 |
| 原因 | W5-14 原业务 PR 的 CI 发现既有 runner 属受保护路径，必须独立 gate-change；隔离库中新建 editor 的固定测试口令被通用规则误判，历史与合并提交均需由精确规则覆盖，不能删除历史或换值躲扫描。 |
| 影响的包 | W5-14；本前置实际合入后业务 PR 同步并移除 runner 差异。原 legacy 媒体、二十秒输入 schema、CPU1、并发、single-flight、认证/启动/业务时限和已有断言全部保持。 |
| 类别 | 调度批准的独立 gate-change；仅 runner 与精确误报规则，不夹带页面、fixture、parser、生产逻辑或门禁分类修改。本说明沿既有 infra/ci Markdown 例外登记。 |
| PR | — |

口令只供本轮隔离测试库中新建 editor 的真实激活、设密与浏览器认证使用，不来自部署或平台配置；fixture 先核本轮测试库和 Redis scope，私有浏览器上下文沿原 0600 写入。放行仅匹配完整 secret，不允许同文件其他值或别路径同值。

前置独立运行时没有 W514 fixture，默认旧完整链不会读取新 helper 或写出 W514 信封；fixture 实际合流后，才沿原目标选择、pinned mediatool、真实 probe/hash 与严格私有 scope 接线。本片不包含媒体生成器或服务端任务消费实现。

格式、runner lint 与语法检查通过。临时验证器执行实际新增 runner 片段的五个分支，核缺 fixture 默认旧链、显式目标缺 fixture 拒绝、未选中不调用、选中与默认完整链只调用一次并保留旧信封字段；五例通过。固定本地 gitleaks 镜像在无网 CPU1 条件下三例通过：精确路径与唯一值允许，同路径其他值、其他路径同值仍检出。验证器仅在临时目录，不发布新测试机制；未运行全历史扫描或媒体 live，不以该前置声称 W5-14 页面、外部企业微信、云素材或真机已验。
