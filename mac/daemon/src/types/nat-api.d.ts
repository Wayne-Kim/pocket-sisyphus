// nat-api 타입 선언 — 공식 .d.ts 가 없어 우리가 사용하는 만큼만 정의.
// 라이브러리는 callback + promise 혼합 API 인데 우리는 promise 변형만 사용.

declare module "nat-api" {
  export type MapOptions = {
    publicPort: number;
    privatePort: number;
    protocol?: "TCP" | "UDP";
    description?: string;
    ttl?: number;
  };

  export type UnmapOptions = {
    publicPort: number;
    privatePort: number;
    protocol?: "TCP" | "UDP";
  };

  export type NatAPIOptions = {
    ttl?: number;
    autoUpdate?: boolean;
    gateway?: string;
  };

  export default class NatAPI {
    constructor(opts?: NatAPIOptions);
    map(opts: MapOptions): Promise<void>;
    unmap(opts: UnmapOptions): Promise<void>;
    externalIp(cb: (err: Error | null, ip: string) => void): void;
    destroy(cb?: () => void): void;
  }
}
