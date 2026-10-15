import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { repoRoot } from "./helpers.js";

const workflow = readFileSync(join(repoRoot, ".github/workflows/images.yml"), "utf8");
const body = workflow.split("  build-images:\n")[1]!.split("\n  publish-images:")[0]!;

function checkWiring(job: string) {
  expect(job).toContain('dir="$(node infra/deploy/source-maps.mjs init "$RUNNER_TEMP")"');
  expect(job).toContain('echo "LYX_SOURCE_MAPS_DIR=$dir" >> "$GITHUB_ENV"');
  expect(job.indexOf("source-maps.mjs init")).toBeLessThan(job.indexOf("pnpm weapp:build"));
  expect(job).toContain("WEAPP_VERSION: ${{ steps.source.outputs.tag }}");
  expect(job).toContain("TAG: ${{ steps.source.outputs.tag }}");
  expect(job).toContain("MAPS_DIR: ${{ env.LYX_SOURCE_MAPS_DIR }}");
  expect(job.match(/docker buildx bake/g)).toHaveLength(1);
  expect(job).toContain("for image in server gateway; do");
  expect(job).toContain(
    'docker buildx bake --allow="fs.write=$LYX_SOURCE_MAPS_DIR" -f infra/docker/source-maps.hcl --progress plain "$image-bundle"',
  );
  expect(job).not.toMatch(
    /BUILDX_BAKE_ENTITLEMENTS_FS|fs\.write=(?:\*|\/(?:tmp|private)(?:["\s]|$))/,
  );
  expect(job).toContain(
    'docker image inspect "liyoxi/server:$TAG" "liyoxi/gateway:$TAG" > "$LYX_SOURCE_MAPS_DIR/images.json"',
  );
  expect(job).toContain('source-maps.mjs finalize "$LYX_SOURCE_MAPS_DIR" "$GITHUB_SHA" "$TAG"');
  expect(job).toContain('source-maps.mjs verify "$LYX_SOURCE_MAPS_DIR" "$GITHUB_SHA" "$TAG"');
  expect(job.indexOf("docker image inspect")).toBeLessThan(job.indexOf("source-maps.mjs finalize"));
  expect(job.indexOf("source-maps.mjs finalize")).toBeLessThan(
    job.indexOf("source-maps.mjs verify"),
  );
  expect(job.indexOf("source-maps.mjs verify")).toBeLessThan(job.indexOf("docker save"));
  expect(job).toContain("path: ${{ runner.temp }}/images-out/");
  expect(job).toContain('tar -czf "$RUNNER_TEMP/images-out/weapp.tar.gz" -C apps/weapp/dist .');
  expect(job).not.toContain("path: ${{ env.LYX_SOURCE_MAPS_DIR }}");
  const pack = job
    .split("      - name: 打包同一源码的构建产物\n")[1]!
    .split("      - name: 保存构建产物")[0]!;
  expect(pack).not.toContain("LYX_SOURCE_MAPS_DIR");
  const cleanup = job.split("      - name: 只清本轮私有映射（上传未配置且未实现）\n")[1]!;
  expect(cleanup).toContain("if: always()");
  expect(cleanup).toContain('if [ -n "${LYX_SOURCE_MAPS_DIR:-}" ]; then');
  expect(cleanup).toContain('node infra/deploy/source-maps.mjs cleanup "$LYX_SOURCE_MAPS_DIR"');
  expect(cleanup).not.toMatch(/rm\s/);
  expect(job).not.toMatch(/secrets\.|sentry-cli|inject|docker (?:push|login)|continue-on-error/);
}

it("私有映射接线绑定同源码、仅授权自有root、校验后公开打包且失败仍精确清理，反例必须拒绝", () => {
  checkWiring(body);
  for (const invalid of [
    body.replace("if: always()", "if: success()"),
    body.replace("source-maps.mjs verify", "source-maps.mjs inspect-only"),
    body.replace("fs.write=$LYX_SOURCE_MAPS_DIR", "fs.write=*"),
    body.replace("path: ${{ runner.temp }}/images-out/", "path: ${{ env.LYX_SOURCE_MAPS_DIR }}"),
    body.replace('source-maps.mjs init "$RUNNER_TEMP"', 'source-maps.mjs init "/tmp"'),
  ])
    expect(() => checkWiring(invalid)).toThrow();
});
