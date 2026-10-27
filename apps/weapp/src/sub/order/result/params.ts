// 小程序码page固定为本页，scene仅容纳去横线的UUIDv7；它不是身份或付款凭证。
export function paymentIdFromScene(scene: unknown): string | null {
  if (
    typeof scene !== "string" ||
    scene.length !== 32 ||
    !/^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/.test(scene)
  )
    return null;
  return `${scene.slice(0, 8)}-${scene.slice(8, 12)}-${scene.slice(12, 16)}-${scene.slice(16, 20)}-${scene.slice(20)}`;
}
