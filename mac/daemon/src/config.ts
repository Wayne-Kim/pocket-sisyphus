import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const APP_NAME = "PocketSisyphus";

// 테스트 / dev harness 에서 별도 디렉터리를 가리키고 싶을 때의 escape hatch — 환경변수가
// 있으면 그 값을 그대로 CONFIG_DIR 로 사용. 평소 운영 경로엔 이 env 가 없어 동작 동일.
// 사용처: mac/daemon/src/bin/lean-daemon.ts, e2e 테스트의 standalone harness, dev 멀티
// 인스턴스 실험 등.
/**
 * env 가 없을 때의 «실(=운영) 경로». 격리 판정(isolated 인지)을 위해 항상 노출한다 —
 * CONFIG_DIR 이 이 값과 같으면 «실 DB» 를 가리키는 것이다.
 */
export const REAL_CONFIG_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  APP_NAME,
);

export const CONFIG_DIR =
  process.env.POCKET_CLAUDE_CONFIG_DIR ?? REAL_CONFIG_DIR;

export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const DB_FILE = path.join(CONFIG_DIR, "pocket-sisyphus.db");

/**
 * 지금 가리키는 CONFIG_DIR 이 «격리 디렉터리» 인가 — `POCKET_CLAUDE_CONFIG_DIR` 가
 * 설정됐고, 그 값이 실 운영 경로(REAL_CONFIG_DIR)와 «다른» 경로일 때만 true.
 *
 * - env 미설정 → 실 DB 를 가리킴 → false.
 * - env 가 실 경로와 동일 → 격리 아님(실 DB 보호 우선) → false.
 * - env 가 다른 경로 → 격리 → true.
 *
 * 데모 시드/정리 같은 «쓰기» 가드가 db() 를 열기 전에 이 판정을 본다. import 시점이 아니라
 * 호출 시점의 process.env 를 읽어, 테스트가 env 를 바꿔가며 검증할 수 있게 한다.
 */
export function isIsolatedConfigDir(): boolean {
  const env = process.env.POCKET_CLAUDE_CONFIG_DIR;
  if (!env || env.trim() === "") return false;
  return path.resolve(env) !== path.resolve(REAL_CONFIG_DIR);
}

/**
 * Discord incoming webhook 알림 설정. 외부서버 0 원칙 그대로 — daemon 이 직접 사용자
 * 본인 Discord webhook 으로 outbound POST 한다 (푸시 전달은 Discord 인프라가 대행).
 * Mac 앱의 «Discord 알림 설정» 창이 이 값을 /api/notify/config 로 저장한다.
 */
export type DiscordNotifyConfig = {
  /** https://discord.com/api/webhooks/<id>/<token> — webhook POST 대상. */
  webhookUrl: string;
  /** false 면 URL 은 보존하되 모든 알림 발사 중단. */
  enabled: boolean;
  /**
   * 딥링크 브리지 페이지 base URL — 알림의 «Open in app» 링크가 거치는 정적 페이지.
   * 미지정이면 기본 GitHub Pages (notify/discord.ts 의 DEFAULT_DEEP_LINK_BRIDGE_BASE).
   * 사용자가 자기 GitHub Pages 등에 직접 호스팅한 브리지 페이지로 바꿀 수 있다.
   */
  deepLinkBaseUrl?: string;
  /** 이벤트별 on/off. 필드 누락 = true (켜짐) 로 간주. */
  events?: {
    /** 사용자 입력 후 출력이 잠잠해지면(턴 종료/입력 대기 추정) 알림. */
    turnComplete?: boolean;
    /** REPL 프로세스가 정상 종료됐을 때 알림. */
    sessionExit?: boolean;
    /** REPL 이 비정상 종료(exit code != 0 / signal)됐을 때 알림. */
    error?: boolean;
  };
  /**
   * turn_complete / still_waiting 알림 본문에 «에이전트의 마지막 출력 한~두 줄» 미리보기를
   * 싣는다. **기본 OFF (프라이버시 옵트인)** — 켜야 출력 일부가 외부 Discord 로 나간다.
   * 미설정/false 면 현재처럼 정적 안내문만. iOS 설정 「알림」 토글이 이 값을 켠다.
   */
  includePreview?: boolean;
};

