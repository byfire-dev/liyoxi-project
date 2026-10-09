import { useState, type SetStateAction } from "react";
import { profileContext } from "./runtime";
import { refreshDraftMedia } from "./media-draft";

/** GET 更新版本与守卫；同上下文的未保存输入保留，成功保存显式采用确认视图。 */
export function useDraft<S, D>(source: S | undefined, project: (source: S) => D, empty: D) {
  const context = profileContext();
  const [state, setState] = useState(() => ({
    context,
    source,
    value: source === undefined ? empty : project(source),
    dirty: false,
  }));
  if (state.context !== context) {
    setState({
      context,
      source,
      value: source === undefined ? empty : project(source),
      dirty: false,
    });
  } else if (source !== state.source) {
    setState({
      ...state,
      source,
      value:
        source === undefined
          ? state.value
          : state.dirty
            ? refreshDraftMedia(state.value, source)
            : project(source),
    });
  }
  const change = (value: SetStateAction<D>) => {
    if (context !== profileContext()) return;
    setState((old) => ({
      ...old,
      dirty: true,
      value: typeof value === "function" ? (value as (old: D) => D)(old.value) : value,
    }));
  };
  const accept = (confirmed: S) => {
    if (context !== profileContext()) return;
    setState({ context, source: confirmed, value: project(confirmed), dirty: false });
  };
  return [state.value, change, accept] as const;
}
