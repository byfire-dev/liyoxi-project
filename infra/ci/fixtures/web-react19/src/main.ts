// Bundler 解析：相对导入不带后缀
import { setTitle } from "./title";

const root: HTMLElement | null = document.getElementById("root");

export function mount(): boolean {
  setTitle("狸有戏");
  return root !== null;
}
