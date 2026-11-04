import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { createAuthRoutes } from "./features/auth/routes";
import { createPortalRuntime } from "./lib/runtime";

const container = document.getElementById("root");
if (!container) throw new Error("index.html 里没有 #root");
// 把构建号挂在根节点上，排障时在页面上就能看到是哪一版
container.dataset.build = __LYX_BUILD__;
const runtime = createPortalRuntime();
const root = createRoot(container);
const close = (event: PageTransitionEvent) => {
  // A bfcache restoration revalidates protected leaves; a real departure owns final cleanup.
  if (event.persisted) return;
  root.unmount();
  runtime.dispose();
  window.removeEventListener("pagehide", close);
};
window.addEventListener("pagehide", close);
root.render(
  <StrictMode>
    <App runtime={runtime} routes={createAuthRoutes(runtime)} />
  </StrictMode>,
);
