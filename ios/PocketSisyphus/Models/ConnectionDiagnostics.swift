import SwiftUI

/// daemon `GET /api/diagnostics` 의 서브시스템 «읽기 전용» 진단 스냅샷 — `mac/daemon/src/routes/
/// diagnostics.ts` 의 `DiagnosticsResponse` 와 1:1.
///
/// 경계: daemon 은 UI 표면이 없어 «사용자 문구» 를 만들지 않는다 — 안정적 코드(식별자)·원시 숫자·
/// boolean 만 내보낸다. 색·사람이 읽는 제목·권장 조치·시각/바이트 포맷은 «전부» 여기(iOS)서 한다.
/// 색은 이 레포의 «의미» 약속을 따른다(DesignTokens 의 색상 정책):
///   ok=success(초록) · warning=warning(노랑) · error=danger(빨강) · unknown=secondary(중립·자동 적응).
/// warning(노랑)↔pro(주황) 혼동 금지 — 진단은 프리미엄이 아니라 pro(주황)를 쓰지 않는다.
struct DiagnosticsResponse: Codable, Equatable {
    let v: Int
    /// 스냅샷 생성 시각 (epoch ms).
    let generatedAt: Int64
    /// 서브시스템 중 가장 나쁜 심각도 ("ok" | "warning" | "error" | "unknown").
    let overall: String
    let subsystems: [DiagnosticSubsystem]

    var overallLevel: DiagnosticLevel { DiagnosticLevel(apiValue: overall) }
}

/// 한 서브시스템(Tor·sshd·디스크 등)의 상태. `id` 는 식별자(번역 대상 아님) — iOS 가 표시명으로 매핑.
struct DiagnosticSubsystem: Codable, Equatable, Identifiable {
    /// "tor" | "sshd" | "reachability" | "agent_cli" | "disk" | "logs" | "network". 식별자.
    let id: String
    let level: String
    let code: String
    let metrics: DiagnosticMetrics?
    /// 서브시스템 안의 개별 항목 (예: 에이전트 CLI 하나).
    let items: [DiagnosticItem]?

    var levelEnum: DiagnosticLevel { DiagnosticLevel(apiValue: level) }
    var codeEnum: DiagnosticCode { DiagnosticCode(apiValue: code) }

    /// 서브시스템 표시명 — id(식별자)를 사람이 읽는 localize 문구로. 미지 id 는 그대로 노출.
    var displayName: String {
        switch id {
        case "tor": return String(localized: "Tor 네트워크")
        case "sshd": return String(localized: "SSH 서버")
        case "reachability": return String(localized: "외부 연결성")
        case "agent_cli": return String(localized: "에이전트 CLI")
        case "disk": return String(localized: "디스크 공간")
        case "logs": return String(localized: "로그")
        case "network": return String(localized: "네트워크 · IP")
        default: return id
        }
    }

    /// SF Symbol — 서브시스템 식별 아이콘 (상태 아이콘과 별개의 «무엇» 표시).
    var symbol: String {
        switch id {
        case "tor": return "globe.americas"
        case "sshd": return "terminal"
        case "reachability": return "wifi"
        case "agent_cli": return "cpu"
        case "disk": return "internaldrive"
        case "logs": return "doc.text"
        case "network": return "network"
        default: return "questionmark"
        }
    }
}

/// 서브시스템 안의 개별 항목 — 에이전트 CLI 하나처럼 여러 개가 묶이는 경우.
struct DiagnosticItem: Codable, Equatable, Identifiable {
    let id: String
    /// 사람 친화 이름(예: "Claude Code") — 식별자성. verbatim 표시.
    let label: String
    let level: String
    let code: String
    /// 코드성 보조 문자열(예: 설치 명령 installHint) — 번역 대상 아님, monospace 표시.
    let detail: String?

    var levelEnum: DiagnosticLevel { DiagnosticLevel(apiValue: level) }
    var codeEnum: DiagnosticCode { DiagnosticCode(apiValue: code) }
}

/// 표시용 원시 지표 — 전부 옵셔널(서브시스템마다 관련 필드만 채워짐). iOS 가 사람이 읽는
/// 형식(바이트→사람 단위, epoch→날짜)으로 포맷한다. 모르는 키는 nil(additive-safe).
struct DiagnosticMetrics: Codable, Equatable {
    var torProcessAlive: Bool? = nil
    var torBootstrapPercent: Int? = nil
    var onionPublished: Bool? = nil
    var sshListening: Bool? = nil
    var sshPort: Int? = nil
    var diskFreeBytes: Int64? = nil
    var diskTotalBytes: Int64? = nil
    var unifiedLogBytes: Int64? = nil
    var ptyChunkCount: Int? = nil
    var lanOnly: Bool? = nil
    var lanCandidateCount: Int? = nil
    var externalIPv4Present: Bool? = nil
    var ipFetchedAt: Int64? = nil
    var lastIpChangeAt: Int64? = nil
    var lastReconnectAt: Int64? = nil
}

// MARK: - 심각도 → 색·아이콘·라벨 (이 레포 색상 약속의 SSOT 매핑)

/// 진단 심각도. 색은 «의미» 약속 그대로 — 장식·강조로 status 색을 빌려 쓰지 않는다.
enum DiagnosticLevel: String {
    case ok
    case warning
    case error
    case unknown

    /// 모르는 값은 unknown 으로 — 미래의 daemon 이 새 level 을 보내도 안전하게 폴백.
    init(apiValue: String) { self = DiagnosticLevel(rawValue: apiValue) ?? .unknown }

