declare const __PROBE_BASE_URL__: string;
declare module "*.scss";
declare module "cos-wx-sdk-v5" {
  type Callback = (error: unknown, data?: Record<string, unknown>) => void;
  export type CosClient = {
    sliceUploadFile(params: Record<string, unknown>, callback: Callback): void;
    multipartListPart(params: Record<string, unknown>, callback: Callback): void;
    on(
      event: string,
      callback: (data: { method?: string; qs?: Record<string, string> }) => void,
    ): void;
    pauseTask(id: string): void;
    restartTask(id: string): void;
    cancelTask(id: string): void;
  };
  const COS: new (options: Record<string, unknown>) => CosClient;
  export default COS;
}
