// 纯 TS 类型：errors 子路径与小程序不得可达 Zod；结构归 m01 第 2.5 节。
export interface PendingConsent {
  agreementKey: string;
  agreementVersionId: string;
  name: string;
  versionLabel: string;
  effectiveAt: string;
  summary: string;
}
