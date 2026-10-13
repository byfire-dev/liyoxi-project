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
  /** 删除前按目标文件重查拥有者的当前使用事实；不得把历史投影/预载快照当在用。
   * 每项须为该fileId和真实refId/role；[]表示已查询且当前不占用，缺实现表示未知。 */
  readonly inUse?: (tx: Tx, fileId: string) => Promise<readonly ExpectedFileRef[]>;
}

export const fileRefTypePort = defineKeyedPort<FileRefType>("media.file_ref_type");
