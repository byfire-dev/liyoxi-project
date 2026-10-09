import { createHash } from "node:crypto";
import { mkdtemp, realpath, readdir, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeStorage } from "../../testing/index.js";
import { ok } from "../types.js";
import { createMediaWorkspace } from "./work-io.js";
import type { MediaWorkspace } from "./work-io.js";
const job = { id: "01900000-0000-7000-8000-000000000001", attemptNo: 1 };
const bytes = Buffer.from("owned media stream"),
  sha = createHash("sha256").update(bytes).digest("hex");
const identity = "1".repeat(64),
  directories: string[] = [],
  workspaces: MediaWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((one) => one.close()));
  await Promise.all(directories.splice(0).map((one) => rm(one, { recursive: true, force: true })));
});
async function fixture() {
  const workDir = await realpath(await mkdtemp("/tmp/lyx-w304-io-"));
  directories.push(workDir);
  const storage = createFakeStorage(),
    beforeCall = vi.fn(),
    workspace = createMediaWorkspace({ workDir, storage, beforeCall });
  workspaces.push(workspace);
  const ref = { bucket: "media" as const, key: "test/source.mp4" },
    etag = storage.put(ref, bytes, "video/mp4");
  return { workDir, storage, beforeCall, workspace, ref, etag };
}
describe("制作工作区真实文件边界", () => {
  it("条件流下载与固定键流上传写后HEAD，结束删除独占目录", async () => {
    const f = await fixture();
    const result = await f.workspace.run(job, new AbortController().signal, async (work) => {
      expect(work.path("source.mp4")).toMatch(
        new RegExp(`^${job.id}-1-[A-Za-z0-9]+/source\\.mp4$`),
      );
      expect(await work.download({ ...f.ref, size: bytes.length, etag: f.etag })).toEqual(
        ok({ size: bytes.length, sha256: sha }),
      );
      expect(await readFile(join(f.workDir, work.path("source.mp4")))).toEqual(bytes);
      return work.publish({
        name: "source.mp4",
        dst: { bucket: "media", key: "derived/out.mp4" },
        contentIdentity: identity,
      });
    });
    expect(result).toMatchObject({ ok: true, value: { size: bytes.length, sha256: sha } });
    expect(f.storage.callsOf("readTo")[0]!.input).toMatchObject({
      expectedSize: bytes.length,
      maxBytes: bytes.length,
      ifMatchEtag: f.etag,
    });
    expect(f.storage.callsOf("putStream")[0]!.input).toMatchObject({
      sha256: sha,
      size: bytes.length,
      ifAbsent: true,
    });
    expect(await readdir(f.workDir)).toEqual([]);
  });
  it("HEAD目标大小不符必须拒收，不把PUT成功当作对象验证", async () => {
    const f = await fixture(),
      original = f.storage.head;
    f.storage.head = async (input) => {
      const result = await original(input);
      return result.ok ? ok({ ...result.value, size: result.value.size + 1 }) : result;
    };
    const result = await f.workspace.run(job, new AbortController().signal, async (work) => {
      await work.download({ ...f.ref, size: bytes.length, etag: f.etag });
      return work.publish({
        name: "source.mp4",
        dst: { bucket: "media", key: "derived/bad.mp4" },
        contentIdentity: identity,
      });
    });
    expect(result).toMatchObject({ ok: false, reason: "rejected" });
    expect(await readdir(f.workDir)).toEqual([]);
  });
  it("客户端已校验的小产物被容器替换后不能上传，仅实际同hash/size可发布", async () => {
    const f = await fixture();
    const result = await f.workspace.run(job, new AbortController().signal, async (work) => {
      await writeFile(join(f.workDir, work.path("poster.jpg")), "replaced after validation");
      return work.publish({
        name: "poster.jpg",
        dst: { bucket: "asset", key: "covers/changed.jpg" },
        contentIdentity: identity,
        expectedSha256: sha,
        expectedSize: bytes.length,
      });
    });
    expect(result).toMatchObject({ ok: false, reason: "rejected" });
    expect(f.storage.callsOf("putStream")).toEqual([]);
    expect(await readdir(f.workDir)).toEqual([]);
  });
  it("产物符号链接不能被打开上传，外部字节保持不变", async () => {
    const f = await fixture(),
      outside = await realpath(await mkdtemp("/tmp/lyx-w304-out-"));
    directories.push(outside);
    const target = join(outside, "private");
    await writeFile(target, "external untouched");
    await expect(
      f.workspace.run(job, new AbortController().signal, async (work) => {
        await symlink(target, join(f.workDir, work.path("stamped.mp4")));
        return work.publish({
          name: "stamped.mp4",
          dst: { bucket: "media", key: "derived/symlink.mp4" },
          contentIdentity: identity,
        });
      }),
    ).rejects.toThrow("普通文件");
    expect(f.storage.callsOf("putStream")).toHaveLength(0);
    expect(await readFile(target, "utf8")).toBe("external untouched");
  });
  it("即使已取消也先调用外呼guard，guard异常不创建目录", async () => {
    const f = await fixture(),
      controller = new AbortController();
    controller.abort();
    const guard = vi.fn(() => {
      throw new Error("ancestor transaction");
    });
    const one = createMediaWorkspace({ workDir: f.workDir, storage: f.storage, beforeCall: guard });
    workspaces.push(one);
    expect(() => one.run(job, controller.signal, async () => {})).toThrow("ancestor transaction");
    expect(guard).toHaveBeenCalledOnce();
    expect(await readdir(f.workDir)).toEqual([]);
  });
  it("close取消在途自有I/O并等待真实finally；借用storage不关闭", async () => {
    const f = await fixture(),
      storageClose = vi.fn();
    Object.assign(f.storage, { close: storageClose });
    let entered!: () => void,
      cleaned = false;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.storage.readTo = async (input) => {
      entered();
      await new Promise<void>((resolve) =>
        input.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      await Promise.resolve();
      cleaned = true;
      return { ok: false, reason: "unavailable", message: "owned canceled" };
    };
    const pending = f.workspace.run(job, new AbortController().signal, (work) =>
      work.download({ ...f.ref, size: bytes.length, etag: f.etag }),
    );
    await ready;
    await f.workspace.close();
    expect(cleaned).toBe(true);
    expect(await pending).toMatchObject({ ok: false });
    expect(storageClose).not.toHaveBeenCalled();
    expect(await readdir(f.workDir)).toEqual([]);
    await expect(
      f.workspace.run(job, new AbortController().signal, async () => {}),
    ).rejects.toThrow("不可用");
  });
  it("原调用者abort传到storage后清理目录与listener", async () => {
    const f = await fixture(),
      controller = new AbortController(),
      remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = await f.workspace.run(job, controller.signal, async (work) => {
      controller.abort();
      return work.download({ ...f.ref, size: bytes.length, etag: f.etag });
    });
    expect(result).toMatchObject({ ok: false });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(await readdir(f.workDir)).toEqual([]);
  });
  it("action抛错也准确清理独占目录且不关闭另一workspace", async () => {
    const a = await fixture(),
      b = await fixture();
    await expect(
      a.workspace.run(job, new AbortController().signal, async () => {
        throw new Error("owned failure");
      }),
    ).rejects.toThrow("owned failure");
    await a.workspace.close();
    expect(await b.workspace.run(job, new AbortController().signal, async () => 7)).toBe(7);
    expect(await readdir(a.workDir)).toEqual([]);
    expect(await readdir(b.workDir)).toEqual([]);
  });
  it("同一个job的两会话使用不同目录且只能删除自身", async () => {
    const f = await fixture();
    let left!: () => void, entered!: () => void;
    const held = new Promise<void>((r) => {
        left = r;
      }),
      ready = new Promise<void>((r) => {
        entered = r;
      });
    let one = "",
      two = "";
    const a = f.workspace.run(job, new AbortController().signal, async (work) => {
      one = work.path("source.mp4");
      entered();
      await held;
    });
    try {
      await ready;
      await f.workspace.run(job, new AbortController().signal, async (work) => {
        two = work.path("source.mp4");
      });
      expect(one).not.toBe(two);
      expect(await readdir(f.workDir)).toEqual([one.split("/")[0]]);
    } finally {
      left();
      await a;
    }
    expect(await readdir(f.workDir)).toEqual([]);
  });
});
