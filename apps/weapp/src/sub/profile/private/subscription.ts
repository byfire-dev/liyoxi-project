import { withSubscribe } from "../../../lib/runtime";

/** 生产沿中央封装；明确 H5 样张只替换原生授权依赖，复用同一订阅实现。 */
export const withProfileSubscribe: typeof withSubscribe = (point, handler) => {
  if (process.env.TARO_ENV === "h5") {
    const control = (
      globalThis as {
        __LYX_PROFILE_CONTROL__?: {
          authorization: { withSubscribe: typeof withSubscribe };
        };
      }
    ).__LYX_PROFILE_CONTROL__;
    if (control) return control.authorization.withSubscribe(point, handler);
  }
  return withSubscribe(point, handler);
};
