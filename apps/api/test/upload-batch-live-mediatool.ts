// Task-private host501 ↔ sandbox1000 byte transport. No media result is fabricated here.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { once } from "node:events";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIRECTORY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[1-9][0-9]{0,5}-[A-Za-z0-9]{6}$/;
const FILES = new Set(["source.mp4", "stamped.mp4", "poster.jpg", "watermark.png"]);
const FILE_LIMIT = 201 * 1024 * 1024;
type Json = Record<string, unknown>;
type Reply = { status: number; headers: Record<string, string>; body: Buffer };
type Call = {
  directory: string;
  instance?: string;
  confirmed: boolean;
  abort: AbortController;
  cancelReply?: Promise<Reply>;
  finished: Promise<void>;
};
function object(value: unknown): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("W302 transport expected an object");
  return value as Json;
}
function relative(value: unknown) {
  if (typeof value !== "string") throw new Error("W302 transport expected a relative path");
  const [directory, name, extra] = value.split("/");
  if (!directory || !name || extra !== undefined || !DIRECTORY.test(directory) || !FILES.has(name))
    throw new Error("W302 transport rejected a path");
  return { directory, name, path: value };
}
async function boundedBody(request: http.IncomingMessage) {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    const bytes: Buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += bytes.length;
    if (size > 64 * 1024) throw new Error("W302 transport request exceeded 64KiB");
    parts.push(bytes);
  }
  return size ? object(JSON.parse(Buffer.concat(parts).toString("utf8"))) : undefined;
}

