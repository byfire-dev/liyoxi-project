import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { Cases, liveContext } from "./control-client";

/** No error/steps/stdio/attachments are serialized, even on a failed authentication request. */
export default class SafeReporter implements Reporter {
  private readonly cases: { id: string; status: TestResult["status"]; durationMs: number }[] = [];
  private rejectedOutput = false;
  onTestEnd(test: TestCase, result: TestResult) {
    if (
      !(Cases as readonly string[]).includes(test.title) ||
      this.cases.some((item) => item.id === test.title)
    ) {
      this.rejectedOutput = true;
      return;
    }
    this.cases.push({
      id: test.title,
      status: result.status,
      durationMs: Math.round(result.duration),
    });
    if (result.attachments.length > 0 || result.stdout.length > 0 || result.stderr.length > 0)
      this.rejectedOutput = true;
  }
  onStdOut() {
    this.rejectedOutput = true;
  }
  onStdErr() {
    this.rejectedOutput = true;
  }
  onError() {
    this.rejectedOutput = true;
  }
  onEnd(result: FullResult) {
    const { stageDirectory } = liveContext();
    writeFileSync(
      join(stageDirectory, "cases.json"),
      `${JSON.stringify({
        status: result.status,
        rejectedOutput: this.rejectedOutput,
        cases: this.cases,
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );
  }
  printsToStdio() {
    return false;
  }
}