export type NotifyConfig = {
  discord?: DiscordNotifyConfig;
};

/** 로컬 LLM 설정. 미설정이면 hardware.recommendModel() 결과를 런타임에 사용. */
export type LocalLlmConfig = {
  /** 사용자가 고른 catalog 모델 id. 미설정이면 추천 모델. */
  selectedModelId?: string;
  /** ctx 오버라이드. 미설정이면 model.ctxDefault. */
  ctxSize?: number;
};

/**
 * OpenCode «외부 엔드포인트» 모드 — 사용자가 이미 자기 Mac 에서 돌리는 OpenAI 호환 로컬
 * 서버(Ollama/LM Studio/vLLM 등)를 그대로 쓴다. 켜면 번들 llama-server(supervisor.ensureServer)
 * 를 건너뛰고 `baseUrl` 을 OpenCode 의 OPENAI_BASE_URL 로 주입한다 — «내 모델 그대로».
 *
 * 의도적으로 baseUrl + modelId 두 필드만. 키 요구 서버는 1차 비목표(로컬 서버는 대개 키리스).
 */
export type OpencodeExternalEndpoint = {
  /** true 면 외부 엔드포인트 사용, false/미설정이면 번들 llama-server. */
  enabled: boolean;
  /** OpenAI 호환 baseURL. 기본 http://localhost:11434/v1 (Ollama). 끝의 `/` 는 정규화됨. */
  baseUrl: string;
  /** 외부 서버의 /v1/models 가 보고하는 모델 id (요청 시 그대로 전달). */
  modelId: string;
};

/** OpenCode 어댑터 설정. 현재는 외부 엔드포인트 모드만. 미설정이면 번들 llama-server. */
export type OpencodeConfig = {
  external?: OpencodeExternalEndpoint;
};

/** OpenCode 외부 엔드포인트의 기본 baseURL — Ollama 의 OpenAI 호환 경로. */
export const OPENCODE_DEFAULT_EXTERNAL_BASE_URL = "http://localhost:11434/v1";

/**
 * MCP «도구» 서버 등록 — 에이전트가 사용자 본인 Calendar/Gmail 등 MCP 서버에 붙어 메일·일정을
 * 도구로 쓰게 한다. 외부서버 0 원칙 그대로: MCP 전송·OAuth 인가 흐름 자체는 에이전트 CLI 의
 * 네이티브 MCP(.mcp.json / `claude mcp add`)에 위임하고, daemon 은 «서버 등록 + 토큰 custody +
 * 헬스» 만 소유한다. 이 레코드(0600 config.json)는 폰/QR 에 절대 안 들어가는 «토큰 custody» 의
 * 집이다 — 폰엔 메타데이터(이름·상태·scope)만 평문으로 노출하고, OAuth access/refresh 토큰은
 * 여기 0600 에만 산다.
 */
export type McpServerConfig = {
  /** 안정적 식별자 (randomUUID). .mcp.json 의 서버 키이자 라우트 path 파라미터. */
  id: string;
  /** 카탈로그 제공자 id (예: "google_calendar", "gmail") 또는 "custom". */
  catalogId: string;
  /** 사용자에게 보일 라벨. 카탈로그 기본값 또는 사용자 지정. 클라가 카탈로그로 지역화. */
  label: string;
  /** 이 서버를 등록할 에이전트 (claude_code 등). 에이전트별 .mcp.json 에 기록. */
  agent: string;
  /** 등록할 프로젝트(repo) 절대경로 — 에이전트 CLI 가 .mcp.json 을 읽는 곳. */
  repoPath: string;
  /** MCP remote 전송 URL (http/sse). OAuth 보호 리소스(RFC 9728)의 base. */
  url: string;
  /**
   * 부여된 OAuth scope 들. 최소권한 — 기본 읽기 전용(예: calendar.events.readonly).
   * 쓰기(create/update/delete) scope 는 사용자가 명시 opt-in 할 때만 포함된다.
   */
  scopes: string[];
  /** true 면 쓰기 scope 가 포함됨(사용자 opt-in). UI 가 «쓰기 허용» 배지로 표기. */
  writeEnabled: boolean;
  /**
   * 토큰 custody 상태 — daemon 이 소유. 폰엔 이 enum 만 평문으로 나가고 토큰 자체는 안 나간다.
   *  - "unconfigured": 등록만 됨, 아직 OAuth 동의 안 함 → iOS 「연결 필요」(warning).
   *  - "connected": 유효 토큰 보관 중 → iOS 초록.
   *  - "expired": 토큰 만료/refresh 실패 → iOS danger(빨강).
   *  - "error": 등록/헬스 오류 → iOS danger.
   */
  status: "unconfigured" | "connected" | "expired" | "error";
  /** 등록 시각 (epoch ms). */
  createdAt: number;
  /** 마지막 OAuth 동의 완료 시각 (epoch ms). 없으면 미동의. */
  connectedAt?: number;
  /** access token 만료 추정 시각 (epoch ms) — custody 메타. 토큰 본문은 저장하지 않는다. */
  tokenExpiresAt?: number;
  /** 마지막 헬스 점검 시 관측한 오류 메시지 (진단용). */
  lastError?: string;
};

