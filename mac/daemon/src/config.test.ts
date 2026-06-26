/**
 * `config.ts` — 기기 인증 슬롯 헬퍼 + 실-DB 격리 가드 + config 읽기/쓰기 단위 테스트.
 *
 * 이 핵심 순수헬퍼들을 «쓰는» 테스트(attest.test.ts·dev/demo-data.test.ts)는 `vi.mock`
 * 으로 config.js 를 통째로 가짜 구현으로 갈아끼운다 — 그래서 진짜 구현은 어디서도 실행되지
 * 않았다. 여기서는 «모킹 없이» 진짜 구현을 직접 단언한다. 누군가
 *   - listAttestDevices 의 slice(0, MAX) 를 지우거나,
 *   - allowedDeviceSlots 를 항상 MAX 로 바꿔(슬롯 옵트인 게이트 우회),
 *   - isIsolatedConfigDir 의 path.resolve 비교를 느슨하게 만들면(실 DB 가 «격리»로 오판되어
 *     데모 시드가 실 DB 를 덮어쓸 수 있음),
 * 빌드·기존 모킹 테스트는 통과해도 이 파일이 즉시 빨갛게 된다. auth.test.ts 의 «신뢰경계
 * 0 직접검증» 공백 메우기와 동일한 의도.
 *
 * 격리: fs 를 건드리는 read/write 는 import «시점» 에 굳는 CONFIG_FILE 상수가 tmpdir 안을
 * 가리키도록, config.js 를 import 하기 전(hoisted)에 POCKET_CLAUDE_CONFIG_DIR 를 주입한다
 * (isolation.test.ts·demo-data.test.ts 의 tmpdir 패턴 재사용). 동작 코드(config.ts)는
 * 손대지 않는다 — 테스트만 추가.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { DaemonConfig, AttestDevice } from "./config.js";

// config.ts 의 CONFIG_DIR/CONFIG_FILE 상수는 «import 시점» 에 env 를 읽어 굳는다. 따라서
// import «전» 에 격리 디렉터리를 주입해야 read/write 가 tmp 파일을 가리킨다. CONFIG_DIR 을
// 2단 중첩 경로로 둬, writeConfig 의 ensureConfigDir(recursive mkdir) 가 실제로 디렉터리
// 트리를 새로 만드는 경로를 밟게 한다.
const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  const root = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-config-test-"));
  const configDir = pathH.join(root, "Application Support", "PocketSisyphusTest");
  process.env.POCKET_CLAUDE_CONFIG_DIR = configDir;
  return { root, configDir };
});

const {
  listAttestDevices,
  allowedDeviceSlots,
  isIsolatedConfigDir,
  readConfig,
  writeConfig,
  ensureConfigDir,
  MAX_DEVICE_SLOTS,
  REAL_CONFIG_DIR,
  CONFIG_DIR,
  CONFIG_FILE,
  resolvePoMultiPass,
  PO_MAX_GENERATION_PASSES,
} = await import("./config.js");

/** 최소 유효 DaemonConfig — 필수 필드(port/tokenHash/createdAt)만 채우고 나머지는 덮어쓴다. */
function baseCfg(extra: Partial<DaemonConfig> = {}): DaemonConfig {
  return { port: 7777, tokenHash: "h", createdAt: 0, ...extra };
}

/** CONFIG_DIR 과 그 중간 디렉터리까지 제거 — 매 테스트가 «디렉터리 없음» 에서 시작하도록. */
function cleanConfigDir(): void {
  fs.rmSync(path.join(H.root, "Application Support"), { recursive: true, force: true });
}

afterAll(() => {
  fs.rmSync(H.root, { recursive: true, force: true });
});