    /// 상태색 — 본문/배경은 .primary/.secondary 를 쓰고, 이 tint 는 «상태 아이콘/배지» 전용.
    var tint: Color {
        switch self {
        case .ok: return Theme.success        // 초록
        case .warning: return Theme.warning    // 노랑 (주의/설정 필요)
        case .error: return Theme.danger       // 빨강 (실패)
        case .unknown: return .secondary       // 중립·자동 적응 (정보·보조)
        }
    }

    var icon: String {
        switch self {
        case .ok: return "checkmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .error: return "xmark.octagon.fill"
        case .unknown: return "questionmark.circle"
        }
    }

    /// 사람이 읽는 상태 라벨 — 상태 아이콘의 accessibilityLabel + 배지 텍스트로 쓴다.
    var localizedLabel: String {
        switch self {
        case .ok: return String(localized: "정상")
        case .warning: return String(localized: "주의 필요")
        case .error: return String(localized: "오류")
        case .unknown: return String(localized: "확인 불가")
        }
    }
}

// MARK: - 안정적 코드 → 사람이 읽는 제목·권장 조치 (localize)

/// 연결/런타임 실패의 안정적 식별자 — `mac/daemon/src/diagnostics/codes.ts` 의 `DiagnosticCode`
/// 와 손으로 짝지어 관리한다. daemon 은 이 코드만 내보내고, 「왜·무엇을 하라」 문구는 여기서 매핑.
enum DiagnosticCode: String {
    case ok
    case unknown
    case torProcessDown = "tor_process_down"
    case torNotBootstrapped = "tor_not_bootstrapped"
    case torDescriptorMissing = "tor_descriptor_missing"
    case sshNotListening = "ssh_not_listening"
    case sshHostkeyMismatch = "ssh_hostkey_mismatch"
    case lanBlockedNoPublicFallback = "lan_blocked_no_public_fallback"
    case agentCliMissing = "agent_cli_missing"
    case diskLow = "disk_low"
    case diskCritical = "disk_critical"
    case logOversized = "log_oversized"

    /// 모르는 코드는 unknown 으로 폴백 — 미래 daemon 의 새 코드도 안전하게 처리.
    init(apiValue: String) { self = DiagnosticCode(rawValue: apiValue) ?? .unknown }

    /// 사람이 읽는 «왜» 한 줄. ok 는 nil(정상은 상태 라벨로 충분).
    var localizedTitle: String? {
        switch self {
        case .ok: return nil
        case .unknown: return String(localized: "상태를 확인할 수 없어요")
        case .torProcessDown: return String(localized: "Tor가 실행되고 있지 않아요")
        case .torNotBootstrapped: return String(localized: "Tor 연결을 준비하는 중이에요")
        case .torDescriptorMissing: return String(localized: "Tor 주소를 게시하지 못했어요")
        case .sshNotListening: return String(localized: "SSH 서버가 응답하지 않아요")
        case .sshHostkeyMismatch: return String(localized: "서버 호스트 키가 바뀌었어요")
        case .lanBlockedNoPublicFallback: return String(localized: "연결할 사설 주소가 없어요 (LAN 전용)")
        case .agentCliMissing: return String(localized: "에이전트 CLI가 설치돼 있지 않아요")
        case .diskLow: return String(localized: "디스크 여유 공간이 부족해요")
        case .diskCritical: return String(localized: "디스크 공간이 매우 부족해요")
        case .logOversized: return String(localized: "로그가 비정상적으로 커졌어요")
        }
    }

    /// 권장 조치 — 「무엇을 하라」. 없으면 nil.
    var localizedAction: String? {
        switch self {
        case .ok, .unknown: return nil
        case .torProcessDown:
            return String(localized: "Mac 앱을 재시작하세요. 자동 복구를 시도하지만 계속되면 재시작이 필요해요.")
        case .torNotBootstrapped:
            return String(localized: "Tor 회로를 만드는 중이에요. 잠시 기다리면 자동으로 연결돼요.")
        case .torDescriptorMissing:
            return String(localized: "잠시 기다린 뒤 다시 시도하세요. 문제가 계속되면 Mac 앱을 재시작하거나 페어링을 다시 하세요.")
        case .sshNotListening:
            return String(localized: "Mac 앱을 재시작하세요. 포트가 다른 프로그램에 점유됐다면 Mac의 포트 설정에서 바꿀 수 있어요.")
        case .sshHostkeyMismatch:
            return String(localized: "Mac을 재설치했다면 페어링을 다시 하세요. 그렇지 않다면 서버 위장(중간자)일 수 있어 직접 연결을 차단했어요.")
        case .lanBlockedNoPublicFallback:
            return String(localized: "같은 Wi‑Fi에 연결하거나, 설정에서 LAN 전용 모드를 끄면 외부 경로로 연결할 수 있어요.")
        case .agentCliMissing:
            return String(localized: "아래 설치 명령으로 에이전트 CLI를 설치하면 그 에이전트로 세션을 만들 수 있어요.")
        case .diskLow:
            return String(localized: "저장 공간을 확보하세요. 로그·세션 기록 저장이 실패할 수 있어요.")
        case .diskCritical:
            return String(localized: "지금 저장 공간을 확보하세요. 세션 기록과 로그가 저장되지 않을 수 있어요.")
        case .logOversized:
            return String(localized: "동작에는 문제가 없지만, 로그 정리를 권장해요.")
        }
    }
}
