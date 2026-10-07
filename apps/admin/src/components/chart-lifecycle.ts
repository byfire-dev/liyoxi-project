interface ChartInstance<Option> {
  setOption: (option: Option) => void;
  resize: () => void;
  dispose: () => void;
}

/** 只在容器真正可见时创建；观察器与实例的生命周期归同一个挂载所有。 */
export function createChartController<Option>(
  container: { readonly clientWidth: number; readonly clientHeight: number },
  initialOption: Option,
  driver: {
    init: () => ChartInstance<Option>;
    observe: (resize: () => void) => () => void;
  },
) {
  let option = initialOption;
  let instance: ChartInstance<Option> | undefined;
  let disposed = false;
  const paint = () => {
    if (disposed || container.clientWidth <= 0 || container.clientHeight <= 0) return;
    if (!instance) instance = driver.init();
    else instance.resize();
    instance.setOption(option);
  };
  const disconnect = driver.observe(paint);
  paint();
  return {
    update(next: Option) {
      option = next;
      paint();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      disconnect();
      instance?.dispose();
      instance = undefined;
    },
  };
}
