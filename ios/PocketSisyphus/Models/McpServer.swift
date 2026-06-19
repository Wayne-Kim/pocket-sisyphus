import Foundation

/// 등록된 MCP 「도구」 서버 한 건 — daemon `/api/mcp` 의 toView() 와 1:1.
///
/// 경계: 토큰 본문은 daemon 쪽 config.json(0600)에만 살고 이 응답엔 «절대» 안 들어온다 — 폰은
/// 메타데이터(상태·scope·라벨)만 평문으로 받는다. status enum 하나로 색(연결=초록 / 만료·오류=
/// danger / 미설정=warning)을 분기한다.
struct McpServer: Codable, Identifiable, Equatable, Hashable {
    let id: String
    /// 카탈로그 제공자 id ("google_calendar" | "gmail" | "custom"). 라벨/아이콘 지역화 키.
    let catalogId: String
    /// 폴백 라벨 — iOS 는 catalogId 로 자체 지역화하고, 미지(custom)면 이 값을 그대로.
    let label: String
    let agent: String
    let repoPath: String
    /// remote MCP 전송 URL (식별자 — 번역 대상 아님).
    let url: String
    /// 부여된 OAuth scope (최소권한). 식별자 문자열 — 번역 대상 아님.
    let scopes: [String]
    /// 쓰기 scope 가 포함됐는지 (사용자 opt-in).
    let writeEnabled: Bool
    /// "unconfigured" | "connected" | "expired" | "error".
    let status: String
    let createdAt: Int64
    let connectedAt: Int64?
    let tokenExpiresAt: Int64?

    var statusValue: McpStatus { McpStatus(rawValue: status) ?? .error }
    var connectedDate: Date? { connectedAt.map { Date(timeIntervalSince1970: Double($0) / 1000) } }
}

/// MCP 서버 연결 상태 — 색·라벨 분기의 SSOT. 색은 «의미» 약속을 따른다(브리프 디자인 수용 기준):
/// 연결=success(초록) / 만료·오류=danger(빨강) / 미설정=warning(노랑). pro(주황)는 «고급 도구»
/// 그룹 «강조» 전용이지 상태색이 아니다 — 혼동 금지.
enum McpStatus: String {
    case unconfigured
    case connected
    case expired
    case error
}

/// 카탈로그 제공자 한 건 — daemon `/api/mcp/catalog` 와 1:1.
struct McpCatalogEntry: Codable, Identifiable, Equatable, Hashable {
    let id: String
    /// SF Symbol 이름 (식별자).
    let icon: String
    let label: String
    /// 잘 알려진 기본 서버 URL. 빈 문자열이면 사용자 지정 필수.
    let defaultUrl: String
    let readScopes: [String]
    let writeScopes: [String]
}

/// daemon `GET /api/mcp` 응답.
struct McpServersResponse: Codable { let servers: [McpServer] }
/// daemon `GET /api/mcp/catalog` 응답.
struct McpCatalogResponse: Codable { let catalog: [McpCatalogEntry] }
/// daemon `POST /api/mcp` · `/oauth` · `/revoke` 응답 (단건).
struct McpServerResponse: Codable { let server: McpServer? }

/// daemon `GET /api/mcp/:id` 의 health 블록.
struct McpHealth: Codable, Equatable {
    let id: String
    let status: String
    let reachable: Bool?
    let detail: String?
}
struct McpServerDetailResponse: Codable { let server: McpServer?; let health: McpHealth? }
