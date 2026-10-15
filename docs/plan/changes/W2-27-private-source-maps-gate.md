# W2-27：私有源码映射的独立门禁接线

| 项 | 内容 |
| --- | --- |
| 改了什么 | images构建job先init本次owned私有root；server/gateway各以一bake双target构建，只有该绝对root的fs.write权限；inspect收据、finalize/verify先于原公开打包，always精确cleanup。 |
| 原因 | 构建源码机制已以2329c297合入actual main；既有步骤替换和原OCI字面次数适配经原classifier判为放松，按规约独立gate-change，不混源码/文书路径。 |
| 影响的包 | W2-27、W2-29；旧OCI次数2→1反映server/gateway的labels移到HCL共同输入，新增完整继承/target/tag/docker与local出口核对，原权限/发布条件/SDK/体积断言保留。 |
| 类别 | 门禁放松、范围 |
| PR | 本地codex/w2-27-private-source-maps-gate；ROOT唯一独审0 P1/P2，已正常push并FF actual main de6d5a80。 |

仅三门禁叶：.github/workflows/images.yml、infra/ci/test/stg-images.test.ts、infra/ci/test/source-maps-wiring.test.ts。新增一聚合含失败清理、去校验、任意写范围、私有artifact暴露、错误临时根五反例。原受影响一聚合与新一聚合2G5ms/165ms，另6项跳过；所属格式/lint/diff-check通过。实际提交de6d5a80的原classifier通过：只增4/放松6，仅三门禁叶且带gate-change；ROOT唯一正式审查P1/P2=0，不修改规则；docs/plan/changes与status不属门禁路径，故在de6d5a80实际合流后由本独立观测源码片伴随回写；不混入该三叶门禁提交。

本片不重建、不运行DB/全量类型/远端workflow，不触真实凭据或外部发送。已验运行产物仍为883c68c8的五组件构建/64对runtime哈希事实，本片只接线。上传未配置且未实现，无Sentry CLI/inject/secret；不代表SaaS收到、堆栈已还原或W2-27整包完成。
