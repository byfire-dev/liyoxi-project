import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { repoRoot } from "./helpers.js";

const workflow = readFileSync(join(repoRoot, ".github/workflows/images.yml"), "utf8");
const body = workflow.split("  build-images:\n")[1]!.split("\n  publish-images:")[0]!;
const name = "      - name: 上传本轮私有源码映射（显式启用）\n";
const guard =
  "vars.STG_SOURCE_MAP_UPLOAD_ENABLED == 'true' && github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')";

function checkUpload(job: string) {
  expect(job.split(name)).toHaveLength(2);
  const upload = job.split(name)[1]!.split("      - name:")[0]!;
  expect(upload.trim()).toBe(
    `if: ${guard}
        env:
          SENTRY_AUTH_TOKEN: \${{ secrets.SENTRY_AUTH_TOKEN }}
          LYX_SENTRY_UPLOAD_CONFIG: \${{ vars.LYX_SENTRY_UPLOAD_CONFIG }}
          TAG: \${{ steps.source.outputs.tag }}
        run: node infra/deploy/source-map-upload.mjs "$LYX_SOURCE_MAPS_DIR" "$GITHUB_SHA" "$TAG"`,
  );
  // 唯一受控step以外仍完全禁止密文引用，包括job环境与PR可执行steps。
  expect(job.replace(upload, "")).not.toContain("secrets.");
  expect(job.match(/source-map-upload\.mjs/g)).toHaveLength(1);
  expect(job.indexOf("source-maps.mjs verify")).toBeLessThan(job.indexOf(name));
  expect(job.indexOf(name)).toBeLessThan(job.indexOf("      - name: 打包同一源码的构建产物"));
  const artifact = job.split("      - name: 保存构建产物\n")[1]!.split("      - name:")[0]!;
  expect(artifact).toContain("path: ${{ runner.temp }}/images-out/");
  expect(artifact).not.toContain("LYX_SOURCE_MAPS_DIR");
  const cleanup = job.split("      - name: 只清本轮私有映射\n")[1]!;
  expect(cleanup).toContain("if: always()");
  expect(cleanup).toContain('node infra/deploy/source-maps.mjs cleanup "$LYX_SOURCE_MAPS_DIR"');
  expect(job).not.toContain("continue-on-error");
}

it("私有映射上传只在可信main启用，secret仅该step、同源路径且失败仍清理，五反例必须拒绝", () => {
  checkUpload(body);
  for (const invalid of [
    body.replace(`if: ${guard}`, "if: success()"),
    body.replace(
      "      - name: 冻结安装与小程序构建（含原体积门禁）\n",
      "      - name: PR可执行的额外step\n        env:\n          TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}\n        run: true\n      - name: 冻结安装与小程序构建（含原体积门禁）\n",
    ),
    body.replace(
      "          LYX_SENTRY_UPLOAD_CONFIG: ${{ vars.LYX_SENTRY_UPLOAD_CONFIG }}",
      "          EXTRA_TOKEN: ${{ secrets.EXTRA_TOKEN }}\n          LYX_SENTRY_UPLOAD_CONFIG: ${{ vars.LYX_SENTRY_UPLOAD_CONFIG }}",
    ),
    body.replace("path: ${{ runner.temp }}/images-out/", "path: ${{ env.LYX_SOURCE_MAPS_DIR }}"),
    body.replace("if: always()", "if: success()"),
  ])
    expect(() => checkUpload(invalid)).toThrow();
});
