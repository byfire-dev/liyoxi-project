// W2-24：逐文件参考旧 probes 分支的证书检查；不消费其全局运行时或告警写侧。
import { checkServerIdentity, connect } from "node:tls";
import { assertNotInTransaction } from "../kernel/index.js";
import type { Clock } from "../kernel/index.js";
import { failed, ok } from "../providers/types.js";
import type { ProviderResult } from "../providers/types.js";

export type TlsCertificateProbe = (
  domain: string,
  options: { signal: AbortSignal; timeoutMs: number },
) => Promise<ProviderResult<{ expiresAt: Date; validFrom: Date; trusted: boolean }>>;
export interface CertificateResult {
  readonly domain: string;
  readonly status: "healthy" | "expiring" | "unavailable" | "untrusted";
  readonly remainingDays?: number;
  readonly priority?: "P1" | "P2";
}
export const CERT_TIMEOUT_MS = 2_000;

/** 显式 DNS 域名固定443/SNI；读取真实证书，链信任与主机名均校验，不把握手成功当可信。 */
export const probeTlsCertificate: TlsCertificateProbe = (domain, options) => {
  assertNotInTransaction("ops.cert_check");
  return new Promise((resolve) => {
    if (options.signal.aborted) {
      resolve(failed("unavailable", "证书检查已中止"));
      return;
    }
    const socket = connect({
      host: domain,
      servername: domain,
      port: 443,
      rejectUnauthorized: false,
    });
    let finished = false;
    const finish = (result: Awaited<ReturnType<TlsCertificateProbe>>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", aborted);
      socket.destroy();
      resolve(result);
    };
    const aborted = () => finish(failed("unavailable", "证书检查已中止"));
    const timer = setTimeout(
      () => finish(failed("unavailable", "证书检查超时")),
      options.timeoutMs,
    );
    timer.unref();
    options.signal.addEventListener("abort", aborted, { once: true });
    socket.once("error", () => finish(failed("unavailable", "证书检查连接失败")));
    socket.once("secureConnect", () => {
      try {
        const certificate = socket.getPeerCertificate();
        const expiresAt = new Date(certificate.valid_to),
          validFrom = new Date(certificate.valid_from);
        if (!Number.isFinite(expiresAt.getTime()) || !Number.isFinite(validFrom.getTime())) {
          finish(failed("rejected", "证书有效期不合格"));
          return;
        }
        finish(
          ok({
            expiresAt,
            validFrom,
            trusted: socket.authorized && checkServerIdentity(domain, certificate) === undefined,
          }),
        );
      } catch {
        finish(failed("rejected", "证书读取失败"));
      }
    });
    // 信号可能在连接创建期间被取消；取消与错误/成功都只收尾一次。
    if (options.signal.aborted) aborted();
  });
};

/** 即使注入的 probe 不遵守取消约定，也不无限等待；迟到结果/异常均被消费。 */
function boundedProbe(
  probe: TlsCertificateProbe,
  domain: string,
  signal: AbortSignal,
  timeoutMs: number,
) {
  return new Promise<Awaited<ReturnType<TlsCertificateProbe>>>((resolve) => {
    const lifetime = new AbortController();
    let finished = false;
    const finish = (result: Awaited<ReturnType<TlsCertificateProbe>>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      lifetime.abort();
      resolve(result);
    };
    const aborted = () => finish(failed("unavailable", "证书检查已中止"));
    const timer = setTimeout(() => finish(failed("unavailable", "证书检查超时")), timeoutMs);
    timer.unref();
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) {
      aborted();
      return;
    }
    void Promise.resolve()
      .then(() =>
        lifetime.signal.aborted
          ? failed("unavailable", "证书检查已中止")
          : probe(domain, { signal: lifetime.signal, timeoutMs }),
      )
      .then(finish, () => finish(failed("unavailable", "证书检查失败")));
  });
}

export function createCertChecker(options: {
  readonly clock: Clock;
  readonly domains: readonly string[];
  readonly probe?: TlsCertificateProbe;
  readonly timeoutMs?: number;
}) {
  const domains = [...new Set(options.domains.map((domain) => domain.toLowerCase()))];
  const timeoutMs = options.timeoutMs ?? CERT_TIMEOUT_MS;
  if (
    domains.length > 16 ||
    domains.some(
      (domain) =>
        domain.length > 200 ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain),
    )
  )
    throw new TypeError("证书检查仅接受至多16个显式DNS域名");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CERT_TIMEOUT_MS)
    throw new TypeError("证书检查超时须为1至2000毫秒");
  const probe = options.probe ?? probeTlsCertificate;
  return {
    async run(input: { signal?: AbortSignal } = {}) {
      assertNotInTransaction("ops.cert_check");
      const signal = input.signal ?? new AbortController().signal;
      signal.throwIfAborted();
      const certificates: CertificateResult[] = [];
      for (const domain of domains) {
        const result = await boundedProbe(probe, domain, signal, timeoutMs);
        signal.throwIfAborted();
        if (
          !result.ok ||
          !Number.isFinite(result.value.expiresAt.getTime()) ||
          !Number.isFinite(result.value.validFrom.getTime())
        ) {
          certificates.push({ domain, status: "unavailable", priority: "P2" });
          continue;
        }
        const now = options.clock.now().getTime();
        const remainingDays = (result.value.expiresAt.getTime() - now) / 86_400_000;
        if (!result.value.trusted || result.value.validFrom.getTime() > now) {
          certificates.push({ domain, remainingDays, status: "untrusted", priority: "P1" });
          continue;
        }
        certificates.push({
          domain,
          remainingDays,
          status: remainingDays < 21 ? "expiring" : "healthy",
          ...(remainingDays < 7
            ? { priority: "P1" as const }
            : remainingDays < 21
              ? { priority: "P2" as const }
              : {}),
        });
      }
      return { configured: domains.length > 0, certificates };
    },
  };
}
