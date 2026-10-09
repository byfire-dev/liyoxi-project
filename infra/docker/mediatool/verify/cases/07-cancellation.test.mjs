// @ts-check
import http from "node:http";
import assert from "node:assert/strict";
import test from "node:test";
/** @typedef {{status: number, json: any}} Reply */
/** @typedef {{requestId: string, registration: Promise<string>, result: Promise<Reply>, abort: () => void}} Operation */
const socketPath = "/work/.sock/mediatool.sock";
/** @param {string} path @param {unknown} body */
function post(path, body) {
  /** @type {http.ClientRequest | undefined} */
  let req;
  /** @type {Promise<Reply>} */
  const promise = new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    req = http.request(
      {
        socketPath,
        path,
        method: "POST",
        agent: false,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
  return {
    promise,
    abort: () => {
      req?.destroy();
    },
  };
}
/** @returns {Promise<any>} */
function health() {
  return new Promise((resolve, reject) => {
    http
      .get({ socketPath, path: "/healthz", agent: false }, (r) => {
        let text = "";
        r.on("data", (c) => (text += c));
        r.on("end", () => resolve(JSON.parse(text)));
      })
      .on("error", reject);
  });
}
/** @param {any} h @returns {{pid: number, comm: string}[]} */
const media = (h) =>
  (h.procs ?? []).filter((/** @type {{pid: number, comm: string}} */ p) =>
    ["ffmpeg", "ffprobe"].includes(p.comm),
  );
/** @param {(h: any) => boolean} fn @param {number} ms */
async function until(fn, ms) {
  const end = Date.now() + ms;
  let last;
  do {
    last = await health();
    if (fn(last)) return last;
    await new Promise((r) => setTimeout(r, 10));
  } while (Date.now() < end);
  return last;
}
test("运行中客户端真实断开之后本请求ffmpeg应被清理并释放槽位", { timeout: 10000 }, async () => {
  const call = post("/poster", {
    path: "fx/slow.mp4",
    demuxer: "mov",
    atMs: 119000,
    outPath: "fx/cancel-owned.jpg",
  });
  call.promise.catch(() => {});
  try {
    const started = await until((h) => h.stats.running === 1 && media(h).length === 1, 2000);
    assert.equal(started.stats.running, 1);
    assert.equal(media(started).length, 1, "必须真实观察ffmpeg而非空取消");
    const child = media(started)[0];
    assert.ok(child);
    const pid = child.pid;
    console.log(JSON.stringify({ phase: "real-child-before-abort", pid, stats: started.stats }));
    call.abort();
    const ended = await until(
      (h) => h.stats.running === 0 && !media(h).some((p) => p.pid === pid),
      1000,
    );
    console.log(
      JSON.stringify({ phase: "after-owned-disconnect", stats: ended.stats, media: media(ended) }),
    );
    assert.equal(ended.stats.running, 0, "断开后仍占并发槽");
    assert.equal(
      media(ended).some((p) => p.pid === pid),
      false,
      "断开后真实子进程仍在运行",
    );
  } finally {
    call.abort();
  }
});

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
/** @param {string} path @param {unknown} body @returns {Operation} */
function operation(path, body) {
  const requestId = randomUUID();
  /** @type {(value: string) => void} */
  let registered = () => undefined;
  /** @type {Promise<string>} */
  const registration = new Promise((resolve) => {
    registered = resolve;
  });
  /** @type {http.ClientRequest | undefined} */
  let req;
  /** @type {Promise<Reply>} */
  const result = new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    req = http.request(
      {
        socketPath,
        path,
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
          "x-lyx-call-id": requestId,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }));
      },
    );
    req.on("information", (info) => {
      if (info.statusCode === 102 && info.headers["x-lyx-call-id"] === requestId)
        registered(String(info.headers["x-lyx-instance"]));
    });
    req.on("error", reject);
    req.end(data);
  });
  result.catch(() => {});
  return {
    requestId,
    registration,
    result,
    abort: () => {
      req?.destroy();
    },
  };
}
/** @param {Operation} call @param {string} [instance] */
async function cancel(call, instance) {
  const res = await post("/cancel", {
    requestId: call.requestId,
    instanceId: instance ?? (await call.registration),
  }).promise;
  assert.equal(res.status, 200);
  assert.equal(res.json.done, true);
  assert.equal(res.json.requestId, call.requestId);
  return res;
}
test(
  "真实102/ACK等待子进程退出；取消queued不spawn、取消A不影响B且重复幂等",
  { timeout: 15000 },
  async () => {
    const a = operation("/poster", {
      path: "fx/slow.mp4",
      demuxer: "mov",
      atMs: 119000,
      outPath: "fx/cancel-a.jpg",
    });
    const b = operation("/poster", {
      path: "fx/slow.mp4",
      demuxer: "mov",
      atMs: 119000,
      outPath: "fx/cancel-b.jpg",
    });
    let queued;
    try {
      const [ia, ib] = await Promise.all([a.registration, b.registration]);
      assert.equal(ia, ib);
      const running = await until((h) => h.stats.running === 2 && media(h).length === 2, 2000);
      assert.equal(running.stats.running, 2);
      assert.equal(media(running).length, 2);
      queued = operation("/probe", { path: "fx/portrait.mp4", demuxers: ["mov"] });
      await queued.registration;
      const waiting = await until((h) => h.stats.queued === 1, 1000);
      assert.equal(waiting.stats.queued, 1);
      await cancel(queued);
      assert.equal((await queued.result).json.error.code, "killed");
      const afterQueue = await health();
      assert.equal(afterQueue.stats.queued, 0);
      assert.equal(afterQueue.stats.running, 2);
      assert.equal(media(afterQueue).length, 2);
      await cancel(a);
      assert.equal((await a.result).json.error.code, "killed");
      const afterA = await health();
      assert.equal(afterA.stats.running, 1);
      assert.equal(media(afterA).length, 1, "A ACK完成时其child已退出，B仍真实运行");
      await cancel(a);
      assert.equal((await health()).stats.running, 1, "重复A cancel不能误杀B");
      assert.equal((await b.result).status, 200, "B正常成功");
      const final = await health();
      assert.equal(final.stats.running, 0);
      assert.equal(final.stats.queued, 0);
      assert.deepEqual(media(final), []);
    } finally {
      await Promise.allSettled(
        [a, b, ...(queued ? [queued] : [])].map(async (call) => {
          await cancel(call);
          call.abort();
        }),
      );
      await Promise.all(
        ["cancel-a.jpg", "cancel-b.jpg", "cancel-owned.jpg"].map((name) =>
          rm("/work/fx/" + name, { force: true }),
        ),
      );
    }
  },
);
