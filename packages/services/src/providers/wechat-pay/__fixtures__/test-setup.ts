// 用例的支架：一套测试配置。商户密钥、微信支付公钥、APIv3 密钥都是现场生成的测试值，不入库。

import type { WechatPayConfig } from "../config.js";
import { generateIdentity, testApiV3Key } from "./wechatpay-server.js";
import type { TestIdentity } from "./wechatpay-server.js";

export interface TestSetup {
  merchant: TestIdentity;
  /** 微信支付公钥模式的验签身份 */
  platform: TestIdentity;
  apiV3Key: string;
  config: WechatPayConfig;
}

/** 一套测试配置：商户密钥、微信支付公钥、APIv3 密钥都是现场生成的 */
export function createTestSetup(overrides: Partial<WechatPayConfig> = {}): TestSetup {
  const merchant = generateIdentity("LYXTESTMCHCERTSERIAL0001");
  const platform = generateIdentity("PUB_KEY_ID_0000000000000000000000000000000001");
  const apiV3Key = testApiV3Key("current");
  return {
    merchant,
    platform,
    apiV3Key,
    config: {
      mchid: "1900000109",
      appid: "wx0000000000000000",
      merchantSerialNo: merchant.serial,
      merchantPrivateKey: merchant.privateKey,
      publicKeyId: platform.serial,
      apiV3Keys: { current: { kid: "v2", key: apiV3Key } },
      verifiers: [{ serial: platform.serial, pem: platform.publicKeyPem }],
      notifyUrl: "https://api.example.invalid/api/v1/hooks/wechatpay/transactions",
      refundNotifyUrl: "https://api.example.invalid/api/v1/hooks/wechatpay/refunds",
      ...overrides,
    },
  };
}
