// 文件引用方只提供自己的业务列与释放规则；media 经端口取投影，避免读取同层业务表。
// W1-07：契约放在 L0，引用方与媒体实现都只能向下依赖。分类守卫仍属于 media。
import type { UploadCategory } from "@liyoxi/shared/uploads";
import { defineKeyedPort } from "../assembly/index.js";
import type { Tx } from "../tx.js";

export interface ExpectedFileRef {
  readonly fileId: string;
  readonly refId: string;
  readonly role: string;
}

export interface FileRefType {
  readonly roles: Readonly<
    Record<
      string,
      {
        readonly categories: readonly UploadCategory[];
        readonly retentionDays: number | null;
        readonly canRelease?: (tx: Tx, refId: string) => Promise<boolean>;
      }
    >
  >;
  readonly readColumns?: (tx: Tx) => Promise<readonly ExpectedFileRef[]>;
}

export const fileRefTypePort = defineKeyedPort<FileRefType>("media.file_ref_type");
