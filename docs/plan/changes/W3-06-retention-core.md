# W3-06 六接口核心片

| 项 | 内容 |
| --- | --- |
| 改了什么 | 消费已合PR1的sessionMutex交六接口核心，恢复/彻删覆盖claim、可取消版本外呼与settle，同键处理/重放沿原三段式 |
| 原因 | 精确key枚举完整版本并验证HEAD，保护真实引用与保留期；缺版本恢复能力时不伪造成功 |
| 影响的包 | W3-06核心片及两接口三段式、既有审计target/action必要登记；精准inUse与清扫仍待续片 |
| 类别 | 拆并（同包分片） |
| PR | — |

- 消费已合PR1的sessionMutex，恢复/彻删覆盖claim、真实可取消外呼与settle；同键处理/重放沿原三段式，不读幂等私表。
- 补存储精确key的恢复marker/彻删全部版本原语；COS Enabled与Suspended都枚举，分页完整且HEAD验证才成功，MinIO不伪造恢复能力。
- 彻删同时保护live、keepUntil、canRelease与拥有者真实readColumns；历史投影保守拒绝，精准inUse和media.sweep/OCR/I8/I13仍待续片，不宣称整包完成。
- 必要登记伴随：两接口补真实x-three-phase；审计target补既有file_purge_run；审计动作勘误为符合冻结三段格式的files.file.restore/erase，权限点保持原名。
- 文件事务提交后才锁ZIP与派生文件；实际probe的media_info/cover沿既有release保留30天缓冲。ROOT独审与串行定点重型，作者仅轻检查/正常hooks；真桶恢复/清扫/彻删未验。
