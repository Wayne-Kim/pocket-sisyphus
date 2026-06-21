import Foundation

extension Notification.Name {
    /// daemon 이 426 Upgrade Required 로 응답해 우리가 너무 옛버전임을 통보받았을 때.
    /// userInfo: ["minRequired": String, "clientVersion": String].
    /// VersionCompatStore 가 listen 해서 verdict 를 `.hardClientTooOld` 로 즉시 전환한다.
    ///
    /// 이 채널이 필요한 이유: ApiClient 는 어디서나 만들어지고 (SessionsView, ChatView, …)
    /// VersionCompatStore 를 알지 못한다. 그렇다고 ApiClient 생성자에 매번 store 를
    /// 끼우는 건 침습적. 표준 iOS 패턴인 NotificationCenter 로 느슨하게 묶는다.
    static let clientTooOldDetected = Notification.Name("PocketSisyphus.clientTooOldDetected")
}

// MARK: - iOS 측 호환성 선언 (single source of truth)
//
// daemon 측 `mac/daemon/src/version.ts` 와 짝이다. 양쪽 모두 자기 자신의 버전,
// 상대편의 최소 지원 버전, 자기가 지원하는 capability 집합을 박아 빌드된다.
//
// # 누가 무엇을 알 수 있는가?
//
//   Hard incompat              → 양쪽 모두 자기 minPeerVersion 으로 판정 가능
//   새로 추가된 기능 (신버전)   → 신버전 쪽만 알 수 있음 (구버전엔 코드 자체가 없음)
//   제거/Deprecated 된 기능    → 신버전 쪽만 알 수 있음
//
// 그래서 실무적으로는 "그 기능을 트리거하는 쪽" 이 안내 책임을 진다. 부팅 시
// 핸드셰이크는 Hard incompat 차단 + Soft incompat 배너용. 기능 단위 인라인
// 안내는 각 기능 시작 지점에서 별도 capability 체크로 (향후 확장).

enum VersionCompat {
    /// iOS 앱이 받아들이는 daemon 의 최소 버전. 이보다 낮은 daemon 과 페어된 경우
    /// IncompatibleView 가 「Mac 앱 업데이트 필요」 로 차단.
    ///
    /// 0.2.0 = `/api/version` 엔드포인트가 처음 들어간 daemon. 이전 빌드는
    /// 그 엔드포인트가 없어서 클라이언트가 "구 daemon" 으로 판정 → 같은 화면.
    static let minSupportedDaemonVersion = "0.2.0"

    /// 이 iOS 빌드가 기대하는 daemon capability 식별자 집합.
    /// daemon 응답에 없는 것이 발견되면 Soft incompat 배너에 나열된다.
    ///
    /// daemon 의 `DAEMON_CAPABILITIES` 와 손으로 짝지어 관리한다. 새 기능 추가
    /// 시 양쪽 동시에 같은 식별자로 들어가야 호환성 시그널이 정상 동작한다.
    static let expectedDaemonCapabilities: [String] = [
        "ws_v1",
        "session_poll_v1",
        "session_clear_v1",
        "session_rename_v1",
        "skip_permissions_v1",
        "approvals_always_allow_v1",
        "recent_projects_v1",
        "ws_catchup_v1",
        "multi_agent_v1",
        // PATCH /api/sessions/:id { notifyMuted } — 세션 단위 알림 음소거 (ChatView bell 토글).
        "session_notify_mute_v1",
        // GET /api/sessions/:id/usage — 세션 agent 의 토큰 잔량 (더보기 메뉴 잔량 row).
        "agent_usage_v1",
    ]

    /// 현재 빌드의 iOS 앱 버전 (예: "0.2.4"). `CFBundleShortVersionString`.
    /// 사용자 안내 메시지 안에 그대로 노출된다.
    static var currentAppVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }
}

// MARK: - daemon `/api/version` 응답 디코드 타입

