// W302 private Docker-exec transport. This calls the original mediatool service, never ffmpeg.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import http from "node:http";
import { dirname, join } from "node:path";
import { once } from "node:events";

const [mode, argument] = process.argv.slice(1);
const options = JSON.parse(argument ?? "{}");
const directoryPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[1-9][0-9]{0,5}-[A-Za-z0-9]{6}$/;
const names = new Set(["source.mp4", "stamped.mp4", "poster.jpg", "watermark.png"]);
const maximum = 201 * 1024 * 1024;
const json = async (value) => {
  if (!process.stdout.write(`${JSON.stringify(value)}\n`)) await once(process.stdout, "drain");
};
function relative(value, directoryOnly = false) {
  if (typeof value !== "string") throw new Error("Invalid owned path");
  const parts = value.split("/");
  if (!directoryPattern.test(parts[0]) || parts.length !== (directoryOnly ? 1 : 2))
    throw new Error("Invalid owned directory");
  if (!directoryOnly && !names.has(parts[1])) throw new Error("Invalid owned file");
  return join("/work", ...parts);
}
async function prepare(path) {
  await mkdir(path, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await lstat(path);
  if (
    (await realpath(path)) !== path ||
    !stat.isDirectory() ||
    stat.uid !== 1000 ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("Invalid owned directory");
}
async function regular(value) {
  const path = relative(value);
  const parent = dirname(path);
  if ((await realpath(parent)) !== parent || (await realpath(path)) !== path)
    throw new Error("Symlink rejected");
  const before = await lstat(path);
  if (!before.isFile() || before.uid !== 1000 || before.size > maximum)
    throw new Error("Invalid owned input");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const actual = await handle.stat();
  if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino) {
    await handle.close();
    throw new Error("Input changed while opening");
  }
  return { path, handle, before };
}
async function chunks(handle, accept) {
  const bytes = Buffer.alloc(64 * 1024);
  let size = 0;
  const hash = createHash("sha256");
  for (;;) {
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, null);
    if (!bytesRead) break;
    size += bytesRead;
    if (size > maximum) throw new Error("File exceeded the transfer budget");
    const part = bytes.subarray(0, bytesRead);
    hash.update(part);
    await accept(part);
  }
  return { size, sha256: hash.digest("hex") };
}
async function statOrGet(get) {
  const { path, handle, before } = await regular(options.path);
  try {
    const measured = await chunks(handle, async (part) => {
      if (get && !process.stdout.write(part)) await once(process.stdout, "drain");
    });
    const after = await handle.stat();
    if (
      after.size !== measured.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      (await realpath(path)) !== path
    )
      throw new Error("File changed during transfer");
    if (!get) await json(measured);
  } finally {
    await handle.close();
  }
}
async function put() {
  const path = relative(options.path),
    parent = dirname(path);
  if (
    !Number.isSafeInteger(options.size) ||
    options.size < 1 ||
    options.size > maximum ||
    !/^[0-9a-f]{64}$/.test(options.sha256)
  )
    throw new Error("Invalid byte proof");
  await prepare(parent);
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  let size = 0;
  const hash = createHash("sha256");
  try {
    for await (const bytes of process.stdin) {
      size += bytes.length;
      if (size > options.size) throw new Error("Input exceeded its byte proof");
      hash.update(bytes);
      for (let offset = 0; offset < bytes.length;) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
        if (!bytesWritten) throw new Error("File write stalled");
        offset += bytesWritten;
      }
    }
    const sha256 = hash.digest("hex");
    await handle.sync();
    const stat = await handle.stat();
    if (
      size !== options.size ||
      stat.size !== size ||
      sha256 !== options.sha256 ||
      (await realpath(path)) !== path
    )
      throw new Error("Input byte proof mismatch");
    await json({ size, sha256 });
  } finally {
    await handle.close();
  }
}
async function exchange() {
  if (
    !["/probe", "/poster", "/stampAigc", "/watermarkPng", "/healthz", "/cancel"].includes(
      options.path,
    ) ||
    !["GET", "POST"].includes(options.method)
  )
    throw new Error("Unknown operation");
  const body = options.body === undefined ? "" : JSON.stringify(options.body);
  if (Buffer.byteLength(body) > 64 * 1024) throw new Error("Request budget exceeded");
  await new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: "/work/.sock/mediatool.sock",
        method: options.method,
        path: options.path,
        agent: false,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...(options.callId ? { "x-lyx-call-id": options.callId } : {}),
        },
      },
      (response) => {
        const parts = [];
        let size = 0;
        response.on("data", (part) => {
          size += part.length;
          if (size > 4 * 1024 * 1024) request.destroy(new Error("Response budget exceeded"));
          else parts.push(part);
        });
        response.on("error", reject);
        response.on("end", () => {
          void json({
            kind: "response",
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(parts).toString("base64"),
          }).then(resolve, reject);
        });
      },
    );
    request.on("information", (info) => {
      void json({ kind: "information", status: info.statusCode, headers: info.headers }).catch(
        reject,
      );
    });
    request.on("error", reject);
    request.setTimeout(options.path === "/stampAigc" ? 120_000 : 60_000, () =>
      request.destroy(new Error("Original transport timed out")),
    );
    request.end(body);
  });
}
try {
  if (mode === "put") await put();
  else if (mode === "stat") await statOrGet(false);
  else if (mode === "get") await statOrGet(true);
  else if (mode === "prepare") {
    const path = relative(options.directory, true);
    await prepare(path);
    await json({ prepared: true });
  } else if (mode === "cleanup") {
    const path = relative(options.directory, true);
    if ((await realpath(path)) !== path || (await lstat(path)).uid !== 1000)
      throw new Error("Invalid owned cleanup");
    await rm(path, { recursive: true });
    await json({ removed: true });
  } else if (mode === "http") await exchange();
  else throw new Error("Unknown transport command");
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      evt: "w302.tool.helper.failed",
      mode,
      code: typeof error.code === "string" ? error.code : "transport_error",
    })}\n`,
  );
  process.exitCode = 1;
}
