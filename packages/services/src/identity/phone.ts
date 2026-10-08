// 换回来的手机号认不认：V1.0 只认中国大陆的手机号（m01 第 3.2 节；D4 第 3.2 节第 2 步）。
//
// 区号要看原串，不能看归一化之后的数字：“+1 312 555 0199”去掉符号正好 11 位、以 1 开头，与大陆号 13125550199
// 的盲索引相同，放过去就是登进别人的账号并绑上微信。所以这里按写法收，不按长相猜：去掉分隔符之后只认
// “1 开头的 11 位”，前面至多带一个 86 的区号（+86、0086、86）；带别的国际前缀、别的符号、位数不对的一律不认。
// 认下来的写法与盲索引的归一化（security 的 normalizePhone）给出同一串数字，用例钉着。
//
// 真实 Provider 同时给区号、纯号码事实；旧替身仍只给 phone。已给出的事实必须一致，不能凭号码长相猜区号。

/** 原串里可以有的分隔符：空白、连字符、括号、点 */
const SEPARATORS = /[\s\-().]/g;
const MAINLAND_MOBILE = /^(?:\+86|0086|86)?(1\d{10})$/;

/** 大陆手机号给出归一化后的 11 位数字；别的（别的区号、位数不对、认不出的写法）给 null */
export function mainlandMobileOf(
  rawPhone: string,
  countryCode?: string,
  purePhoneNumber?: string,
): string | null {
  if (countryCode !== undefined && countryCode !== "86") return null;
  const phone = MAINLAND_MOBILE.exec(rawPhone.replace(SEPARATORS, ""))?.[1] ?? null;
  if (purePhoneNumber !== undefined && purePhoneNumber !== phone) return null;
  return phone;
}
