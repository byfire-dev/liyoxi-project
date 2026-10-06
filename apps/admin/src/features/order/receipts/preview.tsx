export function receiptPreviewKind(mime: string): "image" | "pdf" | "unsupported" {
  if (mime === "application/pdf") return "pdf";
  if (["image/jpeg", "image/png", "image/webp"].includes(mime)) return "image";
  return "unsupported";
}
/** 地址只由这次签发取得并保存在详情的内存里，切单/关闭即丢弃。 */
export function ReceiptPreview({
  mime,
  url,
  zoom,
  rotate,
  onError,
}: {
  mime: string;
  url: string;
  zoom: number;
  rotate: number;
  onError: () => void;
}) {
  const kind = receiptPreviewKind(mime);
  if (kind === "pdf")
    return (
      <div>
        <p>该凭证为 PDF 文件，请在新窗口查看。地址过期时可重新获取。</p>
        <a href={url} target="_blank" rel="noreferrer">
          在新窗口查看 PDF 凭证
        </a>
      </div>
    );
  if (kind === "image")
    return (
      <div className="receipts-image">
        <img
          src={url}
          alt="银行转账凭证原图"
          onError={onError}
          style={{ transform: `scale(${zoom}) rotate(${rotate}deg)` }}
        />
      </div>
    );
  return <p>该凭证格式暂不支持预览</p>;
}
