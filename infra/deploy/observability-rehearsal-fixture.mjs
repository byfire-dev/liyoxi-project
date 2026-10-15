// 仅本轮短命worker夹具：真实租约/事务/告警writer/派发/铃铛，受控采样不等于真实平台探针。
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createPrismaClient } from "../../packages/db/src/index.ts";
import { assembleServices } from "../../packages/services/src/assembly.ts";
import {
  assertNotInTransaction,
  createTxRunner,
  loadEnv,
} from "../../packages/services/src/kernel/index.ts";
import {
  createAlertDispatcher,
  createProbe,
  createWorkerLease,
} from "../../packages/services/src/ops/index.ts";
import { sendSystemAlert } from "../../packages/services/src/notify/index.ts";
import { createProviders } from "../../packages/services/src/providers/index.ts";

let stage = "identity";
async function main() {
  const [project, address, mode, dimension] = process.argv.slice(2);
  if (
    process.argv.length !== 6 ||
    !/^lyxrh-[a-f0-9]{6}$/.test(project) ||
    !/^172\.30\.(4[2-9]|5[0-7])\.\d{1,3}$/.test(address) ||
    !["tls", "alerts"].includes(mode) ||
    !new RegExp(`^${project}/obs-[a-f0-9]{6}$`).test(dimension)
  )
    throw new Error();
  const env = loadEnv();
  const url = new URL(env.DATABASE_URL);
  if (
    env.APP_ENV !== "stg" ||
    url.hostname !== "postgres" ||
    url.pathname !== "/liyoxi" ||
    process.env.NODE_EXTRA_CA_CERTS !== "/rehearsal/ca.pem" ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
  )
    throw new Error();
  stage = "tls";
  const response = await fetch("https://errors.lyx-rehearse.invalid/", {
    signal: AbortSignal.timeout(2_000),
    redirect: "error",
  });
  await response.body?.cancel();
  if (response.status !== 400) throw new Error();
  let wrongHostRejected = false;
  try {
    await fetch("https://wrong.lyx-rehearse.invalid/", {
      signal: AbortSignal.timeout(2_000),
      redirect: "error",
    });
  } catch (error) {
    wrongHostRejected = error?.cause?.code === "ERR_TLS_CERT_ALTNAME_INVALID";
  }
  const childEnv = { ...process.env };
  delete childEnv.NODE_EXTRA_CA_CERTS;
  const untrusted = spawnSync(
    process.execPath,
    [
      "-e",
      "fetch('https://errors.lyx-rehearse.invalid/',{signal:AbortSignal.timeout(2000)}).then(()=>process.exit(1),e=>process.exit(['UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','SELF_SIGNED_CERT_IN_CHAIN'].includes(e.cause?.code)?0:2))",
    ],
    { env: childEnv, timeout: 4_000, stdio: "ignore" },
  );
  if (!wrongHostRejected || untrusted.status !== 0) throw new Error();
  if (mode === "tls") return { tlsVerified: true, dimension };
  if (!env.ALERTS?.robotKey || env.ALERTS.robotKey !== `${project}_robot`) throw new Error();
  stage = "database";
  const db = createPrismaClient({ connectionString: env.DATABASE_URL, max: 2 });
  const lease = createWorkerLease({
    connectionString: env.DATABASE_URL,
    holder: `${project}:${randomUUID()}`,
    version: "observability-rehearsal",
  });
  const closers = [];
  let probe, dispatcher, renewing, renewal, result, failure;
  try {
    const [identity] = await db.$queryRawUnsafe(
      "SELECT current_database() AS name, host(inet_server_addr()) AS address",
    );
    if (identity.name !== "liyoxi" || identity.address !== address) throw new Error();
    stage = "lease";
    if (!(await lease.renew())) throw new Error();
    let held = true;
    renewing = setInterval(() => {
      if (renewal) return;
      renewal = lease
        .renew()
        .then(
          (value) => {
            held = value;
          },
          () => {
            held = false;
          },
        )
        .finally(() => {
          renewal = undefined;
        });
    }, 5_000);
    const holder = () => (held ? lease.holder : undefined);
    const clock = {
      at: new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z"),
      now() {
        return new Date(this.at);
      },
    };
    const logger = { info() {}, warn() {}, error() {} };
    const tx = createTxRunner({ prisma: db, appEnv: "stg" });
    const assembly = assembleServices({ entry: "worker", appEnv: "stg" });
    const providers = createProviders({
      appEnv: "stg",
      logger,
      settings: { wecomRobot: { key: env.ALERTS.robotKey } },
      beforeCall: (name) => assertNotInTransaction(`observability.${name}`),
      wecomRobot: { registerClose: (close) => closers.push(close) },
    });
    const disabled = createProviders({ appEnv: "stg", logger });
    let healthy = false;
    probe = createProbe({
      db,
      tx,
      clock,
      holder,
      logger,
      rules: [
        {
          key: "observability",
          targets: [{ rule: "webhook.backlog", dimension }],
          async sample() {
            return healthy
              ? []
              : [
                  {
                    rule: "webhook.backlog",
                    dimension,
                    severity: "P2",
                    detail: { controlledSample: true },
                  },
                ];
          },
        },
      ],
    });
    const sample = async () => {
      if (!(await probe.run()).completed) throw new Error();
      // run的公共Promise先完成，内部finally随后释放本轮；不把同一个在途轮次算作下一采样。
      await new Promise((done) => setImmediate(done));
    };
    let configured = false;
    dispatcher = createAlertDispatcher({
      tx,
      clock,
      holder,
      logger,
      config: env.ALERTS,
      robot: (input) => (configured ? providers : disabled).wecom.sendRobotMessage(input),
      sms: async () => {
        throw new Error("P2演练不应发送短信");
      },
      bell: (handle, input) => sendSystemAlert(handle, input, assembly),
    });
    stage = "unconfigured";
    await sample();
    const first = await dispatcher.run();
    let fact = await db.alertEvent.findFirstOrThrow({
      where: { fingerprint: `webhook.backlog:${dimension}` },
    });
    if (
      first.unconfigured < 1 ||
      fact.notifyCount !== 0 ||
      fact.lastValue._delivery.robot.status !== "not_accepted" ||
      fact.lastValue._delivery.robot.failures !== 0
    )
      throw new Error();
    stage = "open";
    configured = true;
    clock.at = new Date(clock.at.getTime() + 60_000);
    if ((await dispatcher.run()).accepted < 1) throw new Error();
    fact = await db.alertEvent.findUniqueOrThrow({ where: { id: fact.id } });
    if (
      fact.status !== "open" ||
      fact.notifyCount !== 1 ||
      fact.lastValue._delivery.robot.status !== "accepted"
    )
      throw new Error();
    stage = "recover";
    healthy = true;
    for (let index = 0; index < 3; index++) {
      clock.at = new Date(clock.at.getTime() + 1_000);
      await sample();
    }
    if ((await dispatcher.run()).accepted < 1) throw new Error();
    fact = await db.alertEvent.findUniqueOrThrow({ where: { id: fact.id } });
    const notifications = await db.notification.findMany({
      where: { bizType: "alert_event", bizId: fact.id },
      include: { notificationDeliveries: true, staffMessage: true },
    });
    if (
      fact.status !== "resolved" ||
      fact.lastValue._recoveryReason !== "normal" ||
      fact.lastValue._delivery.robot.status !== "accepted" ||
      fact.notifyCount !== 2 ||
      notifications.length !== 2 ||
      notifications.some(
        (row) =>
          !row.staffMessage ||
          row.notificationDeliveries.length !== 1 ||
          row.notificationDeliveries[0].channel !== "inbox" ||
          row.notificationDeliveries[0].status !== "sent",
      )
    )
      throw new Error();
    const staffIds = [...new Set(notifications.map((row) => row.staffId))];
    if (
      staffIds.length !== 1 ||
      (await db.staff.count({
        where: { id: staffIds[0], status: "active", staffRoleKey: "super_admin" },
      })) !== 1
    )
      throw new Error();
    await dispatcher.run();
    if ((await db.notification.count({ where: { bizType: "alert_event", bizId: fact.id } })) !== 2)
      throw new Error();
    result = {
      dimension,
      tlsVerified: true,
      unconfigured: true,
      recovered: true,
      notifyCount: fact.notifyCount,
      bells: notifications.length,
    };
  } catch (error) {
    failure = error;
  } finally {
    if (renewing) clearInterval(renewing);
    const failures = [];
    const settle = async (actions) => {
      const results = await Promise.allSettled(
        actions.map((action) => Promise.resolve().then(action)),
      );
      failures.push(...results.filter((result) => result.status === "rejected"));
    };
    await settle([() => dispatcher?.close(), () => probe?.close(), ...closers, () => renewal]);
    await settle([() => lease.release()]);
    await settle([() => lease.close(), () => db.$disconnect()]);
    if (failures.length) {
      stage += "_cleanup";
      failure = new AggregateError(
        [...(failure ? [failure] : []), ...failures],
        "观测夹具清理失败",
      );
    }
  }
  if (failure) throw failure;
  return result;
}
main()
  .then((fact) => process.stdout.write(JSON.stringify(fact) + "\n"))
  .catch(() => {
    process.stderr.write(`观测演练夹具失败:${stage}\n`);
    process.exitCode = 1;
  });