/// `/api/version` 응답. daemon 의 `VersionResponse` 와 1:1.
///
/// 필드를 *추가* 하는 것은 안전 (Swift Codable 은 모르는 키 ignore). 기존 필드를
/// 제거하거나 타입을 바꾸면 호환성 깨짐 — 그건 새 capability 식별자 + min
/// version ↑ 으로 명시한다.
struct ServerVersionInfo: Codable, Equatable {
    let daemonVersion: String
    let minSupportedClientVersion: String
    let capabilities: [String]
    /// daemon 이 보고한 마지막 사일런트 업데이트 결과 (있을 때만). 설치 성공은 relaunch 로
    /// daemon 이 재시작되며 사라지므로 여기 안 담긴다 (버전 ↑ 가 «완료» 신호). 따라서
    /// state 는 "no_update" | "error" 만. optional 이라 구 daemon 응답도 안전하게 디코드.
    let lastUpdate: UpdateStatusInfo?

    /// Mac 앱이 «무클릭 사일런트 강제 업데이트» 를 지원하는가. iOS 가 트리거 후 UX 를
    /// 「강제 업데이트 중 → 곧 재연결」 vs 옛 「Mac 화면에서 Sparkle 확인」 으로 분기.
    var supportsSilentUpdate: Bool { capabilities.contains("silent_update_v1") }

    /// daemon 이 예약 작업(cron) 을 지원하는가. iOS 가 설정 메뉴에 「예약 작업」 진입점을
    /// 노출할지 분기 (없으면 숨김 — soft incompat).
    var supportsCron: Bool { capabilities.contains("cron_v1") }

    /// daemon 이 멀티 에이전트 워크플로우를 지원하는가. iOS 가 「워크플로우」 진입점을 노출할지
    /// 분기 (없으면 숨김 — soft incompat).
    var supportsWorkflow: Bool { capabilities.contains("workflow_v1") }

    /// daemon 이 MCP 「도구」(에이전트가 붙을 Calendar/Gmail 등 사용자 본인 MCP 서버 등록·연결·
    /// 헬스) 를 지원하는가. iOS 가 설정에 「도구」 진입점을 노출할지 분기 (없으면 숨김 — soft.
    /// 옛 daemon 은 /api/mcp 가 404 라 보여주면 거짓 UI).
    var supportsMcpTools: Bool { capabilities.contains("mcp_tools_v1") }

    /// daemon 이 서브시스템 «연결 진단» 스냅샷(GET /api/connection-diagnostics) 을 지원하는가. iOS 가
    /// 설정에 「연결 진단」 진입점을 노출할지 분기 (없으면 숨김 — soft. 옛 daemon 은 이 라우트가 404
    /// 라 보여주면 거짓 UI). expectedDaemonCapabilities 에는 넣지 않는다 («있으면 노출»). (별개의
    /// supportsDiagnostics(diagnostics_v1) 는 «문제 신고/진단 번들».)
    var supportsConnectionDiagnostics: Bool { capabilities.contains("connection_diagnostics_v1") }

    /// daemon 이 라이브 웹 미리보기를 지원하는가. iOS 가 ChatView 에 「결과(웹 미리보기)」
    /// 진입점을 노출할지 분기 (없으면 숨김 — soft, 옛 daemon 엔 경고 없이 그냥 안 보임).
    /// expectedDaemonCapabilities 에는 넣지 않는다 — «없으면 경고» 가 아니라 «있으면 노출».

    /// daemon 이 산출물(artifacts) 발견/서빙을 지원하는가. «결과» 시트의 «산출물» 세그먼트 게이트.
    var supportsArtifacts: Bool { capabilities.contains("artifacts_v1") }

    /// daemon 이 네이티브 화면 캡처를 지원하는가. «결과» 시트의 «화면» 세그먼트 게이트.
    var supportsScreenCapture: Bool { capabilities.contains("screen_capture_v1") }

    /// daemon 이 원격 입력 제어를 지원하는가. «화면» 안 «제어» 토글 게이트 (없으면 보기 전용).
    var supportsRemoteControl: Bool { capabilities.contains("remote_control_v1") }

    /// daemon 이 화면을 H.264 로 인코딩해 릴레이하는가. iOS 가 capture_start 에 codec:h264 +
    /// 채널별 fps/bitrate 를 요청할지 분기. 없으면 jpeg(저fps) 폴백 — «있으면 고화질», 경고 아님.
    var supportsScreenH264: Bool { capabilities.contains("screen_h264_v1") }

