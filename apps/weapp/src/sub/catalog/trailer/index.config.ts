import { sharedTokens } from "@liyoxi/shared/design/tokens";
export default definePageConfig({
  navigationBarTitleText: "预告片",
  navigationBarBackgroundColor: sharedTokens.color["bg-inverse"],
  navigationBarTextStyle: "white",
  backgroundColor: sharedTokens.color["bg-inverse"],
  enablePullDownRefresh: true,
  enableShareAppMessage: true,
});