describe("listAttestDevices — 레거시 흡수 + MAX 슬라이스", () => {
  it("cfg=null/undefined → 빈 배열", () => {
    expect(listAttestDevices(null)).toEqual([]);
    expect(listAttestDevices(undefined)).toEqual([]);
  });

  it("attestDevices 가 정확히 3개(경계)면 3개 그대로", () => {
    const three: AttestDevice[] = [
      { publicKey: "k1", registeredAt: 1 },
      { publicKey: "k2", registeredAt: 2 },
      { publicKey: "k3", registeredAt: 3 },
    ];
    const out = listAttestDevices(baseCfg({ attestDevices: three }));
    expect(out).toEqual(three);
    expect(out).toHaveLength(MAX_DEVICE_SLOTS);
  });

  it("attestDevices 가 4개(초과)면 앞 3개만 (slice(0, MAX))", () => {
    const four: AttestDevice[] = [
      { publicKey: "k1", registeredAt: 1 },
      { publicKey: "k2", registeredAt: 2 },
      { publicKey: "k3", registeredAt: 3 },
      { publicKey: "k4", registeredAt: 4 },
    ];
    const out = listAttestDevices(baseCfg({ attestDevices: four }));
    expect(out).toHaveLength(MAX_DEVICE_SLOTS);
    expect(out.map((d) => d.publicKey)).toEqual(["k1", "k2", "k3"]);
  });

  it("attestDevices 가 있으면 레거시 attestPublicKey 보다 우선한다", () => {
    const out = listAttestDevices(
      baseCfg({
        attestDevices: [{ publicKey: "new", registeredAt: 9 }],
        attestPublicKey: "legacy",
        attestRegisteredAt: 1,
      }),
    );
    expect(out).toEqual([{ publicKey: "new", registeredAt: 9 }]);
  });

  it("attestDevices 없고 레거시 attestPublicKey 만 있으면 1원소로 흡수", () => {
    expect(
      listAttestDevices(baseCfg({ attestPublicKey: "legacy", attestRegisteredAt: 123 })),
    ).toEqual([{ publicKey: "legacy", registeredAt: 123 }]);
  });

  it("레거시 흡수 시 registeredAt 누락이면 0 으로 채운다", () => {
    expect(listAttestDevices(baseCfg({ attestPublicKey: "legacy" }))).toEqual([
      { publicKey: "legacy", registeredAt: 0 },
    ]);
  });

  it("attestDevices 가 빈 배열이면 레거시로 폴백한다", () => {
    expect(
      listAttestDevices(baseCfg({ attestDevices: [], attestPublicKey: "legacy" })),
    ).toEqual([{ publicKey: "legacy", registeredAt: 0 }]);
  });

  it("attestDevices 빈 배열 + 레거시도 없으면 빈 배열", () => {
    expect(listAttestDevices(baseCfg({ attestDevices: [] }))).toEqual([]);
    expect(listAttestDevices(baseCfg())).toEqual([]);
  });
});

describe("allowedDeviceSlots — 추가 슬롯 이진 토글(off=1 · on=MAX)", () => {
  it("extraDeviceSlotAllowed=false → 1", () => {
    expect(allowedDeviceSlots(baseCfg({ extraDeviceSlotAllowed: false }))).toBe(1);
  });

  it("extraDeviceSlotAllowed 미설정 → 1 (기본)", () => {
    expect(allowedDeviceSlots(baseCfg())).toBe(1);
  });

  it("extraDeviceSlotAllowed=true → MAX_DEVICE_SLOTS(3)", () => {
    expect(allowedDeviceSlots(baseCfg({ extraDeviceSlotAllowed: true }))).toBe(
      MAX_DEVICE_SLOTS,
    );
    expect(MAX_DEVICE_SLOTS).toBe(3);
  });

  it("cfg=null/undefined → 1 (fail-safe: 추가 등록 차단)", () => {
    expect(allowedDeviceSlots(null)).toBe(1);
    expect(allowedDeviceSlots(undefined)).toBe(1);
  });
});

