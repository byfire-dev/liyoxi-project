import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseResponse, taskId } from "./parse.js";

describe("ASR uint64 原始 JSON 数字", () => {
  it("100轮所有 uint64 的解析和查询十进制 token 无损且不混为跨日业务身份", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 18446744073709551615n }), (id) => {
        const decimal = id.toString();
        const response = parseResponse(
          `{"Response":{"RequestId":"test","Data":{"TaskId":${decimal}}}}`,
        );
        expect(response?.Data).toEqual({ TaskId: decimal });
        expect(taskId(decimal)).toBe(decimal);
        expect(BigInt(decimal)).toBe(id);
        // 重复官方任务号原样返回；业务去重属于后继本地 job UUID/代次。
        expect(parseResponse(`{"Response":{"Data":{"TaskId":"${decimal}"}}}`)?.Data).toEqual({
          TaskId: decimal,
        });
      }),
      { numRuns: 100, seed: 315001 },
    );
  });
  it("不带原 token 的不安全 number 明确拒绝，不能查舍入后的任务", () => {
    expect(taskId(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
    expect(taskId(Number.MAX_SAFE_INTEGER)).toBe(String(Number.MAX_SAFE_INTEGER));
  });
});
