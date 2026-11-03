import { defineConfig } from "@tarojs/cli";

export default defineConfig<"vite">({
  projectName: "liyoxi-weapp-probe",
  date: "2026-11-03",
  designWidth: 375,
  deviceRatio: { 375: 2, 640: 2.34 / 2, 750: 1, 828: 1.81 / 2 },
  sourceRoot: "src",
  outputRoot: "dist",
  framework: "react",
  compiler: "vite",
  defineConstants: {
    __PROBE_BASE_URL__: JSON.stringify(process.env.PROBE_BASE_URL || "http://127.0.0.1:4310"),
  },
  mini: {
    debugReact: true,
    enableSourceMap: false,
    postcss: { pxtransform: { enable: true, config: {} } },
  },
});
