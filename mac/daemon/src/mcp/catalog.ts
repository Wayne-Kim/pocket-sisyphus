/**
 * MCP «도구» 제공자 카탈로그 — daemon 이 아는 1차 제공자(사용자 본인 Calendar/Gmail 서버)의
 * 정적 명세. 라벨 같은 «화면 노출» 문자열은 클라이언트(iOS)가 카탈로그 id 로 지역화한다 —
 * 여기 ko 라벨은 폴백/식별용이며, OAuth 표준 scope 문자열·URL 은 비번역(식별자)이다.
 *
 * 최소권한 원칙: 각 제공자는 «기본 읽기 전용» scope 와 «쓰기 opt-in» scope 를 분리해 둔다.
 * 사용자가 쓰기를 명시 opt-in 하지 않으면 readonly scope 만 부여된다.
 *
 * URL 은 «사용자 본인» 의 MCP 서버 base 다 — 이 카탈로그는 잘 알려진 기본값만 제시하고,
 * 사용자가 자기 서버 URL 로 덮어쓸 수 있다(라우트가 body.url 을 받는다). MCP 전송·OAuth
 * 동의 흐름 자체는 에이전트 CLI 의 네이티브 MCP 가 담당한다(daemon 은 등록·custody·헬스만).
 */

export type McpCatalogEntry = {
  /** 안정적 카탈로그 식별자 (비번역). */
  id: string;
  /** SF Symbol 힌트 — iOS 가 칩/행 아이콘으로 사용. */
  icon: string;
  /** 폴백 라벨 (ko). iOS 는 catalogId 로 자체 지역화한다. */
  label: string;
  /** 잘 알려진 기본 서버 URL. 사용자가 덮어쓸 수 있다. 빈 문자열이면 사용자 지정 필수. */
  defaultUrl: string;
  /** 기본(읽기 전용) scope — opt-in 없이 항상 부여. */
  readScopes: string[];
  /** 쓰기 scope — 사용자가 명시 opt-in 할 때만 read+write 로 부여. */
  writeScopes: string[];
};

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: "google_calendar",
    icon: "calendar",
    label: "캘린더",
    defaultUrl: "",
    readScopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
    writeScopes: ["https://www.googleapis.com/auth/calendar.events"],
  },
  {
    id: "gmail",
    icon: "envelope",
    label: "Gmail",
    defaultUrl: "",
    readScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    writeScopes: ["https://www.googleapis.com/auth/gmail.modify"],
  },
  {
    id: "custom",
    icon: "wrench.and.screwdriver",
    label: "사용자 지정",
    defaultUrl: "",
    readScopes: [],
    writeScopes: [],
  },
] as const;

export function getCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((e) => e.id === id);
}

/**
 * 카탈로그 제공자의 «효과적 scope» — 쓰기 opt-in 여부에 따라 최소권한으로 계산.
 * write=false → readScopes 만. write=true → readScopes + writeScopes (중복 제거).
 */
export function resolveScopes(entry: McpCatalogEntry, write: boolean): string[] {
  const base = [...entry.readScopes];
  if (write) {
    for (const s of entry.writeScopes) if (!base.includes(s)) base.push(s);
  }
  return base;
}