/** MCP 도구 전체 설정 — 등록된 서버 목록. */
export type McpConfig = {
  servers?: McpServerConfig[];
};

/**
 * App Store Connect API 키 — PO 수집의 «스토어 리뷰» 신호 소스용. 외부서버 0 원칙 그대로
 * daemon 이 직접 ASC API 로 outbound 호출하고, 키는 이 config(0600) 에만 산다.
 * Mac 앱의 설정 «App Store» 탭이 /api/po/asc-key 로 저장한다. 폰(QR)에는 절대 안 들어간다.
 */
export type AscConfig = {
  /** ASC API Key ID (예: 2X9R4HXF34). */
  keyId: string;
  /** ASC API Issuer ID (UUID). */
  issuerId: string;
  /** .p8 비밀키(PKCS#8 PEM) 본문 전체 — 파일 경로가 아니라 내용을 박제 (파일 이동에 안 깨지게). */
  privateKeyPem: string;
};

/**
 * PO 제안 생성의 «다중 패스 합치 채택» 설정. **기본 미설정 = 1패스(끔)** — 켜지 않으면 기존과
 * 완전히 동일하게 한 번 생성한 결과를 그대로 ingest 한다(회귀 0).
 *
 * 배경: 한 회차의 단일 생성은 모델 임의성 때문에 제안의 질·점수가 들쭉날쭉하다. 같은 기회를
 * 여러 «독립» 패스에서 반복해 내놓은 것만 채택하면 그 변동을 줄일 수 있다. 비용(토큰/시간)은
 * 패스 수에 비례해 늘므로 패스 수와 채택 기준(minAgree)을 둘 다 사용자가 조절한다.
 */
export type PoMultiPassConfig = {
  /**
   * 독립 생성 패스 수. 1(기본/미설정) = 다중 패스 끔(기존 동작). 2..PO_MAX_GENERATION_PASSES =
   * 합치 채택. 범위 밖 값은 resolvePoMultiPass 가 클램프한다.
   */
  passes?: number;
  /**
   * 채택 최소 합치 수 — 이 수 «이상» 의 패스에 의미상 반복 등장한 제안만 채택. 미설정이면
   * 다중 패스가 켜졌을 때 2(과반 합의의 최소), 1패스면 1. passes 보다 클 수 없다(클램프).
   */
  minAgree?: number;
};

/** PO(제안 생성) 관련 daemon 설정. 현재는 다중 패스 합치 채택만. */
export type PoConfig = {
  multiPass?: PoMultiPassConfig;
};

/** 한 수집 사이클이 돌릴 수 있는 생성 패스 수의 «절대» 상한 — 비용 폭주 방지. */
export const PO_MAX_GENERATION_PASSES = 5;

