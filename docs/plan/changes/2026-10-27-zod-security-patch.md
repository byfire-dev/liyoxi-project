# Zod 安全补丁升级

PR #150 的生产依赖审计发现 GHSA-mrhx-c7xc-m3w5：当前4.6.5属于受影响版本，GitHub官方公告列4.6.6起修复。独立依赖升级分支仅将API、contract、services的三处直接声明锁定4.6.6，由pnpm生成工作区锁，并回写02依赖记录；不与报价业务PR混合。

来源：[GitHub Advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)；官方npm元数据本轮读取确认4.6.6发布于2026-10-11T16:18:23.878Z，已满七天。保留minimumReleaseAge、trustPolicy、audit-level与所有门禁，不加豁免/覆盖或新依赖。

验收待本轮唯一重槽：生产high审计、精确contract目标、三受影响包类型与官方生成物无差异；未执行前不标通过。远端镜像独立锁核验失败另查，不能由本补丁冒充修复。
