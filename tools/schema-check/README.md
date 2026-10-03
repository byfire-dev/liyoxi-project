# 数据模型校验

校验 [docs/data-model/](../../docs/data-model/README.md) 里的数据库结构草稿是否自洽：

1. Prisma（版本锁定 7.10.0）校验 `schema.prisma`；
2. 离线生成建表语句，在临时 PostgreSQL 库里真正执行；
3. 按顺序执行 `constraints/` 里的手写约束（CHECK、部分唯一索引、排他约束、触发器）；
4. 逐列比对各分组文档的字段表与库里的实际结构；
5. 找出文档里引用了、但库里不存在的列。

## 准备

```bash
cd tools/schema-check && npm install
```

还需要本机能用 `psql` 连上一个 PostgreSQL（14 及以上；目标环境是 17），连接参数用标准环境变量 `PGHOST`、`PGPORT`、`PGUSER`、`PGPASSWORD`，该用户要有建库权限。

## 运行

```bash
python3 tools/schema-check/check.py
```

默认建一个名为 `lyx_schema_check` 的临时库，跑完删除；加 `--keep` 保留，便于手工查看（[tools/api-check](../api-check/README.md) 也用它）。全部通过时退出码为 0，有问题为 2。

注意：`--db` 给的是**临时库名**，不是“要检查的库”。脚本会先删除再重建这个库，所以只接受以 `lyx_` 开头的名字；运行前确认 `PGHOST` 指向的是本机或专用的校验实例。建表与约束语句出错即停，按 `psql` 的退出码判断成败；失败时不保留半成品库。

## 说明

- 这里校验的是**草稿**：没有业务数据、没有跑迁移工具、没有测性能。正式工程开工后，结构以 `packages/db` 的 Prisma schema 与迁移为准，本目录随之废弃。
- 手写约束只用 PostgreSQL 14 也支持的语法，是为了能在常见的本机环境上校验；目标库是 17。
