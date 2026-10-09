# 有界正文转换（W2-12 PR1）

这是 L0 本地技术能力：返回实际文件/HTML 的 SHA256 和文本相似度，不判断文件授权，不写业务表，不定义 HTTP conversion state。PR1 没有新增 HTTP、页面、cron 或桩回补；W2-12 的八接口和生命周期仍由 PR2 完成。

## 调用与资源归属

应用源码从既有 `@liyoxi/services` 公开入口取 `createDocumentConverter`。API/worker 主入口分别把同目录实际 `document-converter.js` 的 URL 注入组合根；关闭进程前 await converter.close()。

```ts
const converter = createDocumentConverter({ workerUrl, concurrency: 1 });
const result = await converter.convert({
  signal,
  load: async (readSignal) => {
    // 此回调取得容量后才执行；HEAD/GET 必须收到 readSignal。
    // 将 StorageProvider.readObject 的成功值交进来；Provider 失败由调用域映射并抛出。
    return { sourceBytes, pdfBytes };
  },
});
await converter.close();
```

`load(signal): Promise<DocumentInput>` 是必须的容量边界，不能在调用 convert 前完整读取正文。每进程并发只能为 1，最多保留 16 个待处理回调；排队不存储文件字节。10 秒壁钟从提交请求开始，包括排队、HEAD/GET 和 CPU。排队可取消且不执行 load；在途取消将 signal 交给 loader，并 terminate/await CPU worker。loader 必须遵守 signal、停止并清理 I/O；在它实际结束前不会释放容量，close 也等待它结束。未经配置的组合根保留 null，不伪装成真实转换器。

完整独占 ArrayBuffer 转移后会被 detach，调用方不能再使用该批输入。共享内存、Buffer 池和带偏移的视图复制为精确独占字节后转移，不转移整块池或其他文件字节。loader 抛出的领域/Provider 错误原样交回调用方；CPU 仅返回固定 reason 与 source/pdf 角色，不返回解析异常、正文片段或路径。父进程丢弃 CPU 的 stdout/stderr。

主流程 factory 仍来自原 services/kernel，与事务单元共用原 AsyncLocalStorage。真实事务测试确认入口在 admission 前拒绝，loader 调用数为 0。将来 PR2 必须先经 docs 的窄 fileport/实际 media owned 公口 prepare，事务外读取/转换；按排序 file 锁后重新确认 id/etag/归属、stored/category/ext/platform/scope。这个技术端口不能代替该权限复验。

## 输入与结果

- DOCX/PDF 各最多 20MiB，合计 40MiB，与现有 legal_doc 上传口径一致。ZIP 最多 256 entry、32MiB 总展开、8MiB 单 entry、压缩比 100；中央目录和本地头、真实 inflate 长度、CRC 和数据描述器分别核实。拒加密、宏、路径/重复/重叠、ZIP64 和不能安全解析的格式。支持普通合法有/无签名数据描述器，不只相信目录大小。
- Mammoth `externalFileAccess=false`；不加载嵌入图片。清洗后的 HTML 只含标题、段落、列表、强调、表格等结构标签，全部属性禁用，没有 URL/图片/script/style。清洗前后 UTF-8 都限 1MiB，Word 文本最多 250k codepoints。
- PDF 仅收 Uint8Array，不接 URL；只抽文本，不渲染画布。最多 100 页、250k 抽取 codepoints；关闭字体面、系统字体、worker fetch、WASM、offscreen/image decoder/autofetch。text reader 使用固定 Error 原因取消、释放锁，loading task 在 finally destroy；资源预算错误保持失败，不能被 cleanup 覆写成相似度 0。
- 相似度先 NFC、去空白，再计算 codepoint bigram multiset Dice，用唯一 shared.divRoundHalfUp 取整数万分比。非空同文 10000，任一侧无文本为 0，缺一份文件为 null。低于 9800 的业务警告由 PR2 按 a09 映射，不代表法律等价。

PDF-only 严格按正式 a09 只 hash 有界真实字节，HTML/hash/similarity 为 null，不加载 PDF.js；技术层不会因为加密、扫描或无法解析而添加草稿拒绝条件。文件角色、扩展名与可用性另由实际文件端口校验。Word+PDF 的已识别损坏/加密/不支持/无文本抽取返回真实 0，并带固定 `pdfTextIssue: invalid_document | unsupported_document | no_text | null`；它是技术原因，不是 HTTP 错误或 conversion state。未知异常、RangeError、页数/字数/时限等资源失败不降成成功。Word 损坏或不支持转换始终失败。

PDF.js 6.3.289 的实际 types 不再接受旧 `isEvalSupported` 参数。检查当前 legacy pdf.mjs/pdf.worker.mjs 没有 JavaScript eval/new Function 调用；没有设置一个被库忽略的假选项。当前路径不给外部资源地址、不调用字体/画布渲染，native canvas 与 parser 均只在隔离线程动态加载。该事实差异记录在本包状态，不能表述为完整审核 PDF.js 所有代码。

## 真实构建与依赖

