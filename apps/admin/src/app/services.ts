// 应用级的单例：查询缓存、权限数据来源、请求客户端。页面包从这里取，不各建各的。
import type { paths as AdminPaths } from "@liyoxi/contract/types/admin";
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import createQueryHooks, { type OpenapiQueryClient } from "openapi-react-query";

import { createAdminApi, type AdminApi } from "../lib/api";
import { BUILD_NUMBER } from "../lib/build";
import { type AccessSnapshot, type AccessSource } from "../lib/permissions";
import { createQueryClient, DICT_QUERY } from "../lib/query";

import {
  accessFromMe,
  createStepUpController,
  type StepUpController,
} from "../features/auth/model";

import { globalState, showApiNotice } from "./feedback";

export const ACCESS_QUERY_KEY = ["admin", "access"] as const;

export interface AppServices {
  queryClient: QueryClient;
  stepUp: StepUpController;
  api: AdminApi<AdminPaths>;
  /**
   * 带类型的查询钩子（openapi-react-query）：query.useQuery("get", "/admin/…", { params })，
   * 路径、参数、响应都按契约推出。它用的就是 api.client，请求头与统一错误处置一样生效
   */
  query: OpenapiQueryClient<AdminPaths>;
  /** 权限数据来源：缺省读取 GET /admin/auth/me，夹具只在开发与测试构建里换上 */
  setAccessSource(source: AccessSource): void;
  loadAccess(): Promise<AccessSnapshot | null>;
  /** 路由建好后登记：权限刷新后要让路由重新走一遍守卫 */
  onAccessRefreshed(listener: () => void): void;
}

export function createAppServices(): AppServices {
  const queryClient = createQueryClient();
  const stepUp = createStepUpController();
  let accessSource: AccessSource;
  let accessRefreshed: () => void = () => {};

  const accessQuery = () =>
    queryOptions({
      queryKey: ACCESS_QUERY_KEY,
      queryFn: () => accessSource.load(),
      ...DICT_QUERY,
    });

  const api = createAdminApi({
    build: BUILD_NUMBER,
    // 生成的 AdminPaths 已含 /api/v1 前缀。
    baseUrl: "",
    handlers: {
      // 带着当前站内地址跳转，登录成功后由页面放开单飞闩
      redirectToLogin() {
        const current = `${window.location.pathname}${window.location.search}`;
        window.location.assign(`/login?redirect=${encodeURIComponent(current)}`);
      },
      // 外壳中的再验证弹层接受请求层的单飞意图
      stepUp: () => stepUp.request(),
      refreshAccess() {
        void queryClient
          .invalidateQueries({ queryKey: ACCESS_QUERY_KEY, refetchType: "none" })
          .then(() => queryClient.fetchQuery(accessQuery()))
          .then(accessRefreshed)
          .catch(() =>
            showApiNotice({
              symbol: "ACCESS_REFRESH_FAILED",
              message: "权限刷新没有成功，请刷新页面重试",
              requestIdTail: null,
            }),
          );
      },
      invalidateQueries() {
        void queryClient.invalidateQueries({
          predicate: (query) => query.queryKey[1] !== ACCESS_QUERY_KEY[1],
        });
      },
      notify: showApiNotice,
      showBlocked: globalState.block,
      buildMismatch: globalState.buildMismatch,
    },
  });

  accessSource = {
    async load() {
      const { data, response } = await api.client.GET("/api/v1/admin/auth/me");
      if (response.status === 401) return null;
      if (!data) throw new Error("无法读取当前员工，请刷新重试");
      return accessFromMe(data.data);
    },
  };

  return {
    queryClient,
    stepUp,
    api,
    query: createQueryHooks(api.client),
    setAccessSource(source) {
      accessSource = source;
    },
    loadAccess: () => queryClient.ensureQueryData(accessQuery()),
    onAccessRefreshed(listener) {
      accessRefreshed = listener;
    },
  };
}
