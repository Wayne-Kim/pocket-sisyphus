import Foundation

/// `GET /api/diagnostics` 응답 — 로컬 진단 번들. daemon 측 `mac/daemon/src/diagnostics.ts`
/// 의 `DiagnosticsBundle` 과 짝. 비밀(webhook URL·토큰·키)은 daemon 이 마스킹해 보낸다.
///
/// 「문제 신고/진단」 화면이 이 값을 받아 요약을 보여 주고, `exportText` 로 텍스트 묶음을 만들어
/// 사용자가 «직접» 공유/내보내기 한다. 자동 전송은 없다(LAN 전용·무텔레메트리 원칙).
struct DiagnosticsBundle: Codable, Equatable {
    /// 번들 생성 시각 ISO 8601 UTC.
    let generatedAt: String
    let subsystem: Subsystem
    let config: ConfigSummary
    /// 최근 crash 마커(최신 우선). 없으면 빈 배열.
    let crashes: [CrashReport]
    /// 마스킹된 unified.log tail (없으면 빈 문자열).
    let unifiedLogTail: String
    /// tail 이 원본 상한보다 커서 잘렸는지.
    let unifiedLogTruncated: Bool

    struct Subsystem: Codable, Equatable {
        let daemonVersion: String
        let instanceId: String
        let pid: Int
        let parentPid: Int
        let uptimeSec: Int
        let platform: String
        let nodeVersion: String
        let connectedClients: Int
        let torActive: Bool
    }

    /// 비밀이 제거된 구성 요약 — 값이 아니라 «있/없음·개수» 만.
    struct ConfigSummary: Codable, Equatable {
        let hasToken: Bool
        let discordConfigured: Bool
        let ascConfigured: Bool
        let mcpServerCount: Int
        let attestDeviceCount: Int
        let port: Int?
        let sshPort: Int?
        let lanOnly: Bool
    }

    struct CrashReport: Codable, Equatable, Identifiable {
        /// "uncaughtException" | "unhandledRejection".
        let kind: String
        /// 크래시 시각 ISO 8601 UTC.
        let at: String
        let error: CrashError
        let context: CrashContext
        /// 시각 + 인스턴스로 안정적 식별 (목록 렌더용).
        var id: String { "\(at)-\(context.instanceId)" }

        struct CrashError: Codable, Equatable {
            let name: String
            /// 마스킹된 메시지.
            let message: String
            /// 마스킹된 풀스택.
            let stack: String
        }

        struct CrashContext: Codable, Equatable {
            let instanceId: String
            let bootPpid: Int
            let currentPpid: Int
            let pid: Int
            let lastChannelEvent: LastChannelEvent?

            struct LastChannelEvent: Codable, Equatable {
                let channel: String
                let level: String
                let action: String?
                let at: String
            }
        }
    }

    /// 공유/내보낼 텍스트가 사실상 비어 있는가 — crash 도 로그 tail 도 없을 때 «빈» 상태로 안내.
    var isEmpty: Bool {
        crashes.isEmpty && unifiedLogTail.isEmpty
    }

    /// 진단 자료를 사람이 읽는 한 덩어리 텍스트(마크다운)로 조립한다. 라벨은 디버그 로그 «원문»
    /// 을 제외하고 화면 문구와 같은 원칙으로 로컬라이즈한다(로그 본문은 기계 데이터라 비번역).
    /// 비밀은 daemon 이 이미 마스킹했으므로 여기선 그대로 옮긴다.
    func exportText() -> String {
        var out = "# \(String(localized: "Pocket Sisyphus 진단 번들"))\n\n"
        out += "\(String(localized: "생성 시각")): \(generatedAt)\n\n"

        out += "## \(String(localized: "서브시스템"))\n"
        out += "- daemon: v\(subsystem.daemonVersion) · instance \(subsystem.instanceId)\n"
        out += "- pid: \(subsystem.pid) (parent \(subsystem.parentPid)) · uptime \(subsystem.uptimeSec)s\n"
        out += "- runtime: \(subsystem.platform) · node \(subsystem.nodeVersion)\n"
        out += "- \(String(localized: "연결된 클라이언트")): \(subsystem.connectedClients) · Tor: \(subsystem.torActive ? "active" : "inactive")\n\n"

        out += "## \(String(localized: "구성 요약"))\n"
        out += "- LAN-only: \(config.lanOnly) · token: \(config.hasToken)\n"
        out += "- Discord: \(config.discordConfigured) · ASC: \(config.ascConfigured)\n"
        out += "- MCP servers: \(config.mcpServerCount) · devices: \(config.attestDeviceCount)\n"
        out += "- port: \(config.port.map(String.init) ?? "-") · sshPort: \(config.sshPort.map(String.init) ?? "-")\n\n"

        out += "## \(String(localized: "최근 크래시")) (\(crashes.count))\n"
        if crashes.isEmpty {
            out += "\(String(localized: "기록된 크래시가 없어요."))\n\n"
        } else {
            for crash in crashes {
                out += "### \(crash.kind) — \(crash.at)\n"
                out += "instance \(crash.context.instanceId) · pid \(crash.context.pid) · bootPpid \(crash.context.bootPpid)\n"
                if let ev = crash.context.lastChannelEvent {
                    out += "last event: [\(ev.channel)/\(ev.level)] \(ev.action ?? "-") @ \(ev.at)\n"
                }
                out += "```\n\(crash.error.stack)\n```\n\n"
            }
        }

        out += "## unified.log"
        if unifiedLogTruncated { out += " (\(String(localized: "마지막 일부만")))" }
        out += "\n```\n\(unifiedLogTail.isEmpty ? String(localized: "로그가 없어요.") : unifiedLogTail)\n```\n"
        return out
    }
}
