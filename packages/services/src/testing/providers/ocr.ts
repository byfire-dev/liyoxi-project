// 假证照识别：按地址给预置的结果；没预置的给一份样例。

import { ok } from "../../providers/types.js";
import type {
  BusinessLicenseFields,
  BankReceiptFields,
  OcrProvider,
  ProviderMethodName,
} from "../../providers/types.js";
import { createFakeCore, systemClock } from "./base.js";
import type { FakeClock, FakeControl } from "./base.js";

type Method = ProviderMethodName<OcrProvider>;

export interface FakeOcr extends OcrProvider, FakeControl<Method> {
  /** 营业执照的预置：图片地址 → 识别结果。没预置的给 defaultLicense */
  readonly licenses: Map<string, BusinessLicenseFields>;
  readonly receipts: Map<string, BankReceiptFields>;
  defaultReceipt: BankReceiptFields;
  /** 没预置时给的营业执照。信用代码是编的，不对应任何主体。可以整个换掉 */
  defaultLicense: BusinessLicenseFields;
  /** 许可证字段的预置：文件地址 → 字段。没预置的，每个要抽的字段回 “样例” 加字段名 */
  readonly licenseFields: Map<string, Record<string, string>>;
}

export function createFakeOcr(options: { clock?: FakeClock } = {}): FakeOcr {
  const core = createFakeCore<Method>(options.clock ?? systemClock);
  const licenses = new Map<string, BusinessLicenseFields>();
  const licenseFields = new Map<string, Record<string, string>>();

  const fake: FakeOcr = {
    status: "fake",
    configured: true,
    ...core.control,
    licenses,
    receipts: new Map(),
    defaultReceipt: {
      payerName: null,
      payerAccount: null,
      payeeName: null,
      amountFen: null,
      remark: null,
      tradedAt: null,
      warnings: ["EXPLICIT_FAKE_RECEIPT"],
    },
    defaultLicense: {
      name: "样例餐饮店",
      uscc: "91000000FAKE000001",
      principal: "张三",
      address: "样例市样例路 1 号",
      validTo: "long_term",
      warnings: [],
    },
    licenseFields,

    recognizeBankReceipt: (input) =>
      core.run(
        "recognizeBankReceipt",
        input,
        () => {
          const fields = fake.receipts.get(input.fileUrl) ?? fake.defaultReceipt;
          return ok({ ...fields, warnings: [...fields.warnings] });
        },
        input.signal,
      ),
    recognizeBusinessLicense: (input) =>
      core.run("recognizeBusinessLicense", input, () => {
        const license = licenses.get(input.imageUrl) ?? fake.defaultLicense;
        return ok({ ...license, warnings: [...license.warnings] });
      }),
    extractLicenseFields: (input) =>
      core.run("extractLicenseFields", input, () => {
        const preset = licenseFields.get(input.fileUrl);
        const fields = Object.fromEntries(
          input.fieldNames.map((name) => [name, preset?.[name] ?? `样例${name}`]),
        );
        return ok({ fields });
      }),
  };
  return fake;
}
