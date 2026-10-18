import { useEffect, useRef, useState } from "react";
import { View } from "@tarojs/components";
import { useDidShow } from "@tarojs/taro";

import { Icon } from "@/components/Icon";
import { LoadError } from "@/components/LoadError";
import { NavBar } from "@/components/NavBar";
import { Skeleton } from "@/components/Skeleton";
import { TextButton } from "@/components/TextButton";
import { accountError } from "@/lib/account-controller";
import { browseAsGuest } from "@/lib/account-routing";
import { account, useAccount } from "@/lib/account-runtime";

import { PhoneForm } from "./PhoneForm";
import "./index.scss";

export default function Login() {
  const state = useAccount();
  const [error, setError] = useState<string | null>(null);
  const loadRevision = useRef(0);
  useEffect(
    () => () => {
      loadRevision.current++;
    },
    [],
  );
  const load = () => {
    const revision = ++loadRevision.current;
    setError(null);
    void account
      .loadAgreements()
      .then((agreements) => {
        if (revision === loadRevision.current && !agreements.length)
          setError("登录协议暂不可用，请稍后重试");
      })
      .catch((failure) => {
        if (revision === loadRevision.current) setError(accountError(failure));
      });
  };
  useDidShow(load);
  return (
    <View
      className="account-login"
      id={!state.booting && state.agreements.length ? "account-ready" : undefined}
    >
      <NavBar>
        <View className="account-login__nav">商家登录</View>
      </NavBar>
      <View className="account-login__brand">狸有戏</View>
      <View className="account-login__tagline">让门店，出现在好故事里</View>
      <View className="account-login__intro">用短剧讲好门店故事，为生意带来新客</View>
      <View className="account-login__benefits">
        <View>
          <Icon name="drama" />
          版权短剧，按店定制
        </View>
        <View>
          <Icon name="store" />
          自然植入，让门店被看见
        </View>
        <View>
          <Icon name="play-circle" />
          成片交付，发布更省心
        </View>
      </View>
      {error ? (
        <LoadError message={error} onRetry={load} />
      ) : state.agreements.length ? (
        <PhoneForm />
      ) : (
        <Skeleton cards={1} />
      )}
      <View className="account-login__browse">
        <TextButton
          tone="muted"
          onClick={() => {
            void browseAsGuest();
          }}
        >
          先逛逛
        </TextButton>
      </View>
    </View>
  );
}
