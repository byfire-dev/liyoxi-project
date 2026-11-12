declare module "qrcode" {
  const qrcode: {
    toDataURL(text: string, options?: { width?: number; margin?: number }): Promise<string>;
  };
  export default qrcode;
}
