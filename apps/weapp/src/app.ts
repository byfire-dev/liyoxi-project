import { createElement, Fragment, type PropsWithChildren } from "react";

import { useLaunch } from "@tarojs/taro";

import { ConsentPopup } from "@/components/ConsentPopup";
import { launchAccount } from "@/lib/account-runtime";

import "@/styles/nutui";
import "./app.scss";

function App({ children }: PropsWithChildren) {
  useLaunch((options) => {
    void launchAccount(options);
  });
  return createElement(Fragment, null, children, createElement(ConsentPopup));
}

export default App;
