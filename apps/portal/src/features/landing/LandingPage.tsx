import { Card, Typography, theme } from "antd";

/** A public explanation leaf; displaying a QR destination must never authorize a computer. */
export function LandingPage() {
  const { token } = theme.useToken();
  return (
    <main style={{ minHeight: "100vh", padding: token.paddingXL, background: token.colorBgLayout }}>
      <Card style={{ maxWidth: 680, margin: "0 auto" }}>
        <Typography.Title level={2}>请在狸有戏小程序中授权</Typography.Title>
        <Typography.Paragraph>
          微信首页「扫一扫」不能直接完成电脑登录。请打开狸有戏小程序，进入成片下载页，
          选择「电脑下载」，再点「扫描电脑登录码」。
        </Typography.Paragraph>
        <Typography.Paragraph>
          也可以回到电脑下载页查看 8 位登录码，手动填入小程序的「电脑登录代码」。
        </Typography.Paragraph>
        <Typography.Text type="secondary">
          请保留电脑端登录页面，并核对两位确认数字。
        </Typography.Text>
      </Card>
    </main>
  );
}
