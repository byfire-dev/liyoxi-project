import { Button } from "antd";
import { useState } from "react";
import type { AppServices } from "../app/services";
import { sampleClient } from "./sample-api";

/** 两个同时发起的敏感操作共用再验证弹层；接口仍由样例支架给出。 */
export function StepUpSample({ services }: { services: AppServices }) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState("");
  return (
    <>
      <Button
        loading={pending}
        onClick={() => {
          setPending(true);
          setResult("");
          void Promise.all(
            [1, 2].map(async () => {
              const { data } = await sampleClient(services).POST(
                "/api/v1/admin/samples/step-up-check",
                { body: {} },
              );
              return Boolean(data);
            }),
          )
            .then((results) => setResult(results.every(Boolean) ? "两个操作已完成" : "操作已取消"))
            .catch(() => setResult("操作没有成功，请重试"))
            .finally(() => setPending(false));
        }}
      >
        验证敏感操作
      </Button>
      <span role="status">{result}</span>
    </>
  );
}
