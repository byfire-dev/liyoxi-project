/** 同一首屏代次内只许一条续页；旧回调不能释放后继的占用。 */
export interface CatalogPageRequest {
  valid(): boolean;
  finish(): boolean;
}
export function createCatalogPagination() {
  let active: { guard: () => boolean } | null = null;
  return {
    reset: () => {
      active = null;
    },
    begin: (guard: () => boolean): CatalogPageRequest | null => {
      // 刷新同步 invalidate 旧guard；不等旧网络返回就能接管新续页。
      if (active?.guard()) return null;
      const token = { guard };
      active = token;
      return {
        valid: () => active === token && guard(),
        finish: () => {
          if (active !== token) return false;
          const current = guard();
          active = null;
          return current;
        },
      };
    },
  };
}