export type DaemonConfig = {
  port: number;
  /** sshd 가 listen 할 포트. 미지정이면 22022. 환경에 따라 22022 가 점유될 수 있어 사용자가
   *  「포트 설정」 에서 바꿀 수 있다. 직접 SSH(UPnP) + Tor onion(virtual 22) 둘 다 이 포트로 forward. */
  sshPort?: number;
  bindHost?: string;          // 비워두면 127.0.0.1 (Tor sidecar가 외부 노출 담당)
  tokenHash: string;          // sha256(token) — 토큰 검증용
  token?: string;             // 평문 토큰 (QR 페어링 출력용). 0600 파일에 보관.
  createdAt: number;
  /** 알림 채널 설정 (현재 Discord webhook 만). 미설정이면 알림 비활성. */
  notify?: NotifyConfig;
  /** 로컬 LLM (llama-server) 설정 — 선택 모델 등. 미설정이면 하드웨어 추천 사용. */
  localLlm?: LocalLlmConfig;
  /** OpenCode 어댑터 설정 — 외부 엔드포인트 모드 등. 미설정이면 번들 llama-server. */
  opencode?: OpencodeConfig;
  /** App Store Connect API 키 — PO 수집의 스토어 리뷰 신호용. 미설정이면 리뷰 수집 안 함. */
  asc?: AscConfig;
  /** MCP «도구» 서버 등록 — 에이전트가 붙을 사용자 본인 Calendar/Gmail 등. 토큰 custody 0600. */
  mcp?: McpConfig;
  /**
   * 로컬 운영자(=같은 머신의 Mac 앱) 전용 비밀. 페어링 토큰과 «별개» 이고 QR 에 절대 안 들어간다
   * — 폰은 이 값을 가질 수 없다. Mac 앱은 config.json 을 직접 읽어 이 값을 X-PS-Local 헤더로
   * 실어, attest 가 강제된 뒤에도 자기 /api/* 호출(설정·회전 등)이 막히지 않게 한다.
   * init/부팅 시 없으면 1회 생성.
   */
  localAdminSecret?: string;
  /**
   * @deprecated 단일 기기 모델의 레거시 필드. 신규는 `attestDevices` 배열을 쓴다.
   * 기존 페어링 사용자의 config 호환을 위해 «읽기» 만 지원 — `listAttestDevices()` 가
   * 1원소로 흡수한다. 새 기기 등록·회전 시점에 attestDevices 로 마이그레이션되며 비워진다.
   */
  attestPublicKey?: string;
  /** @deprecated attestPublicKey 등록 시각 (epoch ms). 레거시. */
  attestRegisteredAt?: number;
  /**
   * 페어링된 폰들의 Secure Enclave P-256 공개키 목록 (최대 `MAX_DEVICE_SLOTS`개).
   * 하나라도 등록되면 그 시점부터 daemon 이 `/api/*`·WS 에 challenge-response 기기 인증을
   * «강제»한다 (목록 중 «어느» 키로든 서명이 검증되면 통과). 미설정/빈 배열이면 soft 모드 —
   * 옛 iOS / 미등록 기기 호환을 위해 통과시킴. 회전(rotate-pairing) 시 비워진다.
   */
  attestDevices?: AttestDevice[];
  /**
   * Egress confinement — «LAN 전용 모드». **기본 false(미설정=꺼짐).** true 면 daemon 의
   * «비-LAN» outbound(공인 IP echo·UPnP/NAT-PMP·App Store Connect·Discord webhook)를 기본
   * deny 로 게이트한다 — 사내망 밖으로 메타데이터/트래픽이 나가지 않음을 보증하는 통제.
   * 단일 게이트는 `egress.ts`(`guardNonLanEgress`), 위협 모델은 docs/THREAT_MODEL.md §5.11.
   * 폰↔Mac 사적 데이터 plane(LAN 직결/sshd/endpoint)은 게이트 대상이 아니다. 모드 OFF 시
   * 기존 동작 회귀 0.
   *
   * 같은 플래그를 `routes/endpoint.ts` 도 읽어 `/endpoint` 광고에서 공인 IPv4/IPv6·onion 을
   * 빼고 direct_lan(사설/링크로컬·mDNS)만 남긴다 — 폰의 LAN 전용 정책과 짝(이중 fail-closed).
   * Mac 「포트」 설정 토글이 이 값을 쓰고 daemon 을 재시작한다.
   */
  lanOnly?: boolean;
  /**
   * «추가 기기 슬롯» 허용 여부. **기본 false** — 사용자가 Mac 설정 「기기」 탭에서
   * 명시적으로 켜야만 1대를 넘는 기기가 등록될 수 있다. false 면 등록 가능한 기기는 1대,
   * true 면 절대 상한(`MAX_DEVICE_SLOTS`)까지. `allowedDeviceSlots()` 가 이 값을
   * 1↔MAX_DEVICE_SLOTS 슬롯으로 해석한다(이진 토글 모델 — off=1·on=최대).
   */
  extraDeviceSlotAllowed?: boolean;
  /** PO 제안 생성 설정 — 다중 패스 합치 채택 등. 미설정이면 1패스(기존 동작). */
  po?: PoConfig;
};

