# security：字段加密、盲索引、敏感字段三件套

由 W0-14 交付。依据：[06](../../../../docs/06-data-model.md) 第 3.2 节；[01](../../../../docs/01-architecture.md) 第 10.2 节；ADR-025；D4 第 9.2、9.3 节；D7 第 7.5 节。回调验签与收件箱也归本模块，随 G2-0。

## 1. 这里有什么

| 文件 | 内容 |
| --- | --- |
| `keyring.ts` | 密钥环：`createKeyring`、`keyringFromEnv`、盲索引用途 `BIDX_PURPOSES`、`SecurityError` |
| `crypto.ts` | `encryptField`、`decryptField`、`kidOf` |
| `bidx.ts` | `blindIndex` 与两个归一化函数 |
| `pii.ts` | 三件套：`sealPhone`、`sealUscc`、`sealBankAccount`、`phoneBidx`、`usccBidx`、`openField` |
| `selfcheck.ts` | 启动自检 `selfCheck`、`loadKeyring` |

## 2. 用法

```ts
const keyring = security.loadKeyring(env); // 进程启动时一次：造密钥环并自检，不过即抛错（W0-22、W0-23 接）

// 写：仓储层把三件套各写进各的列
const phone = security.sealPhone(keyring, "merchant_user.phone_enc", input.phone);
await tx.merchantUser.create({
  data: { phoneEnc: phone.enc, phoneBidx: phone.bidx, phoneMask: phone.mask, phoneLast4: phone.last4 /* … */ },
});

// 查：按盲索引等值查，+86 写法与纯数字写法查到同一行
await tx.merchantUser.findUnique({ where: { phoneBidx: security.phoneBidx(keyring, input.phone) } });

// 解：只有 security 与各模块的仓储层调
security.openField(keyring, "merchant_user.phone_enc", row.phoneEnc);
```

- 密文：`v1:<kid>:<base64url(iv ‖ 密文 ‖ tag)>`，AES-256-GCM，随机 12 字节 IV，存 `text`。
- AAD 是密文所在的列，写成 `表名.列名`（带 `_enc` 后缀，如 `merchant_user.phone_enc`）：密文挪到别的列解不开。加密与解密要给同一个写法。
- 盲索引：`HMAC-SHA256(K[用途], 归一化(值))`，32 字节，存 `bytea`。手机号只留数字并去掉 `+86`；信用代码去空白、转大写。只支持等值查询与唯一约束。
- 入库的明文是归一化之后的；脱敏串调 `@liyoxi/shared/mask`。密文与盲索引不出接口（约定 C15），接口只给脱敏串。
- 明文里有不成对的代理项时拒绝加密（它过不了 UTF-8）。

## 3. 密钥

- 只经 `loadEnv` 读：`DATA_KEYS_FILE`、`BIDX_KEYS_FILE` 两项成组，任何环境都只认文件路径，给明文变量 `DATA_KEYS`、`BIDX_KEYS` 即失败。文件格式与生成方法见仓库根 `.env.example` 的注释。
- 两项都不配时 `loadEnv` 照常通过（不用密钥的脚本不受影响），`loadKeyring` 报 `keyring_missing`：要用密钥的进程起不来。
- 数据密钥轮换：往 `keys` 里加新 `kid`，把 `current` 改成它。新密文用新密钥，旧密文照样能解；逐行重加密完成之后才能把旧 `kid` 拿掉（拿掉后解旧密文报 `unknown_kid`）。重加密任务不在本包，`kidOf` 可以用来挑出还在用旧密钥的行。
- 盲索引密钥轮换要重算整列（加新列、双写、回填、切换、删旧列），只进运维手册，不做自动化。
- 新的盲索引用途：往 `BIDX_PURPOSES` 末尾加一项、在 `bidx.ts` 的 `NORMALIZE` 里写它的归一化，密钥文件里加同名的一项。各把密钥要互不相同。
- 测试用固定字节现造的假密钥（`__fixtures__/keys.ts`），不读任何文件。

## 4. 跑用例

```sh
pnpm --filter @liyoxi/services exec vitest run src/security/
LYX_FC_RUNS=5000 LYX_FC_SEED=42 pnpm --filter @liyoxi/services exec vitest run src/security/crypto.property.test.ts
```

`bidx.db.test.ts` 连真库（`merchant_user`），走测试支架：要本地的 PostgreSQL 与 `DATABASE_URL`（`CLAUDE.md` 第 9 节）。
