import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Descriptions, Input, Skeleton, Space, Typography, theme } from "antd";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import type { PortalClient } from "../../lib/api";
import type { LicenseVerification } from "./api";
import { createVerificationModel, initialVerification, type VerificationModel } from "./model";
import {
  revisionExplanation,
  revisionReason,
  signatureExplanation,
  verificationStatus,
} from "./presentation";

export function VerificationDetails({ value }: { value: LicenseVerification }) {
  const revision = value.currentRevision;
  return (
    <>
      <Card title={`授权书 ${value.letterNo}`}>
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <Alert
            showIcon
            type={
              value.displayStatus === "effective"
                ? "success"
                : value.displayStatus === "voided"
                  ? "error"
                  : "info"
            }
            title={`授权状态：${verificationStatus(value.displayStatus)}`}
          />
          {value.voidedAt ? (
            <Typography.Text>作废于 {appDateTimeFormat.dateTime(value.voidedAt)}</Typography.Text>
          ) : null}
          <Alert
            role="status"
            type={
              value.requestedRevisionState === "outdated" ||
              value.requestedRevisionState === "not_found"
                ? "warning"
                : "info"
            }
            title={revisionExplanation(value)}
          />
          {value.hasPendingRevision ? (
            <Alert type="info" title="新版本生成中，以下仍为当前已出件版本。" />
          ) : null}
          <Typography.Text type="secondary">
            核对时间：{appDateTimeFormat.dateTime(value.checkedAt)}
          </Typography.Text>
        </Space>
      </Card>
      <Card title="当前已出件版授权内容">
        <Descriptions
          column={{ xs: 1, sm: 1, md: 2 }}
          items={[
            { key: "licensor", label: "授权方", children: value.licensorName },
            { key: "licensee", label: "被授权方", children: value.licenseeNameMask },
            { key: "credit", label: "主体证件", children: value.licenseeCreditCodeMask },
            { key: "drama", label: "剧目", children: `${value.dramaName} · ${value.episodes} 集` },
            {
              key: "platform",
              label: "发布平台",
              children: value.platform === "douyin" ? "抖音" : "视频号",
            },
            {
              key: "account",
              label: "授权账号",
              children: `${value.account.name}（${value.account.accountId}）`,
            },
            {
              key: "period",
              label: "授权期限",
              children: `${value.period.startDate ?? value.period.startText} 至 ${value.period.endDate}`,
            },
            { key: "territory", label: "授权地域", children: value.period.territory },
            { key: "agreement", label: "同意协议", children: value.consent.agreementName },
            { key: "consent", label: "同意记录", children: value.consent.consentNo },
            { key: "operator", label: "同意人", children: value.consent.operatorMask },
            {
              key: "consented",
              label: "同意时间",
              children: appDateTimeFormat.dateTime(value.consent.consentedAt),
            },
          ]}
        />
      </Card>
      <Card title={`当前第 ${revision.revNo} 版证明`}>
        <Descriptions
          column={1}
          items={[
            { key: "reason", label: "出件原因", children: revisionReason(revision.reason) },
            {
              key: "issued",
              label: "出件时间",
              children: appDateTimeFormat.dateTime(revision.issuedAt),
            },
            { key: "sign", label: "签署方式", children: signatureExplanation(revision.signMode) },
            {
              key: "signed",
              label: "签署时间",
              children: appDateTimeFormat.dateTime(revision.platformSignedAt),
            },
            { key: "issuer", label: "证书颁发者", children: revision.certIssuer ?? "—" },
            {
              key: "serial",
              label: "证书序列号",
              children: (
                <span style={{ overflowWrap: "anywhere" }}>{revision.certSerial ?? "—"}</span>
              ),
            },
            {
              key: "fingerprint",
              label: "内容指纹",
              children: (
                <Typography.Text code style={{ overflowWrap: "anywhere" }}>
                  {revision.contentFp}
                </Typography.Text>
              ),
            },
            {
              key: "hash",
              label: "PDF SHA-256",
              children: (
                <Typography.Text code style={{ overflowWrap: "anywhere" }}>
                  {revision.pdfSha256}
                </Typography.Text>
              ),
            },
          ]}
        />
        <Typography.Paragraph type="secondary">
          本页展示系统记录的授权状态与出件证明，不代替 PDF 阅读器的数字签名验证。
        </Typography.Paragraph>
      </Card>
      <Card title="已出件版次对照">
        <Space orientation="vertical" size="large" style={{ width: "100%" }}>
          {value.revisions.map((item) => (
            <section
              key={item.revNo}
              aria-label={`第 ${item.revNo} 版证明`}
              style={{ width: "100%" }}
            >
              <Typography.Title level={4}>
                第 {item.revNo} 版{item.isCurrent ? " · 当前版" : ""}
              </Typography.Title>
              <Typography.Paragraph>
                {revisionReason(item.reason)} · {appDateTimeFormat.dateTime(item.issuedAt)}
              </Typography.Paragraph>
              <div style={{ overflowWrap: "anywhere" }}>内容指纹：{item.contentFp}</div>
              <div style={{ overflowWrap: "anywhere" }}>PDF SHA-256：{item.pdfSha256}</div>
            </section>
          ))}
        </Space>
      </Card>
    </>
  );
}

