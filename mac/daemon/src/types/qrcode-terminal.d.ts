declare module "qrcode-terminal" {
  export interface GenerateOpts {
    small?: boolean;
  }
  export function generate(
    text: string,
    opts?: GenerateOpts,
    cb?: (qr: string) => void,
  ): void;
  const _default: { generate: typeof generate };
  export default _default;
}
