export interface ResourceError {
  message: string;
  preserveContent: boolean;
}

export interface ResourceState<T> {
  data: T | undefined;
  loading: boolean;
  error: ResourceError | null;
}

export function resourceView({
  loading,
  error,
}: Pick<ResourceState<unknown>, "loading" | "error">) {
  return loading ? "loading" : error && !error.preserveContent ? "error" : "content";
}

/** 刷新与首次读取共用请求守卫；页面是否卸载内容只由公开状态决定。 */
export function createResource<T>({
  context,
  read,
  message,
}: {
  context(): string;
  read(isCurrent: () => boolean): Promise<T | undefined>;
  message(error: unknown): string;
}) {
  let currentContext = context();
  let reader = read;
  let live = true;
  let requestNo = 0;
  let state: ResourceState<T> = { data: undefined, loading: true, error: null };
  const listeners = new Set<() => void>();
  const publish = (next: ResourceState<T>) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const reset = () => {
    requestNo++;
    currentContext = context();
    publish({ data: undefined, loading: true, error: null });
  };
  const load = async () => {
    if (!live) return;
    if (currentContext !== context()) reset();
    const requestId = ++requestNo;
    const requestedContext = currentContext;
    const isCurrent = () => live && requestId === requestNo && requestedContext === context();
    publish({ ...state, loading: state.data === undefined, error: null });
    try {
      const data = await reader(isCurrent);
      if (isCurrent() && data !== undefined) publish({ data, loading: false, error: null });
    } catch (error) {
      if (isCurrent())
        publish({
          ...state,
          loading: false,
          error: { message: message(error), preserveContent: state.data !== undefined },
        });
    } finally {
      if (isCurrent() && state.loading) publish({ ...state, loading: false });
    }
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    reset,
    setReader(next: typeof read) {
      reader = next;
    },
    setData(value: T | undefined | ((previous: T | undefined) => T | undefined)) {
      if (!live || currentContext !== context()) return;
      const data =
        typeof value === "function"
          ? (value as (previous: T | undefined) => T | undefined)(state.data)
          : value;
      publish({ ...state, data });
    },
    activate() {
      live = true;
      if (currentContext !== context()) reset();
    },
    dispose() {
      live = false;
      requestNo++;
    },
  };
}
