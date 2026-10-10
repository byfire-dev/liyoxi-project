import { describe, expect, it } from "vitest";
import { signAsr } from "./sign.js";

describe("ASR TC3 固定向量", () => {
  it("依官方 TC3 规范独立用 Python hashlib/hmac 计算期望值", () => {
    // https://cloud.tencent.com/document/api/1093/37823 的固定请求形状。
    // 凭据是官方公开示例占位；期望值没有调用本仓 signAsr 生成。
    const payload =
      '{"EngineModelType":"16k_zh","ChannelNum":1,"ResTextFormat":3,"SourceType":0,"Url":"https://example.invalid/audio.m4a"}';
    expect(
      signAsr({
        secretId: "AKIDEXAMPLE",
        secretKey: "SECRETKEYEXAMPLE",
        timestamp: 1551111465,
        payload,
      }),
    ).toBe(
      "TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2019-02-25/asr/tc3_request, SignedHeaders=content-type;host, Signature=9295514b675e02c09d9c5940ed15c2f99b3bbaf8c696af13baf18c8fb0d46c7d",
    );
  });
});