/** 페어링된 폰 1대의 Secure Enclave 등록 정보 (`attestDevices` 의 원소). */
export type AttestDevice = {
  /** SE P-256 공개키 (base64, X9.63 uncompressed 65B). */
  publicKey: string;
  /** 등록 시각 (epoch ms). 표시/진단용. */
  registeredAt: number;
};

/** 연결 가능한 인증 기기의 «절대» 상한. 슬롯 토글을 켜도 이 수를 넘지 못한다. */
export const MAX_DEVICE_SLOTS = 3;

/**
 * 정규화된 등록 기기 목록. 신규 `attestDevices` 가 있으면 그대로, 없고 레거시
 * `attestPublicKey` 만 있으면 1원소로 흡수해 반환. 둘 다 없으면 빈 배열.
 * 호출부는 이 함수만 보면 단일/다중 모델 차이를 신경 쓸 필요가 없다.
 */
export function listAttestDevices(cfg: DaemonConfig | null | undefined): AttestDevice[] {
  if (!cfg) return [];
  if (cfg.attestDevices && cfg.attestDevices.length > 0) {
    return cfg.attestDevices.slice(0, MAX_DEVICE_SLOTS);
  }
  if (cfg.attestPublicKey) {
    return [{ publicKey: cfg.attestPublicKey, registeredAt: cfg.attestRegisteredAt ?? 0 }];
  }
  return [];
}

/**
 * 현재 등록을 «허용» 하는 기기 슬롯 수. 기본 1, 사용자가 추가 기기 슬롯을 켜면
 * `MAX_DEVICE_SLOTS`(최대). 이미 등록된 기기 수와 무관 — 「얼마까지 새로 등록 가능한가」 의
 * 상한이다.
 */
export function allowedDeviceSlots(cfg: DaemonConfig | null | undefined): number {
  return cfg?.extraDeviceSlotAllowed ? MAX_DEVICE_SLOTS : 1;
}

export function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

export function readConfig(): DaemonConfig | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as DaemonConfig;
  } catch {
    return null;
  }
}

export function writeConfig(cfg: DaemonConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // `mode` 는 open(O_CREAT) 에 전달되어 «생성 시」에만 적용된다 — 기존 파일 재기록 땐
  // 무시되므로(과거 느슨한 권한·umask·수동 생성), authorized_keys 처럼 매번 0600 으로 보정한다.
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // 권한 보정 실패는 치명적이지 않음 — 다음 기록에서 재시도.
  }
}

/** 유한 정수로 강제 + [lo,hi] 클램프. 비숫자/비유한은 fallback. */
function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * PO 다중 패스 설정을 «실행 가능한» 값으로 정규화 — 미설정/이상값을 안전한 기본으로 해석한다.
 *  - passes: [1, PO_MAX_GENERATION_PASSES] 로 클램프. 미설정/이상값 → 1(끔).
 *  - minAgree: [1, passes] 로 클램프. 미설정이면 passes>1 일 때 2, 1패스면 1.
 *
 * passes===1 이면 minAgree 도 항상 1 로 떨어져 «모든 패스에 등장 = 그 한 패스» → 합치 채택이
 * 사실상 통과(no-op)가 된다. 호출부는 passes===1 을 «다중 패스 끔(기존 경로)» 으로 분기한다.
 */
export function resolvePoMultiPass(cfg: DaemonConfig | null | undefined): {
  passes: number;
  minAgree: number;
} {
  const raw = cfg?.po?.multiPass;
  const passes = clampInt(raw?.passes, 1, PO_MAX_GENERATION_PASSES, 1);
  const defaultMinAgree = passes > 1 ? 2 : 1;
  const minAgree = clampInt(raw?.minAgree, 1, passes, defaultMinAgree);
  return { passes, minAgree };
}
