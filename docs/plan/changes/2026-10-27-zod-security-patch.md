# Zod 安全补丁升级

PR #150 的生产依赖审计发现 GHSA-mrhx-c7xc-m3w5：当前4.6.5属于受影响版本，GitHub官方公告列4.6.6起修复。独立依赖升级分支仅将API、contract、services的三处直接声明锁定4.6.6，由pnpm生成工作区锁，并回写02依赖记录；不与报价业务PR混合。

来源：[GitHub Advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)；官方npm元数据本轮读取确认4.6.6发布于2026-10-11T16:18:23.878Z，已满七天。保留minimumReleaseAge、trustPolicy、audit-level与所有门禁，不加豁免/覆盖或新依赖。

2026-10-27本地定点验收通过：Node24.20.0、单worker无文件并行；生产high审计退出0（剩3低/6中、无高危），精确`packages/contract/src/contract.test.ts`首次43/43通过（2.89秒），contract/API/services三包类型均首次通过，官方`contract:check`生成物无差异。日志分别为`/tmp/lyx-zod-audit.log`、`/tmp/lyx-zod-contract-target.log`、`/tmp/lyx-zod-{contract,api,services}-types.log`及`/tmp/lyx-zod-contract-check.log`。未扩大到完整资金或浏览测试；独立源码审查由m4_refund_ui完成，无P1/P2/D。

远端PR尚待required CI，镜像独立锁核验的原失败仍另查，不能由本补丁冒充修复。