describe("isIsolatedConfigDir — 실 DB 보호용 «쓰기» 격리 판정", () => {
  // 호출 시점의 process.env 를 읽으므로, env 를 토글하며 단언하고 원복한다.
  const ORIG = process.env.POCKET_CLAUDE_CONFIG_DIR;
  afterAll(() => {
    if (ORIG === undefined) delete process.env.POCKET_CLAUDE_CONFIG_DIR;
    else process.env.POCKET_CLAUDE_CONFIG_DIR = ORIG;
  });

  /** env 를 val 로 두고 fn 실행 후 항상 원복. */
  function withEnv(val: string | undefined, fn: () => void): void {
    const prev = process.env.POCKET_CLAUDE_CONFIG_DIR;
    if (val === undefined) delete process.env.POCKET_CLAUDE_CONFIG_DIR;
    else process.env.POCKET_CLAUDE_CONFIG_DIR = val;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.POCKET_CLAUDE_CONFIG_DIR;
      else process.env.POCKET_CLAUDE_CONFIG_DIR = prev;
    }
  }

  it("env 미설정 → false (실 DB 를 가리킴)", () => {
    withEnv(undefined, () => expect(isIsolatedConfigDir()).toBe(false));
  });

  it("env 빈문자열/공백뿐 → false", () => {
    withEnv("", () => expect(isIsolatedConfigDir()).toBe(false));
    withEnv("   ", () => expect(isIsolatedConfigDir()).toBe(false));
  });

  it("env == REAL_CONFIG_DIR(정확히 동일) → false (격리 아님 — 실 DB 보호 우선)", () => {
    withEnv(REAL_CONFIG_DIR, () => expect(isIsolatedConfigDir()).toBe(false));
  });

  it("REAL_CONFIG_DIR 의 끝슬래시·`/.`·`/./` 변형도 path.resolve 후 동일 → false", () => {
    // path.resolve 정규화 비교라, 표기만 다른 같은 경로는 «격리 아님» 으로 유지돼야 한다.
    withEnv(REAL_CONFIG_DIR + path.sep, () => expect(isIsolatedConfigDir()).toBe(false));
    withEnv(path.join(REAL_CONFIG_DIR, "."), () =>
      expect(isIsolatedConfigDir()).toBe(false),
    );
    withEnv(REAL_CONFIG_DIR + "/./", () => expect(isIsolatedConfigDir()).toBe(false));
  });

  it("env 가 실 경로와 다른 경로 → true (격리)", () => {
    withEnv("/tmp/some-other-isolated-dir", () =>
      expect(isIsolatedConfigDir()).toBe(true),
    );
    withEnv(H.configDir, () => expect(isIsolatedConfigDir()).toBe(true));
  });

  it("호출 시점의 env 를 읽는다 — 같은 함수가 토글에 따라 즉시 다른 값을 낸다", () => {
    const prev = process.env.POCKET_CLAUDE_CONFIG_DIR;
    try {
      process.env.POCKET_CLAUDE_CONFIG_DIR = REAL_CONFIG_DIR;
      expect(isIsolatedConfigDir()).toBe(false);
      process.env.POCKET_CLAUDE_CONFIG_DIR = "/some/other/dir";
      expect(isIsolatedConfigDir()).toBe(true);
      delete process.env.POCKET_CLAUDE_CONFIG_DIR;
      expect(isIsolatedConfigDir()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.POCKET_CLAUDE_CONFIG_DIR;
      else process.env.POCKET_CLAUDE_CONFIG_DIR = prev;
    }
  });
});

describe("readConfig — 파싱 실패 fail-closed", () => {
  beforeEach(cleanConfigDir);

  it("파일 없음 → null (throw 없음)", () => {
    expect(fs.existsSync(CONFIG_FILE)).toBe(false);
    expect(readConfig()).toBeNull();
    expect(() => readConfig()).not.toThrow();
  });

  it("JSON 깨짐 → null (throw 없음)", () => {
    ensureConfigDir();
    fs.writeFileSync(CONFIG_FILE, "{ not valid json ,,,");
    expect(readConfig()).toBeNull();
    expect(() => readConfig()).not.toThrow();
  });

  it("정상 JSON → DaemonConfig 로 파싱", () => {
    const cfg = baseCfg({ port: 1234, token: "t", sshPort: 22022 });
    ensureConfigDir();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg));
    expect(readConfig()).toEqual(cfg);
  });
});