    /// daemon 이 원샷 스크린샷(GET /api/screen/shot)을 지원하는가 — 미러링의 «캡처/녹화 →
    /// 채팅 첨부» 버튼 게이트. 없으면 버튼 숨김.
    var supportsScreenShot: Bool { capabilities.contains("screen_shot_v1") }

    /// daemon 이 창 단위 캡처 대상을 지원하는가 — 미러링 더보기의 «캡처 대상» 피커 게이트.
    /// 없으면(옛 daemon) 피커를 숨겨 항상 전체 화면 — soft, 경고 없이 그냥 안 보임.
    var supportsWindowTarget: Bool { capabilities.contains("screen_window_target_v1") }

    /// daemon 프록시가 라이브 프리뷰 v2(절대 URL 리라이트 + 다중 dev 포트 라우팅)를 지원하는가.
    /// iOS 가 프리뷰 화면에 «보조 포트 등록» 안내/UI 를 노출할지 분기 — 없으면(옛 daemon) 기존
    /// 단일 포트 UX 유지(회귀 없음). expectedDaemonCapabilities 에는 넣지 않는다 («있으면 노출»).
    var supportsMultiPortPreview: Bool { capabilities.contains("preview_v2") }

    /// daemon 이 콜드 진입 tail 캡(`GET /:id/poll?limit`) + 역방향 keyset 히스토리
    /// (`GET /:id/messages`)를 지원하는가. 없으면(옛 daemon) iOS 는 limit 을 보내지 않고
    /// 전체를 받는 기존 동작으로 폴백한다 (회귀 없음). 있으면 콜드 로드를 캡해 긴 PTY 세션의
    /// ~5s 진입 지연을 없애고, SDK 세션은 «이전 더보기» 로 과거를 페이지네이션한다.
    var supportsHistory: Bool { capabilities.contains("session_history_v1") }

    /// daemon 이 헤드리스 VT 화면 스냅샷(`GET /:id/pty/snapshot`)을 지원하는가. 콜드 진입에서
    /// 전체 청크 replay 대신 «현재 화면+scrollback» 한 덩이를 받아 O(화면) 으로 즉시 복원한다.
    /// 없으면(옛 daemon, 404) iOS 가 session_history_v1 의 tail 캡 콜드 poll 로 폴백한다.
    var supportsPtySnapshot: Bool { capabilities.contains("pty_snapshot_v1") }

    /// daemon 이 로컬 진단 번들(`GET /api/diagnostics`)을 지원하는가 — 서브시스템 스냅샷 +
    /// 최근 crash 마커 + 마스킹된 unified.log tail. iOS 가 설정 「문제 신고/진단」 진입점을
    /// 노출할지 분기 (없으면 숨김 — soft. 옛 daemon 은 /api/diagnostics 가 404 라 보여주면
    /// 거짓 UI 가 된다).
    var supportsDiagnostics: Bool { capabilities.contains("diagnostics_v1") }
}

/// `/api/version` 의 `lastUpdate` 디코드 타입. daemon `updateStatus.ts` 의 `UpdateStatus` 와 짝.
struct UpdateStatusInfo: Codable, Equatable {
    /// "no_update" | "error".
    let state: String
    let message: String?
    /// 보고 시각 (epoch ms). iOS 가 트리거 이후의 결과인지 판별하는 데 쓴다.
    let at: Int64
}

// MARK: - 호환성 판정 결과

/// iOS 측에서 계산한 호환성 verdict. AppRoot 가 이걸 보고 분기한다.
enum CompatibilityVerdict: Equatable {
    /// 양쪽 모두 OK. 누락 capability 도 없음.
    case ok

    /// Soft — Hard 는 아니지만 iOS 가 기대하는 capability 중 daemon 에 없는 것이
    /// 있음. 사용자는 정상 사용 가능, 누락된 기능을 트리거할 때만 실패하거나
    /// 별도 안내. 부팅 시 한 줄 배너로 미리 알린다.
    case softMissingCapabilities(missing: [String], daemonVersion: String)

