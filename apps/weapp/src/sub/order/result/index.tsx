import Taro from "@tarojs/taro";
import { Empty } from "@/components/Empty";
import { PageBody } from "@/components/PageBody";
import { PaymentResult } from "./payment";
import { OrderResult } from "./order";
import { paymentIdFromScene } from "./params";
export default function ResultPage() {
  const params = Taro.getCurrentInstance().router?.params;
  if (params?.type === "order" && params.orderId) return <OrderResult id={params.orderId} />;
  if (params?.type === "payment" && params.paymentOrderId)
    return <PaymentResult id={params.paymentOrderId} />;
  const scannedPaymentId = paymentIdFromScene(params?.scene);
  if (scannedPaymentId) return <PaymentResult id={scannedPaymentId} />;
  return (
    <PageBody>
      <Empty title="暂无付款结果" description="请从付款单进入查看" />
    </PageBody>
  );
}