function VerificationContent({ client, search }: { client: PortalClient; search: string }) {
  const { token } = theme.useToken();
  const [snapshot, setSnapshot] = useState(initialVerification);
  const [code, setCode] = useState("");
  const [now, setNow] = useState(Date.now);
  const model = useRef<VerificationModel | null>(null);
  useEffect(() => {
    const current = createVerificationModel(client);
    model.current = current;
    const unsubscribe = current.subscribe(() => setSnapshot(current.getSnapshot()));
    const params = new URLSearchParams(search);
    void current.lookup(params.get("code") ?? "", params.get("rev"));
    return () => {
      unsubscribe();
      current.dispose();
      if (model.current === current) model.current = null;
    };
  }, [client, search]);
  useEffect(() => {
    if (snapshot.retryAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [snapshot.retryAt]);
  const cooling = snapshot.retryAt !== null && now < snapshot.retryAt;
  const loading = snapshot.status === "loading";
  const query = () => {
    if (!code || loading || cooling) return;
    void model.current?.lookup(code);
    setCode("");
  };
  return (
    <main
      style={{
        maxWidth: 1040,
        margin: "0 auto",
        padding: token.paddingLG,
        display: "grid",
        gap: token.marginLG,
      }}
    >
      <Typography.Title level={1}>授权书验真</Typography.Title>
      <Typography.Paragraph type="secondary">
        核对授权状态、公开授权内容及已出件版次，无需登录。
      </Typography.Paragraph>
      <Card title="核对授权书">
        <Space wrap>
          <Input
            aria-label="验真码"
            placeholder="输入授权书上的验真码"
            maxLength={64}
            value={code}
            disabled={loading || cooling}
            onChange={(event) => setCode(event.target.value)}
            onPressEnter={query}
            autoComplete="off"
          />
          <Button type="primary" loading={loading} disabled={!code || cooling} onClick={query}>
            {cooling ? "请稍后重试" : "查询"}
          </Button>
          {snapshot.status !== "input" && snapshot.error?.error !== "MAINTENANCE" ? (
            <Button
              disabled={loading || cooling}
              onClick={() => {
                void model.current?.refresh();
              }}
            >
              重新核对
            </Button>
          ) : null}
        </Space>
      </Card>
      {snapshot.status === "input" ? (
        <Alert type="info" title="请扫描授权书二维码，或输入验真码后查询。" />
      ) : null}
      {loading ? (
        <Card>
          <Skeleton active paragraph={{ rows: 6 }} />
        </Card>
      ) : null}
      {snapshot.error ? (
        <Alert
          role="alert"
          type="error"
          showIcon
          title={
            snapshot.error.error === "LICENSE_VERIFICATION_NOT_FOUND"
              ? "未查到这份授权书，请核对二维码或验真码"
              : snapshot.error.message
          }
        />
      ) : null}
      {snapshot.error?.error === "MAINTENANCE" ? (
        <Button onClick={() => window.location.reload()}>重新加载页面</Button>
      ) : null}
      {snapshot.value ? <VerificationDetails value={snapshot.value} /> : null}
    </main>
  );
}

export function VerificationPage({
  client,
  search = typeof window === "undefined" ? "" : window.location.search,
}: {
  client: PortalClient;
  search?: string;
}) {
  return <VerificationContent key={search} client={client} search={search} />;
}