    /// Hard — daemon 이 우리가 받아들이는 최소 버전보다 낮음. "Mac 앱 업데이트 필요".
    case hardDaemonTooOld(daemonVersion: String, minRequired: String)

    /// Hard — iOS 가 daemon 이 받아들이는 최소 버전보다 낮음. "iOS 앱 업데이트 필요".
    case hardClientTooOld(clientVersion: String, minRequired: String)

    /// daemon 이 `/api/version` 자체를 모름 (404 또는 더 옛 응답 shape). 충분히
    /// 옛 daemon → Hard 로 취급해 Mac 앱 업데이트를 안내한다.
    case hardDaemonUnknown

    var isHardBlock: Bool {
        switch self {
        case .ok, .softMissingCapabilities: return false
        case .hardDaemonTooOld, .hardClientTooOld, .hardDaemonUnknown: return true
        }
    }

    var isSoftWarning: Bool {
        if case .softMissingCapabilities = self { return true }
        return false
    }
}

// MARK: - semver 비교
//
// daemon/iOS 둘 다 "MAJOR.MINOR.PATCH" 형태의 단순 dot-separated numeric.
// pre-release 태그(-beta.1)는 무시 (분리 후 숫자 부분만 비교 — 0.2.0-beta.1 < 0.2.0).
// 비교 결과:
//   negative  →  a < b
//   0         →  a == b
//   positive  →  a > b

enum SemverCompare {
    static func compare(_ a: String, _ b: String) -> Int {
        let lhs = parts(a)
        let rhs = parts(b)
        let maxLen = max(lhs.count, rhs.count)
        for i in 0..<maxLen {
            let l = i < lhs.count ? lhs[i] : 0
            let r = i < rhs.count ? rhs[i] : 0
            if l != r { return l < r ? -1 : 1 }
        }
        return 0
    }

    /// "0.2.4-beta.1" → [0, 2, 4]. 알 수 없는 토큰은 0 으로 fall back —
    /// 미래의 형식 확장이 들어와도 비교가 panic 하지 않게.
    private static func parts(_ s: String) -> [Int] {
        let trimmed = s.split(separator: "-").first.map(String.init) ?? s
        return trimmed
            .split(separator: ".")
            .map { Int($0) ?? 0 }
    }
}

// MARK: - verdict 계산

extension CompatibilityVerdict {
    /// 이 iOS 빌드의 상수 + daemon 응답으로 verdict 를 계산.
    /// - Parameter server: nil 이면 호출 자체가 실패한 것 — 별도 처리 필요 (verdict 으로
    ///   감추지 않음. VersionCompatStore 가 에러 상태를 따로 들고 있다).
    static func evaluate(server: ServerVersionInfo, clientVersion: String) -> CompatibilityVerdict {
        // 1) daemon 너무 낮음? (iOS 쪽 최소 요구 위반)
        if SemverCompare.compare(server.daemonVersion, VersionCompat.minSupportedDaemonVersion) < 0 {
            return .hardDaemonTooOld(
                daemonVersion: server.daemonVersion,
                minRequired: VersionCompat.minSupportedDaemonVersion,
            )
        }

        // 2) iOS 너무 낮음? (daemon 쪽 최소 요구 위반)
        if SemverCompare.compare(clientVersion, server.minSupportedClientVersion) < 0 {
            return .hardClientTooOld(
                clientVersion: clientVersion,
                minRequired: server.minSupportedClientVersion,
            )
        }

        // 3) Soft — iOS 가 기대하지만 daemon 이 없다고 말한 것들.
        //
        // 반대 (daemon 만 있고 iOS 가 모르는 capability) 는 여기서 신호하지 않는다.
        // 그건 daemon 측 신기능이라 iOS 가 호출조차 안 하므로 사용자 입장에서
        // 「있는데 못 쓰는 기능」 도 아니다. (필요하면 향후 별도 안내 채널을 둠.)
        let serverSet = Set(server.capabilities)
        let missing = VersionCompat.expectedDaemonCapabilities.filter { !serverSet.contains($0) }
        if !missing.isEmpty {
            return .softMissingCapabilities(missing: missing, daemonVersion: server.daemonVersion)
        }

        return .ok
    }
}
