export default defineAppConfig({
  pages: ["pages/login/index", "pages/scan/index", "pages/upload/index", "pages/download/index"],
  window: { navigationBarTitleText: "X-01 真机探针" },
  networkTimeout: { request: 30000, uploadFile: 300000, downloadFile: 600000 },
  __usePrivacyCheck__: true,
});