两 CLI 源码只引用原 services 公开名称。正常 API/worker/seed/staff-bootstrap 构建保留原 resolver/external 行为；仅 converter 使用独立第二轮 build，将该入口的公开 import 定向到已经由 services/kernel 逐层公开转导的同一函数文件。build 先核实完整公开绑定链，并对两个结果都核验外部生产依赖。CPU 产物禁止带入业务装配、Provider 或 db 图，没有新增子路径、sideEffects 声明或层级豁免。worker converter 从原 11MiB 降为约 155KiB，主应用 bundle 保持原行为。

四库 `mammoth@1.13.0`、`sanitize-html@2.17.7`、`pdfjs-dist@6.3.289`、`@napi-rs/canvas@1.0.9` 在 services/API/worker 三份清单共 12 处生产声明；`@types/sanitize-html@2.16.2` 仅 services dev。sanitize-html 用成熟且已修 GHSA-vccv-cmxp-4j9h 的版本，不等 2.18。新生产路径暴露 source-map-js 1.2.1 的 GHSA-68fv-2mgg-jv7q，其1.2.2及四处既有锁边已通过独立安全分支实际合入本地主干 44b5be61，再由本分支普通同步继承。本包当前差异不含该既有依赖升级，不加 override/直接依赖或豁免。原 trust、minimumReleaseAge=10080、安装脚本白名单与审计门禁保持。

官方发行信息见[预拆记录](../../../../../docs/plan/changes/W2-12-document-capability-first.md)；[source-map-js 官方 registry](https://registry.npmjs.org/source-map-js)中 1.2.2 发布于 2026-09-30T14:08:09.382Z。相对当前实际主干 1f851e0c 新增的39个锁版本（含 native optional）通过实际7日门禁。本地执行官方生产审计命令 high/critical 均为0，仍有1项 moderate；远端CI未执行。原全仓 raw audit 的旧开发依赖记录不等于全仓漏洞为0。

## 验收与限制

Node 24 下用纯虚构真实 Word/中文 PDF 测试：结构保留、白名单、真实 hash、异文、扫描/真实加密 PDF-only、Word 受控失败、20+20MiB、普通数据描述器、实际 inflate/CRC/双头加密/错名/重叠、页数/真实抽取字数/HTML 字节预算、容量/取消/10 秒/关闭。夹具经既有 `@liyoxi/services/testing` 公开口消费，生产入口不导出夹具。

```sh
APP_ENV=test pnpm exec vitest run --project services packages/services/src/kernel/document-conversion/document-conversion.test.ts packages/services/src/kernel/three-phase/guard.test.ts
pnpm exec vitest run --project api apps/api/test/document-converter-build.test.ts --project worker apps/worker/test/document-converter-build.test.ts
docker build -f infra/docker/server/Dockerfile --build-arg LYX_BUILD=w212-capability -t liyoxi/server:w212-document-capability .
node infra/docker/server/verify/document-conversion.mjs --image liyoxi/server:w212-document-capability
```

数据库测试须配已迁移的本地测试连接和独占 session；不读取真实密钥。容器命令只启动并清理自有私有容器，不部署共享 Compose。host 先构造虚构文件，readonly bind 进容器；容量取得后才读取/transfer。原固定提交 f78ed5a2 的 API/worker 各自独占 Linux Node24 容器，320MiB memory/swap、根只读、/tmp64MiB、network none。该轮两产物分别通过 20+20MiB、I/O/CPU 取消、10 秒终止、主 host 恢复和 MessagePort 清理，cgroup peaks 156356608/155217920 字节；真实 inspect 的退出码均0、OOMKilled=false、资源形态符合，原第4轮绿色也保留。当前九个纯 CPU 源文件与该固定提交逐 SHA 不变，因此保留该历史容器证据，不宣称本轮重建或验收当前完整服务镜像。

前 3 轮失败日志保留：容器内生成大夹具造成 OOM；将两应用载入同一假父进程触顶；分开后旧完整业务 CPU bundle 的 worker 仍触顶。最终修正测试形态并缩小真实 CPU 子图，未扩容、收紧上传、人工 GC 或改变成功判据。128MiB JS heap/4MiB stack 不约束 native 内存，不能拿 heap 当容器保证。

普通同步当前实际主干后，两个真实独立 converter 产物和原 API 启动/探活/退出三文件6例、全 workspace 串行类型与必要门禁重新通过。原 Storage 六文件完整403例、严格 Provider 集合/替身、未配置 Provider 完整122例，以及 COS 原12例加新增20例隔离 HTTP 协议通过。COS 追加同一 readObject 端口，沿用真实签名、在途取消及关闭清理；原 readPrefix 保持。API 启动测试仅迁移到既有完整种子夹具；Provider golden 只追加当前主干已有的方法预期。

原唯一独审511秒的1项 D/P1 是既有依赖升级混入业务差异；独立安全修复实际合入、普通同步及官方业务分类通过后关闭，0 P2，没有第二轮正式独审。新主干兼容伴随由作者验证，原独审不覆盖这些新增行。以上容器证据仅覆盖实际 converter 产物与 host，不宣称完整 API/worker 服务容量已验收。正文没有真实云调用、法律正文或自动法务勾选；W2-12 仍进行中，E8 和 PR2 八接口、两个 cron、生命周期与两桩仍待办，W2-16 继续等待整包完成。当前按授权本地合流，远端 PR/CI 未执行。
