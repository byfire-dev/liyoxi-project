# 接口契约核对

核对 [docs/api/](../../docs/api/README.md) 下的接口文档是否自洽，并由路线图与各文档的结构化清单重新生成登记表。只用 Python 3 标准库；“表.列”一项另需要 [schema-check](../schema-check/README.md) 建好的校验库。

## 读什么

| 输入 | 位置 |
| --- | --- |
| 路线图（全部接口） | `docs/api/working/routemap.json` |
| 各文档的结构化清单 | `docs/api/working/frag/<文档>.json` |
| 通用约定 | `docs/api/00-conventions.md` |
| 裁决 | `docs/api/working/api-rulings.md` |
| 接口文档 | `docs/api/<文档>.md` |

## 脚本

| 脚本 | 做什么 | 输出 |
| --- | --- | --- |
| `check.py` | 整体核对：路线图的每条接口是否写进文档与清单；错误码有没有未定义、重名、重号、越出分段；接口引用的事件是否都在事件目录里；文档引用的“表.列”在校验库里是否存在；文档引用的 operationId 是否存在 | 终端与 `out/api-check.md` |
| `gen_registries.py` | 生成接口索引与错误码登记表；输出约定 C28 共用领域码归属表的表格 | `docs/api/registry-routes.md`、`registry-errors.md`；`out/c28-table.md` |
| `gen_permissions.py` | 生成权限点与能力点注册表（d4 第 5、7 节的默认值写在脚本里，按裁决增补） | `docs/api/registry-permissions.md`；`out/permissions.json` |
| `schema_dups.py` | 找同名不同构、同构不同名的公共结构（约定 C87） | `out/schema-dups.md` |
| `collect_open.py` | 汇总各文档“待确认”表 | `out/open-questions.json` |

## 运行

```bash
python3 tools/schema-check/check.py --keep
```

```bash
python3 tools/api-check/check.py
```

```bash
python3 tools/api-check/gen_registries.py && python3 tools/api-check/gen_permissions.py
```

`check.py` 的“表.列”一项默认连库 `lyx_schema_check`（schema-check 加 `--keep` 留下的库），连接参数用 `PGHOST`、`PGPORT`、`PGUSER` 等标准环境变量；库名可用环境变量 `API_CHECK_DB` 改。连不上、没装 `psql` 或库里的表不全时，这一项**跳过并写明“未核对”**，其余照常核对。

`check.py` 有任何一项不通过时退出码为 2，报告末尾有“结论”。“引用了不存在的 operationId”一项不查各文档的“修订记录”一节（那里保留了改名前的旧名）。`gen_registries.py` 先校验、全部生成成功后才写文件；`gen_permissions.py` 发现路线图用到的键不在注册表里时退出码为 2。

## 说明

- 这里核对的是**文档**的自洽，不是代码。正式工程开工后，契约以 `packages/contract`（Zod schema 与生成的 OpenAPI）为准，本目录保留并改造（开发计划 第 4.2 节 Q3）：`check.py` 已进 CI（`node infra/ci/api-check.mjs`，“表.列”一项连跑完迁移的 `lyx_migrate_check`，未核对按失败算；通过后重新生成三份登记文档并 `git diff --exit-code`），保证路线图、结构化清单、分组文档与登记文档一致；契约与路线图一致由 `pnpm contract:docs-check` 保证。
- 改了接口文档后，要同步改该文档的结构化清单（`working/frag/`）与路线图（`working/routemap.json`），再跑本目录的脚本；两者的格式见 [working/API-WRITER-GUIDE.md](../../docs/api/working/API-WRITER-GUIDE.md) 第 4 节。
