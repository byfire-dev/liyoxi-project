import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, it } from "vitest";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import { createNotices } from "../config/index.js";
import { assembleProviders, createTxRunner } from "../kernel/index.js";
import { runDemoSeed } from "../demo-seed.js";
import type { ObjectRef } from "../providers/types.js";
import {
  assembleForTest,
  createClock,
  useSeededDatabase,
  TEST_KEYRING,
  createRecordingLogger,
} from "../testing/index.js";
import { createMedia, findI14Violations } from "./index.js";
const db = useSeededDatabase("services");
const clock = createClock();
const storage = assembleProviders({ appEnv: "test", logger: createRecordingLogger() }).storage;
const run = `w107-seed-${randomUUID()}`;
const objects: ObjectRef[] = [];
let deps: Parameters<typeof runDemoSeed>[0];
beforeAll(async () => {
  const prisma = await db.prisma();
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const assembly = assembleForTest({ entry: "worker" });
  const events = createEvents({ tx, clock, assembly });
  const flow = createFlow({ assembly, clock, events });
  const media = createMedia({ tx, clock, assembly, events, storage });
  const put = media.putSystemFile;
  media.putSystemFile = (input) => {
    const scoped = { ...input, objectKey: `legal_doc/${run}/${input.objectKey.split("/").at(-1)}` };
    objects.push({ bucket: "secure", key: scoped.objectKey });
    return put(scoped);
  };
  deps = {
    tx,
    clock,
    flow,
    appEnv: "test",
    media,
    notices: createNotices({ clock, events }),
    keyring: TEST_KEYRING,
  };
}, 180_000);
afterAll(async () => {
  for (const object of objects) await storage.delete(object);
  (storage as typeof storage & { close(): void }).close();
});
it("六PDF真实入库+六协议+12引用，演示播种两次零重复，prod拒绝", { timeout: 180_000 }, async () => {
  await expect(runDemoSeed({ ...deps, appEnv: "prod" })).rejects.toThrow(/prod/);
  const first = await runDemoSeed(deps);
  expect(first.tables.find((table) => table.table === "file_object")).toMatchObject({
    inserted: 6,
  });
  expect(first.tables.find((table) => table.table === "agreement_version")).toMatchObject({
    inserted: 6,
  });
  const prisma = await db.prisma();
  const files = await prisma.fileObject.findMany({
    where: { objectKey: { startsWith: `legal_doc/${run}/` } },
  });
  expect(files).toHaveLength(6);
  for (const file of files) {
    expect(file).toMatchObject({
      status: "stored",
      uploadActorType: "system",
      mime: "application/pdf",
      originalName: null,
    });
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
  expect(
    await prisma.fileRef.count({
      where: { fileId: { in: files.map((file) => file.id) }, state: "live" },
    }),
  ).toBe(12);
  expect((await runDemoSeed(deps)).inserted).toBe(0);
  expect(await deps.tx.run(findI14Violations)).toEqual([]);
});
