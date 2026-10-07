import { describe, expect, it, vi } from "vitest";

import { createChartController } from "./chart-lifecycle";

describe("Chart 真实挂载边界", () => {
  it("隐藏容器不初始化，最新数据在可见时绘制；resize与重复清理无残留", () => {
    const container = { clientWidth: 0, clientHeight: 280 };
    const instance = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
    const disconnect = vi.fn();
    let notify!: () => void;
    const init = vi.fn(() => instance);
    const controller = createChartController<string>(container, "first", {
      init,
      observe: (callback) => {
        notify = callback;
        return disconnect;
      },
    });
    expect(init).not.toHaveBeenCalled();
    controller.update("latest");
    container.clientWidth = 500;
    notify();
    expect(init).toHaveBeenCalledTimes(1);
    expect(instance.setOption).toHaveBeenLastCalledWith("latest");
    container.clientWidth = 0;
    notify();
    container.clientWidth = 300;
    notify();
    expect(init).toHaveBeenCalledTimes(1);
    expect(instance.resize).toHaveBeenCalledTimes(1);
    controller.dispose();
    controller.dispose();
    notify();
    controller.update("stale");
    expect(instance.dispose).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledTimes(1);
  });
});
