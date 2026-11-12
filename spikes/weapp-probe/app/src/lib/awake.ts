import Taro from "@tarojs/taro";

let holders = 0;
let pending = Promise.resolve();
function set(keepScreenOn: boolean) {
  pending = pending
    .then(
      () =>
        new Promise<void>((resolve) =>
          Taro.setKeepScreenOn({ keepScreenOn, complete: () => resolve() }),
        ),
    )
    .catch(() => undefined);
}
// Two concurrent download jobs share one screen-awake hold; one finishing cannot release the other.
export function keepAwake() {
  if (++holders === 1) set(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holders === 0) set(false);
  };
}