export async function createOutputBatchMediaToolRelay(options: { runId: string; image: string }) {
  if (!/^[a-f0-9]{16}$/.test(options.runId) || !/^sha256:[a-f0-9]{64}$/.test(options.image))
    throw new Error("W302 transport requires an owned run and exact image ID");
  const root = await realpath(await mkdtemp(`/tmp/lyx-w302-tool-${options.runId}-`));
  const workDir = join(root, "work"),
    socketPath = join(workDir, ".sock", "mediatool.sock");
  await mkdir(workDir, { mode: 0o700 });
  await mkdir(join(workDir, ".sock"), { mode: 0o700 });
  const container = `lyx-w302-tool-${options.runId}`,
    volume = `${container}-work`;
  const script = await readFile(
    new URL("./upload-batch-live-mediatool-helper.mjs", import.meta.url),
    "utf8",
  );
  const children = new Set<ChildProcessWithoutNullStreams>(),
    calls = new Map<string, Call>();
  const directories = new Set<string>(),
    copied = new Map<string, { size: number; sha256: string }>();
  const attempts = new Map<string, AbortSignal>();
  const renderControllers = new Set<AbortController>();
  let renderTail: Promise<void> = Promise.resolve(),
    renderPeak = 0,
    rendering = 0;
  let closed = false,
    uncertain = false,
    created = false,
    mounted = false;
  let stopping: Promise<void> | undefined;
  const start = (args: string[]) => {
    const child = spawn("docker", args, { stdio: "pipe" });
    children.add(child);
    const completion = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        children.delete(child);
        if (code === 0) resolve();
        else reject(new Error("W302 owned Docker command failed"));
      });
    });
    // Attach immediately: transport errors are still awaited by each operation below.
    void completion.catch(() => undefined);
    child.stderr.on("data", (bytes: Buffer) => {
      // The fixed helper prints only mode/code. Never copy arbitrary Docker stderr or requests.
      const line = bytes.toString("utf8");
      if (line.startsWith('{"evt":"w302.tool.helper.failed",') && line.length <= 256)
        process.stderr.write(line);
    });
    return { child, completion };
  };
  const command = async (args: string[], limit = 64 * 1024) => {
    const { child, completion } = start(args);
    child.stdin.end();
    const parts: Buffer[] = [];
    let size = 0;
    try {
      for await (const part of child.stdout) {
        size += part.length;
        if (size > limit) throw new Error("W302 Docker response exceeded its budget");
        parts.push(part);
      }
      await completion;
      return Buffer.concat(parts).toString("utf8");
    } catch (error) {
      child.kill("SIGTERM");
      await completion.catch(() => undefined);
      throw error;
    }
  };
  const helper = (mode: string, argument: Json) =>
    start([
      "exec",
      "-i",
      "--user",
      "1000:1000",
      container,
      "node",
      "--input-type=module",
      "-e",
      script,
      mode,
      JSON.stringify(argument),
    ]);
  const waitForListening = async () => {
    const { child, completion } = start(["logs", "--follow", container]);
    child.stdin.end();
    let buffered = "";
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error("W302 original startup was not confirmed")),
          10_000,
        );
        const fail = () => {
          clearTimeout(deadline);
          reject(new Error("W302 original service exited before listening"));
        };
        child.once("close", fail);
        child.stdout.on("data", (bytes: Buffer) => {
          buffered += bytes.toString("utf8");
          if (buffered.length > 8 * 1024) {
            clearTimeout(deadline);
            reject(new Error("W302 startup log budget exceeded"));
            return;
          }
          for (const line of buffered.split("\n")) {
            try {
              const event = object(JSON.parse(line));
              if (
                event.listening === "/work/.sock/mediatool.sock" &&
                event.ffmpeg === "5.1.9-0+deb12u1" &&
                event.ffprobe === "5.1.9-0+deb12u1"
              ) {
                clearTimeout(deadline);
                child.removeListener("close", fail);
                resolve();
              }
            } catch {
              /* An incomplete log line is kept until its next chunk. */
            }
          }
        });
      });
    } finally {
      child.kill("SIGTERM"); // This is only the read-only log follower, never an exec/tool process.
      await completion.catch(() => undefined);
    }
  };
  const stopUnconfirmedHelper = (child: ChildProcessWithoutNullStreams) => {
    if (child.exitCode === null && child.signalCode === null) {
      // Docker CLI termination alone cannot attest the remote exec's exit.
      uncertain = true;
      child.kill("SIGTERM");
    }
  };
  const helperJson = async (mode: string, argument: Json) => {
    const { child, completion } = helper(mode, argument);
    child.stdin.end();
    const parts: Buffer[] = [];
    let size = 0;
    try {
      for await (const part of child.stdout) {
        size += part.length;
        if (size > 64 * 1024) throw new Error("W302 helper response exceeded its budget");
        parts.push(part);
      }
      await completion;
      return object(JSON.parse(Buffer.concat(parts).toString("utf8")));
    } catch (error) {
      stopUnconfirmedHelper(child);
      await completion.catch(() => undefined);
      throw error;
    }
  };
  const hostFile = async (path: string) => {
    const { directory } = relative(path),
      absolute = join(workDir, path),
      parent = join(workDir, directory);
    if ((await realpath(parent)) !== parent || (await realpath(absolute)) !== absolute)
      throw new Error("W302 host symlink rejected");
    const parentStat = await lstat(parent),
      before = await lstat(absolute);
    if (
      !parentStat.isDirectory() ||
      (parentStat.mode & 0o077) !== 0 ||
      parentStat.uid !== process.getuid?.() ||
      !before.isFile() ||
      before.uid !== parentStat.uid ||
      (before.mode & 0o077) !== 0 ||
      before.size < 1 ||
      before.size > FILE_LIMIT
    )
      throw new Error("W302 host owner/mode/size rejected");
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const actual = await handle.stat();
    if (!actual.isFile() || actual.ino !== before.ino || actual.dev !== before.dev) {
      await handle.close();
      throw new Error("W302 host input changed");
    }
    return { handle, before, absolute };
  };
  const transferInput = async (path: string, signal: AbortSignal, generatedPng = false) => {
    const { name } = relative(path);
    if (
      name !== "source.mp4" &&
      !(generatedPng && name === "watermark.png") &&
      (name !== "stamped.mp4" || !copied.has(path))
    )
      throw new Error("W302 input lacks original output provenance");
    const file = await hostFile(path);
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(64 * 1024);
    try {
      for (;;) {
        signal.throwIfAborted();
        const { bytesRead } = await file.handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
      const proof = { size: file.before.size, sha256: hash.digest("hex") },
        existing = copied.get(path);
      if (existing) {
        if (existing.size !== proof.size || existing.sha256 !== proof.sha256)
          throw new Error("W302 attempt input changed between operations");
        const actual = await helperJson("stat", { path });
        if (actual.size !== proof.size || actual.sha256 !== proof.sha256)
          throw new Error("W302 remote attempt input changed");
        return;
      }
      const { child, completion } = helper("put", { path, ...proof });
      let result = "";
      child.stdout.on("data", (bytes: Buffer) => {
        result += bytes.toString("utf8");
        if (result.length > 1024) child.kill("SIGTERM");
      });
      child.stdin.on("error", () => undefined);
      // EOF makes the fixed helper finish its own size check; killing only Docker CLI
      // would not prove that the container-side writer has stopped.
      const abort = () => child.stdin.end();
      signal.addEventListener("abort", abort, { once: true });
      try {
        let offset = 0;
        for (;;) {
          signal.throwIfAborted();
          const { bytesRead } = await file.handle.read(buffer, 0, buffer.length, offset);
          if (!bytesRead) break;
          offset += bytesRead;
          if (!child.stdin.write(buffer.subarray(0, bytesRead)))
            await once(child.stdin, "drain", { signal });
        }
        child.stdin.end();
        await completion;
        signal.throwIfAborted();
        const remote = object(JSON.parse(result)),
          after = await file.handle.stat();
        if (
          remote.size !== proof.size ||
          remote.sha256 !== proof.sha256 ||
          after.size !== proof.size ||
          after.mtimeMs !== file.before.mtimeMs ||
          (await realpath(file.absolute)) !== file.absolute
        )
          throw new Error("W302 input transfer proof mismatch");
        copied.set(path, proof);
      } catch (error) {
        child.stdin.end();
        await completion.catch(() => undefined);
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    } finally {
      await file.handle.close();
    }
  };
  const transferOutput = async (path: string, maximum: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    const proof = await helperJson("stat", { path });
    if (
      typeof proof.size !== "number" ||
      !Number.isSafeInteger(proof.size) ||
      proof.size < 1 ||
      proof.size > maximum ||
      typeof proof.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(proof.sha256)
    )
      throw new Error("W302 output byte proof rejected");
    const { directory } = relative(path),
      parent = join(workDir, directory),
      destination = join(workDir, path);
    if ((await realpath(parent)) !== parent) throw new Error("W302 output parent changed");
    const handle = await open(
      destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
      0o600,
    );
    const { child, completion } = helper("get", { path });
    child.stdin.end();
    let size = 0;
    const hash = createHash("sha256");
    try {
      for await (const bytes of child.stdout) {
        size += bytes.length;
        if (size > proof.size) throw new Error("W302 output transfer exceeded its budget");
        // On cancellation stop host writes, but drain the bounded fixed helper so its
        // real exit is observed before cancellation acknowledgement or cleanup.
        if (signal.aborted) continue;
        hash.update(bytes);
        for (let offset = 0; offset < bytes.length;) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
          if (!bytesWritten) throw new Error("W302 output write stalled");
          offset += bytesWritten;
        }
      }
      await completion;
      signal.throwIfAborted();
      await handle.sync();
      if (
        size !== proof.size ||
        hash.digest("hex") !== proof.sha256 ||
        (await handle.stat()).size !== size ||
        (await realpath(destination)) !== destination
      )
        throw new Error("W302 output transfer proof mismatch");
      copied.set(path, { size, sha256: proof.sha256 });
    } catch (error) {
      stopUnconfirmedHelper(child);
      await completion.catch(() => undefined);
      throw error;
    } finally {
      await handle.close();
    }
  };
  const exchange = async (
    method: string,
    path: string,
    body: Json | undefined,
    callId: string | undefined,
    information?: (headers: Record<string, string>) => void,
  ): Promise<Reply> => {
    const { child, completion } = helper("http", { method, path, body, callId });
    child.stdin.end();
    let buffered = "",
      reply: Reply | undefined;
    try {
      for await (const bytes of child.stdout) {
        buffered += bytes.toString("utf8");
        if (buffered.length > 6 * 1024 * 1024)
          throw new Error("W302 transport frame exceeded its budget");
        let newline: number;
        while ((newline = buffered.indexOf("\n")) !== -1) {
          const frame = object(JSON.parse(buffered.slice(0, newline)));
          buffered = buffered.slice(newline + 1);
          const rawHeaders = object(frame.headers),
            headers: Record<string, string> = {};
          for (const key of ["content-type", "x-lyx-call-id", "x-lyx-instance", "x-lyx-complete"])
            if (typeof rawHeaders[key] === "string") headers[key] = rawHeaders[key];
          if (frame.kind === "information" && frame.status === 102) information?.(headers);
          else if (
            frame.kind === "response" &&
            typeof frame.status === "number" &&
            typeof frame.body === "string"
          ) {
            if (reply) throw new Error("W302 duplicate final response");
            reply = { status: frame.status, headers, body: Buffer.from(frame.body, "base64") };
            if (reply.body.length > 4 * 1024 * 1024)
              throw new Error("W302 tool response exceeded its budget");
          } else throw new Error("W302 invalid transport frame");
        }
      }
      await completion;
      if (!reply || buffered.length) throw new Error("W302 incomplete original response");
      return reply;
    } catch (error) {
      stopUnconfirmedHelper(child);
      await completion.catch(() => undefined);
      throw error;
    }
  };
  const cancel = async (requestId: string, instanceId: string) => {
    const reply = await exchange("POST", "/cancel", { requestId, instanceId }, undefined);
    const ack = object(JSON.parse(reply.body.toString("utf8")));
    if (
      reply.status !== 200 ||
      ack.requestId !== requestId ||
      ack.instanceId !== instanceId ||
      ack.done !== true
    )
      throw new Error("W302 original cancellation not confirmed");
    return reply;
  };
  const cancelCall = (id: string, call: Call) => {
    call.abort.abort();
    if (call.instance) {
      call.cancelReply ??= cancel(id, call.instance);
      void call.cancelReply.catch(() => undefined);
    }
    return call.cancelReply;
  };
  const send = (response: http.ServerResponse, reply: Reply) => {
    if (response.destroyed) return;
    response.writeHead(reply.status, { ...reply.headers, "content-length": reply.body.length });
    response.end(reply.body);
  };
  const server = http.createServer((request, response) => {
    const run = async () => {
      if (closed) throw new Error("W302 relay closed");
      const body = await boundedBody(request),
        path = request.url,
        method = request.method;
      if (path === "/cancel" && method === "POST" && body) {
        if (
          typeof body.requestId !== "string" ||
          typeof body.instanceId !== "string" ||
          !UUID.test(body.requestId) ||
          !UUID.test(body.instanceId)
        )
          throw new Error("Invalid cancel proof");
        const call = calls.get(body.requestId);
        if (!call || call.instance !== body.instanceId)
          throw new Error("Cancel is outside this relay");
        const reply = await cancelCall(body.requestId, call);
        await call.finished; // Original done and every byte transport must close before ACK.
        if (!reply || !call.confirmed)
          throw new Error("W302 transfer completion was not confirmed");
        return send(response, reply);
      }
      if (path === "/healthz" && method === "GET")
        return send(response, await exchange(method, path, undefined, undefined));
      if (
        method !== "POST" ||
        !body ||
        !path ||
        !["/probe", "/poster", "/stampAigc", "/watermarkPng"].includes(path)
      )
        throw new Error("W302 unknown tool request");
      const callId = request.headers["x-lyx-call-id"];
      if (typeof callId !== "string" || !UUID.test(callId) || calls.has(callId))
        throw new Error("Invalid call ID");
      const input = body.path === undefined ? undefined : relative(body.path),
        output = body.outPath === undefined ? undefined : relative(body.outPath);
      const directory = input?.directory ?? output?.directory;
      if (!directory || (input && output && input.directory !== output.directory))
        throw new Error("Mixed attempt paths");
      if (
        path === "/probe" &&
        (!input ||
          (input.name !== "source.mp4" &&
            !(input.name === "stamped.mp4" && copied.has(input.path))) ||
          output)
      )
        throw new Error("Invalid probe paths");
      if (path === "/poster" && (!input || output?.name !== "poster.jpg"))
        throw new Error("Invalid poster paths");
      if (path === "/stampAigc" && (input?.name !== "source.mp4" || output?.name !== "stamped.mp4"))
        throw new Error("Invalid stamp paths");
      if (path === "/watermarkPng" && (input || output?.name !== "watermark.png"))
        throw new Error("Invalid watermark path");
      let finish!: () => void;
      const call: Call = {
        directory,
        confirmed: false,
        abort: new AbortController(),
        finished: new Promise<void>((resolve) => {
          finish = resolve;
        }),
      };
      calls.set(callId, call);
      directories.add(directory);
      const signal = attempts.get(directory),
        abort = () => {
          cancelCall(callId, call);
        };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const disconnected = () => {
        if (!response.writableFinished) abort();
      };
      response.once("close", disconnected);
      try {
        if (input) await transferInput(input.path, call.abort.signal);
        else await helperJson("prepare", { directory });
        call.abort.signal.throwIfAborted();
        const reply = await exchange(method, path, body, callId, (headers) => {
          const instance = headers["x-lyx-instance"];
          if (
            headers["x-lyx-call-id"] !== callId ||
            !instance ||
            !UUID.test(instance) ||
            (call.instance && instance !== call.instance)
          )
            throw new Error("Invalid original 102");
          call.instance = instance;
          if (!response.destroyed) response.writeInformation(102, headers);
          if (call.abort.signal.aborted) cancelCall(callId, call);
        });
        const instance = reply.headers["x-lyx-instance"];
        if (
          reply.headers["x-lyx-call-id"] !== callId ||
          reply.headers["x-lyx-complete"] !== "1" ||
          !instance ||
          !UUID.test(instance) ||
          (call.instance && instance !== call.instance)
        )
          throw new Error("Original tool completion not confirmed");
        const result = object(JSON.parse(reply.body.toString("utf8")));
        if (result.ok === true && output) {
          const maximum =
            output.name === "stamped.mp4"
              ? (copied.get(input!.path)?.size ?? 0) + 1024 * 1024
              : 1024 * 1024;
          await transferOutput(output.path, maximum, call.abort.signal);
        }
        call.confirmed = true;
        send(response, reply);
      } catch (error) {
        if (call.cancelReply) {
          await call.cancelReply;
          call.confirmed = true;
        }
        if (!call.confirmed) uncertain = true;
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
        response.removeListener("close", disconnected);
        finish();
      }
    };
    void run().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown";
      process.stderr.write(
        `${JSON.stringify({
          evt: "w302.tool.relay.failed",
          reason: /^(W302|Invalid|Original|Mixed|Cancel)/.test(message)
            ? message
            : "transport_error",
        })}\n`,
      );
      if (!response.destroyed) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            error: { code: "internal", message: "W302 private transport incomplete" },
          }),
        );
      }
    });
  });
  const releaseDirectory = async (directory: string) => {
    if (!DIRECTORY.test(directory)) throw new Error("Unknown owned directory");
    // A download can fail before the original tool was called; no remote attempt then exists.
    if (!directories.has(directory)) return;
    if (uncertain) throw new Error("W302 retains directories after unconfirmed exec transport");
    const ownedCalls = [...calls.entries()].filter(([, call]) => call.directory === directory);
    await Promise.all(ownedCalls.map(([, call]) => call.finished));
    if (ownedCalls.some(([, call]) => !call.confirmed))
      throw new Error("W302 retains an unconfirmed directory");
    await helperJson("cleanup", { directory });
    directories.delete(directory);
    for (const [id] of ownedCalls) calls.delete(id);
    for (const path of copied.keys()) if (path.startsWith(`${directory}/`)) copied.delete(path);
  };
  // Private live codec only. The original four mediatool operations and their IPC stay intact.
  const renderSample = (input: {
    path: string;
    outPath: string;
    png: Uint8Array;
    signal: AbortSignal;
  }) => {
    const controller = new AbortController(),
      previous = renderTail;
    renderControllers.add(controller);
    const signal = AbortSignal.any([input.signal, controller.signal]);
    const operation = (async () => {
      await previous;
      signal.throwIfAborted();
      if (closed) throw new Error("W302 relay closed");
      const source = relative(input.path),
        output = relative(input.outPath);
      if (
        source.name !== "source.mp4" ||
        output.name !== "stamped.mp4" ||
        source.directory !== output.directory ||
        input.png.length < 8 ||
        input.png.length > 1024 * 1024 ||
        Buffer.from(input.png.subarray(0, 8)).toString("hex") !== "89504e470d0a1a0a"
      )
        throw new Error("W302 sample render scope rejected");
      const directory = source.directory,
        pngPath = `${directory}/watermark.png`;
      directories.add(directory);
      const png = await open(
        join(workDir, pngPath),
        constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
        0o600,
      );
      try {
        await png.writeFile(input.png);
        await png.sync();
      } finally {
        await png.close();
      }
      await transferInput(source.path, signal);
      await transferInput(pngPath, signal, true);
      const name = `lyx-w307-render-${options.runId}-${randomUUID()}`;
      let execution: ReturnType<typeof start> | undefined, removal: Promise<string> | undefined;
      const remove = () => (removal ??= command(["rm", "--force", name]));
      const abort = () => {
        void remove().catch(() => undefined);
      };
      rendering++;
      renderPeak = Math.max(renderPeak, rendering);
      try {
        await command([
          "create",
          "--name",
          name,
          "--label",
          `lyx.w302.run=${options.runId}`,
          "--network",
          "none",
          "--read-only",
          "--user",
          "1000:1000",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--pids-limit",
          "128",
          "--memory",
          "1g",
          "--cpus",
          "1",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=64m",
          "--mount",
          `type=volume,source=${volume},target=/work`,
          "--entrypoint",
          "ffmpeg",
          options.image,
          "-nostdin",
          "-v",
          "error",
          "-threads",
          "1",
          "-filter_complex_threads",
          "1",
          "-i",
          `/work/${source.path}`,
          "-loop",
          "1",
          "-i",
          `/work/${pngPath}`,
          "-filter_complex",
          "[0:v]scale=720:1280[base];[1:v]format=rgba,colorchannelmixer=aa=0.7[mark];[base][mark]overlay=(W-w)/2:(H-h)/2:shortest=1[out]",
          "-map",
          "[out]",
          "-map",
          "0:a:0",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-profile:v",
          "high",
          "-pix_fmt",
          "yuv420p",
          "-threads",
          "1",
          "-c:a",
          "copy",
          "-movflags",
          "+faststart",
          "-n",
          `/work/${output.path}`,
        ]);
        // Cancellation is registered only after create confirms this exact owned container.
        signal.addEventListener("abort", abort, { once: true });
        signal.throwIfAborted();
        execution = start(["start", "--attach", name]);
        execution.child.stdin.end();
        execution.child.stdout.resume();
        await execution.completion;
        signal.throwIfAborted();
        await transferOutput(output.path, FILE_LIMIT, signal);
      } finally {
        signal.removeEventListener("abort", abort);
        try {
          await remove();
        } catch {
          uncertain = true;
        }
        if (execution) await execution.completion.catch(() => undefined);
        rendering--;
      }
    })();
    renderTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation.finally(() => renderControllers.delete(controller));
  };
  const close = () =>
    (stopping ??= (async () => {
      closed = true;
      for (const controller of renderControllers) controller.abort();
      await renderTail;
      await Promise.allSettled(
        [...calls].map(async ([id, call]) => {
          if (!call.confirmed) await cancelCall(id, call);
          await call.finished;
        }),
      );
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (children.size) {
        uncertain = true;
        for (const child of children) child.kill("SIGTERM");
        await Promise.allSettled([...children].map((child) => once(child, "close")));
      }
      if (created) await command(["rm", "--force", container]);
      if (!uncertain && directories.size === 0) {
        if (mounted) await command(["volume", "rm", volume]);
        await rm(root, { recursive: true });
      } else {
        process.stderr.write(
          `${JSON.stringify({ evt: "w302.tool.retained", root, volume, directories: [...directories] })}\n`,
        );
        throw new Error("W302 unconfirmed tool workspace retained");
      }
    })());
  try {
    const imageInspection: unknown = JSON.parse(await command(["image", "inspect", options.image]));
    if (!Array.isArray(imageInspection) || imageInspection.length !== 1)
      throw new Error("Pinned image is unavailable");
    const image = object(imageInspection[0]),
      imageConfig = object(image.Config);
    await command(["volume", "create", "--label", `lyx.w302.run=${options.runId}`, volume]);
    mounted = true;
    await command([
      "create",
      "--name",
      container,
      "--label",
      `lyx.w302.run=${options.runId}`,
      "--network",
      "none",
      "--read-only",
      "--user",
      "1000:1000",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--pids-limit",
      "128",
      "--memory",
      "1g",
      "--cpus",
      "1",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--mount",
      `type=volume,source=${volume},target=/work`,
      options.image,
    ]);
    created = true;
    await command(["start", container]);
    const inspection: unknown = JSON.parse(await command(["inspect", container]));
    if (!Array.isArray(inspection) || inspection.length !== 1)
      throw new Error("Invalid owned inspection");
    const inspected = object(inspection[0]),
      config = object(inspected.Config),
      host = object(inspected.HostConfig);
    const state = object(inspected.State),
      temporary = object(host.Tmpfs);
    if (
      inspected.Image !== image.Id ||
      state.Running !== true ||
      JSON.stringify(config.Env) !== JSON.stringify(imageConfig.Env) ||
      JSON.stringify(config.Cmd) !== JSON.stringify(["node", "/app/server.mjs"]) ||
      config.User !== "1000:1000" ||
      host.NetworkMode !== "none" ||
      host.ReadonlyRootfs !== true ||
      host.Memory !== 1024 ** 3 ||
      host.NanoCpus !== 1e9 ||
      host.PidsLimit !== 128 ||
      !Array.isArray(host.CapDrop) ||
      !host.CapDrop.includes("ALL") ||
      !Array.isArray(host.SecurityOpt) ||
      !host.SecurityOpt.includes("no-new-privileges:true") ||
      temporary["/tmp"] !== "rw,noexec,nosuid,size=64m" ||
      Object.keys(temporary).length !== 1 ||
      !Array.isArray(inspected.Mounts) ||
      inspected.Mounts.length !== 1
    )
      throw new Error("Original mediatool sandbox differs");
    const mount = object(inspected.Mounts[0]);
    if (
      mount.Type !== "volume" ||
      mount.Name !== volume ||
      mount.Destination !== "/work" ||
      mount.RW !== true
    )
      throw new Error("Original mediatool volume differs");
    await waitForListening();
    const health = await exchange("GET", "/healthz", undefined, undefined);
    if (health.status !== 200 || object(JSON.parse(health.body.toString("utf8"))).ok !== true)
      throw new Error("W302 original startup health was not confirmed");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600); // Only this owned socket, never the workspace or a shared ACL.
    const bindAttempt = (directory: string, signal: AbortSignal) => {
      if (closed || !DIRECTORY.test(directory) || attempts.has(directory))
        throw new Error("W302 invalid attempt cancellation scope");
      attempts.set(directory, signal);
      return () => {
        if (attempts.get(directory) === signal) attempts.delete(directory);
      };
    };
    return {
      workDir,
      socketPath,
      bindAttempt,
      releaseDirectory,
      renderSample,
      close,
      resources: {
        root,
        container,
        volume,
        image: options.image,
        renderState: () => ({
          active: rendering,
          peak: renderPeak,
          pending: renderControllers.size,
        }),
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