describe("writeConfig — 디렉터리 자동생성 + 0600 + 라운드트립", () => {
  beforeEach(cleanConfigDir);

  it("CONFIG_DIR 이 없으면 자동 생성한다 (recursive)", () => {
    expect(fs.existsSync(CONFIG_DIR)).toBe(false);
    writeConfig(baseCfg());
    expect(fs.existsSync(CONFIG_DIR)).toBe(true);
    expect(fs.existsSync(CONFIG_FILE)).toBe(true);
  });

  it("새로 만든 파일 권한은 0o600 이다 (기본 0666/umask 가 아니라 명시 0600)", () => {
    writeConfig(baseCfg());
    const mode = fs.statSync(CONFIG_FILE).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("기존 0644 파일을 덮어쓰면 0600 으로 «좁혀진다» (BL-10 — 매 기록마다 chmod 보정)", () => {
    // fs.writeFileSync 의 mode 옵션은 O_CREAT(=새 파일 생성) 시점에만 적용되고 기존 파일
    // 재기록 시엔 무시된다(Node 의 POSIX open 의미론). 그래서 과거(옛 버전·수동 생성·umask)에
    // 느슨하게 만들어진 config.json 은 그냥 두면 0644 인 채 장기 비밀(ASC .p8 등)을 품는다.
    // BL-10 으로 writeConfig 가 매 기록마다 fs.chmodSync(…,0o600) 를 보정하므로 이제 «좁혀진다».
    ensureConfigDir();
    fs.writeFileSync(CONFIG_FILE, "{}");
    fs.chmodSync(CONFIG_FILE, 0o644); // umask 무관하게 전제를 정확히 0644 로 고정
    expect(fs.statSync(CONFIG_FILE).mode & 0o777).toBe(0o644);

    writeConfig(baseCfg({ port: 4321 }));
    expect(fs.statSync(CONFIG_FILE).mode & 0o777).toBe(0o600); // 0644 → 0600 으로 보정됨
    expect(readConfig()).toEqual(baseCfg({ port: 4321 })); // 내용도 갱신됨
  });

  it("writeConfig→readConfig 라운드트립이 동일 — 민감 필드(token/tokenHash/localAdminSecret) 무손실", () => {
    const rich: DaemonConfig = {
      port: 7777,
      sshPort: 22022,
      bindHost: "127.0.0.1",
      tokenHash: "a".repeat(64),
      token: "plaintext-pairing-token-keep-exact",
      createdAt: 1718000000000,
      localAdminSecret: "local-admin-secret-keep-exact",
      attestDevices: [
        { publicKey: "BASE64KEY-A==", registeredAt: 1718000000001 },
        { publicKey: "BASE64KEY-B==", registeredAt: 1718000000002 },
      ],
      attestPublicKey: "legacy-key",
      attestRegisteredAt: 1717000000000,
      extraDeviceSlotAllowed: true,
      lanOnly: false,
      notify: {
        discord: {
          webhookUrl: "https://discord.com/api/webhooks/1/abcdef",
          enabled: true,
          includePreview: false,
          events: { turnComplete: true, sessionExit: false },
        },
      },
    };
    writeConfig(rich);
    const back = readConfig();
    expect(back).toEqual(rich);
    // 민감 필드가 변형/유실되지 않았는지 명시 확인.
    expect(back?.token).toBe(rich.token);
    expect(back?.tokenHash).toBe(rich.tokenHash);
    expect(back?.localAdminSecret).toBe(rich.localAdminSecret);
    expect(back?.attestDevices).toEqual(rich.attestDevices);
  });
});

describe("resolvePoMultiPass — 다중 패스 설정 정규화(미설정=1패스/회귀 0)", () => {
  it("미설정이면 1패스·minAgree 1 (다중 패스 끔 — 기존 동작)", () => {
    expect(resolvePoMultiPass(baseCfg())).toEqual({ passes: 1, minAgree: 1 });
    expect(resolvePoMultiPass(null)).toEqual({ passes: 1, minAgree: 1 });
    expect(resolvePoMultiPass(undefined)).toEqual({ passes: 1, minAgree: 1 });
    expect(resolvePoMultiPass(baseCfg({ po: {} }))).toEqual({ passes: 1, minAgree: 1 });
    expect(resolvePoMultiPass(baseCfg({ po: { multiPass: {} } }))).toEqual({ passes: 1, minAgree: 1 });
  });

  it("passes 만 지정하면 minAgree 기본 2 (과반 합의의 최소), passes 보다 크지 않게", () => {
    expect(resolvePoMultiPass(baseCfg({ po: { multiPass: { passes: 3 } } }))).toEqual({
      passes: 3,
      minAgree: 2,
    });
    expect(resolvePoMultiPass(baseCfg({ po: { multiPass: { passes: 2 } } }))).toEqual({
      passes: 2,
      minAgree: 2,
    });
  });

  it("passes 는 [1, PO_MAX] 로 클램프 (비용 폭주 방지)", () => {
    expect(resolvePoMultiPass(baseCfg({ po: { multiPass: { passes: 99 } } })).passes).toBe(
      PO_MAX_GENERATION_PASSES,
    );
    expect(resolvePoMultiPass(baseCfg({ po: { multiPass: { passes: 0 } } })).passes).toBe(1);
    expect(resolvePoMultiPass(baseCfg({ po: { multiPass: { passes: -5 } } })).passes).toBe(1);
  });

  it("minAgree 는 [1, passes] 로 클램프 (절대 passes 초과 불가 — 영원히 채택 0 방지)", () => {
    expect(resolvePoMultiPass(baseCfg({ po: { multiPass: { passes: 2, minAgree: 5 } } }))).toEqual({
      passes: 2,
      minAgree: 2,
    });
    expect(resolvePoMultiPass(baseCfg({ po: { multiPass: { passes: 3, minAgree: 0 } } }))).toEqual({
      passes: 3,
      minAgree: 1,
    });
  });

  it("비숫자/소수는 안전 처리(반올림·fallback)", () => {
    expect(resolvePoMultiPass(baseCfg({ po: { multiPass: { passes: 2.6 } } })).passes).toBe(3);
    expect(
      resolvePoMultiPass(baseCfg({ po: { multiPass: { passes: NaN as unknown as number } } })).passes,
    ).toBe(1);
  });
});
