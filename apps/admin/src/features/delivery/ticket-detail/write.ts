import { useEffect, useRef, useState } from "react";
import { DeliveryFailure } from "./api";
import { createWriteIntent } from "./model";
export function deliveryFailureMessage(failure: unknown): string {
  const messages: Record<string, string> = {
    VERSION_CONFLICT: "内容已被他人修改，请刷新；当前输入已保留",
    QC_SELF_INSPECTION: "上传人不能检查自己的文件，请换一位质检员工",
    CHECKLIST_VERSION_STALE: "清单模板已更新，请重新加载模板后检查",
  };
  const details = failure instanceof DeliveryFailure ? failure.details : undefined;
  const issues =
    details && typeof details === "object" && "issues" in details && Array.isArray(details.issues)
      ? details.issues
          .map((i: unknown) => (typeof i === "string" ? i : JSON.stringify(i)))
          .join("；")
      : "";
  return (
    (failure instanceof DeliveryFailure && messages[failure.code ?? ""]) ||
    (failure instanceof Error
      ? failure.message + (issues ? "：" + issues : "")
      : "提交失败，请重试")
  );
}
export function useDeliveryWrite(onSuccess: () => void) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string>();
  const [intent] = useState(createWriteIntent),
    live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const submit = async (body: unknown, send: (key: string) => Promise<unknown>) => {
    if (!live.current) return;
    let started = false;
    try {
      const result = await intent(body, async (key) => {
        started = true;
        setPending(true);
        setError(undefined);
        return send(key);
      });
      if (live.current && result !== null) onSuccess();
    } catch (failure) {
      if (!live.current) return;
      setError(deliveryFailureMessage(failure));
    } finally {
      if (started && live.current) setPending(false);
    }
  };
  return { pending, error, setError, submit };
}
