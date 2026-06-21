/**
 * MCP «능력 클래스» 정책 — CAPABILITY_CAPS.md §2.2 의 정본 spec 을 코드로 강제하는 순수 모듈.
 *
 * 배경(왜 이게 있어야 하나): docs/CAPABILITY_CAPS.md 는 taint·무인 trifecta 금지·MCP 최소권한을
 * 「정본」 으로 못박지만 구현이 0건이었다. 그런데 이 캡이 가드해야 할 개인-데이터 plane 은 이미
 * 가동 중 — mcp/catalog.ts 가 Gmail(쓰기 gmail.modify)·Calendar(쓰기 calendar.events)를 사용자
 * 노출 카탈로그로 제공하고, 등록 시 repo 의 .mcp.json 에 박혀 그 repo 의 무인(cron·워크플로우·
 * skip_permissions) 세션까지 도구를 물려받는다 → 사람 클릭 없이 ①사적 데이터 ②공격자 통제
 * 콘텐츠 ③외부 전송이 한 세션에 모이는 제로클릭 유출(EchoLeak/ShadowLeak류).
 *
 * 이 모듈은 «순수» 다 — DB/파일/네트워크 IO 없이 입력(서버 목록)만으로 분류·평가한다. IO 를
 * 거치는 게이트(.mcp.json 읽기·자동화 존재 조회)는 mcp/native.ts·mcp/unattended.ts 가 맡는다.
 * 순수하게 둬야 단위 테스트가 파일 I/O 없이 분류 규칙을 직접 검증할 수 있다(egress.ts 와 같은 결).
 */
import type { McpServerConfig } from "../config.js";

/**
 * §2.2 능력 클래스.
 *  - READ        : 밖으로 아무것도 안 보내는 읽기 (메일/캘린더 read, 파일 read, git ls-remote).
 *  - LOCAL       : 로컬 효과만, outbound 없음 (로컬 LLM, worktree 내 파일 쓰기, 로컬 빌드/테스트).
 *  - EGRESS      : 데이터가 신뢰 경계 밖으로 (메일 send · HTTP POST/PUT/DELETE · git push ·
 *                  임의 webhook/Discord · outbound MCP 도구). ③ 외부통신 leg.
 *  - SOURCE_WRITE: 개인-데이터 소스로의 write-back (메일 송신/이동/삭제, 캘린더 생성/수정/삭제).
 *
 * EGRESS·SOURCE_WRITE 가 «캡 대상». READ·LOCAL 은 기본 허용.
 */
export type CapabilityClass = "READ" | "LOCAL" | "EGRESS" | "SOURCE_WRITE";

/**
 * 무인 trifecta 정적 거부의 안정적 머신 코드 — iOS/Mac 가 이 코드로 메시지를 로컬라이즈한다
 * (한국어 원문을 화면에 그대로 찍지 않는다, cron 의 SkipReasonCode·라우트 에러코드와 같은 패턴).
 */
export const UNATTENDED_TRIFECTA_DENIED = "unattended_trifecta_denied" as const;

/** 개인-데이터(메일/캘린더) 카탈로그 id — §2.1 taint 소스. custom 은 정체 불명이라 여기 없다. */
const PERSONAL_DATA_CATALOG_IDS = new Set(["gmail", "google_calendar"]);

/**
 * 카탈로그 id + 쓰기 opt-in 으로 능력 클래스를 도출한다(서버 레코드 전에, 라우트 사전검증용).
 *  - 개인-데이터(gmail/calendar): write opt-in → SOURCE_WRITE, 읽기 전용 → READ.
 *  - custom / 미지(catalog 에 없는 id) → **EGRESS** (M2: 분류 불명은 보수적으로 EGRESS = 차단 우선).
 */
export function classifyCatalogEntry(catalogId: string, writeEnabled: boolean): CapabilityClass {
  if (PERSONAL_DATA_CATALOG_IDS.has(catalogId)) {
    return writeEnabled ? "SOURCE_WRITE" : "READ";
  }
  return "EGRESS";
}

/** 등록된 서버 레코드의 능력 클래스. classifyCatalogEntry 를 server.writeEnabled 로 적용. */
export function classifyServer(server: Pick<McpServerConfig, "catalogId" | "writeEnabled">): CapabilityClass {
  return classifyCatalogEntry(server.catalogId, server.writeEnabled === true);
}

/** EGRESS·SOURCE_WRITE 인가 (= 무인 경로에서 «미연결»·«정적 거부» 대상). */
export function isCappedClass(cls: CapabilityClass): boolean {
  return cls === "EGRESS" || cls === "SOURCE_WRITE";
}

/**
 * 이 서버가 §2.1 «개인-데이터 taint 소스» 인가 (메일/캘린더 — 읽기든 쓰기든). 읽기 전용이어도
 * 본문에 공격자 통제 콘텐츠(주입 메일/초대)가 실릴 수 있어 세션을 오염시키는 적재 경로다.
 * custom 은 정체 불명이라 taint 소스로 «세지 않되», 클래스가 EGRESS 라 무인 경로에선 어차피 차단된다.
 */
export function isTaintSourceServer(server: Pick<McpServerConfig, "catalogId">): boolean {
  return PERSONAL_DATA_CATALOG_IDS.has(server.catalogId);
}

/** 캡 대상(EGRESS·SOURCE_WRITE) 서버만 — 무인 경로에서 미연결돼야 할 것들. */
export function cappedServers(servers: readonly McpServerConfig[]): McpServerConfig[] {
  return servers.filter((s) => isCappedClass(classifyServer(s)));
}

/** 무인 경로에서 «연결 허용»(READ·LOCAL) 서버만. */
export function unattendedAllowedServers(servers: readonly McpServerConfig[]): McpServerConfig[] {
  return servers.filter((s) => !isCappedClass(classifyServer(s)));
}

/** 이 서버 목록 중 개인-데이터 taint 소스가 하나라도 있는가. */
export function hasTaintSource(servers: readonly McpServerConfig[]): boolean {
  return servers.some(isTaintSourceServer);
}

export type UnattendedMcpEvaluation = {
  /** 캡 대상이 하나도 없으면 무인 경로에 안전 (READ/LOCAL 만). */
  safe: boolean;
  /** 미연결돼야 할 캡 대상 서버들 (있으면 정적 거부 사유). */
  capped: McpServerConfig[];
};

/**
 * 한 실행 단위(무인 cron tick·워크플로우 run·PO 무인 구현)의 MCP 서버 집합을 §C1/M3 으로 평가:
 * EGRESS·SOURCE_WRITE 가 하나라도 있으면 unsafe. 순수 — 입력 목록만으로 판정한다.
 */
export function evaluateUnattendedMcp(servers: readonly McpServerConfig[]): UnattendedMcpEvaluation {
  const capped = cappedServers(servers);
  return { safe: capped.length === 0, capped };
}
