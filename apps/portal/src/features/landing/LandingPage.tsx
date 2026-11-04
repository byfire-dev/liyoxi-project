import { Card, Typography, theme } from "antd";

/** A public explanation leaf; displaying a QR destination must never authorize a computer. */
export function LandingPage() {
  const { token } = theme.useToken();
  return (
    <main style={{ minHeight: "100vh", padding: token.paddingXL, background: token.colorBgLayout }}>
      <Card style={{ maxWidth: 680, margin: "0 auto" }}>
        <Typography.Title level={2}>请在狸有戏小程序中授权</Typography.Title>
        <Typography.Paragraph>
          请门店老板打开狸有戏小程序，进入「设置」→「已授权的电脑」，选择「授权电脑」或「输入授权码」。
          本页仅提供操作说明，电脑授权需在小程序内核对并确认。
        </Typography.Paragraph>
        <Typography.Paragraph>
          请保留电脑端登录页面，在小程序授权页扫描电脑上的登录码，或输入电脑显示的 8 位登录码。
        </Typography.Paragraph>
        <Typography.Text type="secondary">
          授权前请核对当前门店与电脑显示的两位确认数字；信息不符时请拒绝授权。
        </Typography.Text>
      </Card>
    </main>
  );
}
