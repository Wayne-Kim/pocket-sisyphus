import Foundation

/// LAN 전용(사설망 직결, fail-closed) 모드의 «정책» — 순수 값 로직.
///
/// ## 무엇을 보장하나
/// 사용자가 켜면 폰↔Mac 이 «같은 LAN 일 때만» 사설/링크로컬 주소로 직접 SSH 하고,
/// Tor 발견·공인 IPv4/IPv6·onion 폴백을 «건너뛰고 거부» 한다. 오프-LAN 이면 연결을 명시적으로
/// 차단(fail-closed) — 몰래 외부로 폴백하지 않는다.
///
/// ## 왜 별도 순수 파일인가
/// ConnectionManager 는 Tor/SSH/Keychain 의존이 커서 host-less 단위 테스트가 어렵다. 이
/// 정책의 «핵심 계약» (후보 필터링·Tor skip·fail-closed) 만 의존성 0 인 값 함수로 떼어내
/// `LanOnlyPolicyTests` 가 고정한다. ConnectionManager 는 이 함수들을 «호출만» 한다.
///
/// ## 위협/완화
/// LAN 직결도 host key 핀(SSHHostKeyTOFU)으로 적대적 LAN 의 MITM 을 거부한다 — 이 정책은
/// 그 위에서 «공인/Tor 후보를 시도 자체 금지»(단순 비선호가 아니라 후보군에서 제거)한다.
enum LanOnlyPolicy {
    /// UserDefaults / @AppStorage 공용 키. iOS 설정 토글 + Mac 설정 토글이 같은 의미로 쓴다.
    static let defaultsKey = "connection.lanOnly"

    /// 정책이 켜져 있는가.
    static func isEnabled(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: defaultsKey)
    }

    static func setEnabled(_ enabled: Bool, _ defaults: UserDefaults = .standard) {
        defaults.set(enabled, forKey: defaultsKey)
    }

    /// 활성 시 direct_lan 후보«만» 남긴다 — 공인 IPv4/IPv6·onion 을 후보군에서 «제거».
    /// 비활성 시 원본 그대로(기존 happy eyeballs 듀얼 채널).
    static func filterCandidates(_ endpoints: [EndpointEntry], enabled: Bool) -> [EndpointEntry] {
        guard enabled else { return endpoints }
        return endpoints.filter { $0.type == .directLan }
    }

    /// 활성 시 Tor 부트스트랩 자체를 건너뛴다(DevPairing 의 부트스트랩 skip 패턴 재사용).
    static func shouldSkipTorBootstrap(enabled: Bool) -> Bool { enabled }

    /// 활성인데 채택할 LAN 후보가 없거나 전부 실패 → fail-closed. 공인/onion 으로 폴백 금지.
    static func shouldFailClosed(enabled: Bool) -> Bool { enabled }

    /// 페어링 정보(QR)와 캐시에서 LAN 전용 후보를 만든다.
    ///
    /// - `cfg.lanHost`(mDNS `<host>.local`, IP 변경 추종)를 최우선 후보로. Tor/`/endpoint`
    ///   없이도 콜드 부트스트랩 가능 — QR 한 장으로 LAN 직결.
    /// - `cached` 에 daemon 이 광고한 `direct_lan` 엔트리가 있으면 함께(사설 IP 직결).
    /// - 둘 다 없으면 빈 배열 → 호출자는 fail-closed 한다.
    ///
    /// host/port 중복은 제거한다 (lanHost 가 캐시 엔트리와 겹칠 수 있음).
    static func lanCandidates(lanHost: String?, sshPort: UInt16?, cached: [EndpointEntry]) -> [EndpointEntry] {
        var out: [EndpointEntry] = []
        if let host = lanHost, !host.isEmpty, let port = sshPort, port != 0 {
            out.append(EndpointEntry(type: .directLan, host: host, port: port, priority: 0))
        }
        for ep in cached where ep.type == .directLan {
            out.append(ep)
        }
        // host:port 중복 제거 — 같은 목적지를 두 번 시도하지 않는다.
        var seen = Set<String>()
        return out.filter { ep in
            let key = "\(ep.host):\(ep.port)"
            return seen.insert(key).inserted
        }
    }
}
