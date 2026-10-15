import { expect, it } from "vitest";
import { orchestrate } from "../../deploy/orchestrate.mjs";
import type { Channel, Options } from "../../deploy/orchestrate.mjs";
import { validateRecord } from "../../deploy/node-record.mjs";
import type { ReleaseRecord } from "../../deploy/node-record.mjs";

it("普通发布只接受passed，拒绝仍留记录；rollback保留原unavailable与failed规则", () => {
  const attempt = (options: Options) => {
    const calls: string[] = [];
    const records: ReleaseRecord[] = [];
    const channel: Channel = (step, args = []) => {
      calls.push(step);
      if (step === "record") {
        const encoded = args[1];
        if (!encoded) throw new Error("缺少追加记录");
        records.push(validateRecord(JSON.parse(Buffer.from(encoded, "base64url").toString())));
        return { status: 0, stdout: "", stderr: "" };
      }
      // 到facts即受控停止，证明守卫通过；不执行真实SSH/节点动作或重放原正路径矩阵。
      return { status: 17, stdout: "", stderr: "fixture facts stop" };
    };
    const result = orchestrate({ tag: "sha-222222222222", ...options }, channel);
    expect(records).toHaveLength(1);
    expect(result.recordError).toBe("");
    expect(records[0]).toMatchObject({
      result: "failure",
      onlineTouched: false,
      runtimeTouched: false,
    });
    return { result, calls, record: records[0]! };
  };
  for (const options of [{}, { compatibility: "unavailable" }, { compatibility: "failed" }]) {
    const { result, calls, record } = attempt(options);
    expect(result).toMatchObject({ exitCode: 1, failedStep: "precheck" });
    expect(calls).toEqual(["record"]);
    expect(record).toMatchObject({
      action: "release",
      failedStep: "precheck",
      compatibility: options.compatibility ?? "unavailable",
      steps: [],
    });
  }
  for (const options of [
    { compatibility: "passed" },
    { rollback: true, compatibility: "unavailable" },
  ]) {
    const { result, calls, record } = attempt(options);
    expect(calls).toEqual(["facts", "record"]);
    expect(result).toMatchObject({ exitCode: 1, failedStep: "facts" });
    expect(record.compatibility).toBe(options.compatibility);
    expect(record.action).toBe(options.rollback ? "rollback" : "release");
  }
  const failedRollback = attempt({ rollback: true, compatibility: "failed" });
  expect(failedRollback.calls).toEqual(["record"]);
  expect(failedRollback.result.failedStep).toBe("precheck");
});
