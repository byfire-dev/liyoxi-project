# 证照识别与字段比对

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | 证照上传暂不识别，提交暂不比对 |
| 骨架里的做法 | profile/documents.ts 回 recognized/submitted=null、doc.ocrStatus=unavailable；手填按字典校验并加密派生；提交 checkSummary 的 manual 为证照数、checksRanAt=null；仅 normal 通过 |
| 登记的工作包 | W1-08a |
| 回补里程碑 | M3，G3-C |
| 回补的工作包 | W1-23 拆包后填写 |
| 依据 | W1-08 第 2、7 节；m03 第 3.12、3.17 节 |
