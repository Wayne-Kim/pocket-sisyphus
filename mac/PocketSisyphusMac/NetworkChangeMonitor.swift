import Foundation
import Network
import Darwin

/// Mac 의 primary IPv4 변경을 감지해 daemon 에 알리는 모니터.
///
/// 문제: 가정용 인터넷의 dynamic IP 환경에서 Mac 공인 IP 가 바뀌면 (DHCP 리스 갱신,
/// 모뎀 재부팅, 휴면 깨어남) 기존 Tor introduction point 회로가 stale 해진다. Tor 자체
/// 타임아웃 기반 회복은 1~5분 — 그 사이 폰에서 «연결 안 됨» 만 보임. NWPathMonitor 로
/// path 변경을 잡아 daemon 에 SIGHUP 트리거를 보내면 회복이 5~10s 로 압축된다.
///
/// 동작:
///  - `NWPathMonitor` 가 path 변경 이벤트 발화 → 짧은 debounce 후 현재 primary IPv4 추출
///  - 이전과 다르면 daemon `/api/admin/network-changed` POST → 옛 회로 청소 + 새 descriptor publish
///  - daemon 측에 별도 쿨다운(30s) 이 있으므로 이쪽은 단순 debounce 만으로 충분
///  - 깨어남(`NSWorkspaceDidWakeNotification`) 시에도 강제 kick — wake 직후 NWPathMonitor
///    가 이벤트 안 줄 수도 있어 안전망
///
/// **NWPathMonitor 가 직접 IP 를 노출하지 않는 이유**: `NWPath` 는 «path 가 만족 가능한가»
/// 만 다루는 상위 추상. 실제 인터페이스 IP 는 BSD `getifaddrs(3)` 로 직접 읽는다.
@MainActor
final class NetworkChangeMonitor: ObservableObject {
    /// 마지막으로 관측된 primary IPv4. nil = 처음 부팅, 또는 인터페이스 없음.
    private var lastPrimaryIPv4: String?

    private let monitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "pe.wayne.pocketsisyphus.netmon")

    /// path 이벤트는 link down → link up → IP assigned → DNS updated 처럼 한 번에 여러 개
    /// 발화하기 쉽다. 1s 안에 들어온 이벤트는 마지막 1개로 묶어 IP 비교를 한 번만.
    private var debounceTask: Task<Void, Never>?

    /// IP 변경 감지 시 호출. 의존성 주입 — DaemonManager / LocalDaemonClient 가 실제 호출.
    private let onChange: () -> Void

    init(onChange: @escaping () -> Void) {
        self.onChange = onChange
        // 초기값 — start 시점의 IP 를 lastPrimaryIPv4 로 박아 두고 «바뀐 경우만» 호출하게.
        // nil 이면 첫 path 이벤트도 변경으로 취급되는데 그건 의도. 콜드 부팅 직후 daemon 이
        // 아직 안 떴거나 startTor 안 했을 가능성이 큰 시점이라 daemon 측의
        // not-bootstrapped 가드가 cleanly 무시한다.
        self.lastPrimaryIPv4 = Self.readPrimaryIPv4()

        monitor.pathUpdateHandler = { [weak self] _ in
            // NWPathMonitor 콜백은 background queue → MainActor 로 hop.
            Task { @MainActor in self?.handlePathEvent() }
        }
        monitor.start(queue: monitorQueue)

        // 휴면 깨어남 — Mac 이 sleep 후 wake 하면 ISP DHCP 리스가 갱신돼 IP 가 바뀌어
        // 있을 확률이 높다. NWPathMonitor 가 wake 직후 이벤트를 보장하지 않으므로 강제 kick.
        NotificationCenter.default.addObserver(
            forName: NSNotification.Name("NSWorkspaceDidWakeNotification"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.handleWake()
            }
        }
    }

    deinit {
        monitor.cancel()
    }

    private func handlePathEvent() {
        debounceTask?.cancel()
        debounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_000_000_000) // 1s
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.evaluateAndKick(reason: "path-event") }
        }
    }

    private func handleWake() {
        // wake 는 즉시 한 번 kick. lastPrimaryIPv4 도 강제 nil 화해서 다음 evaluate 가
        // 무조건 변경으로 보게.
        UnifiedLog.info(.network, "system wake — force kick", [
            "event.action": "network.wake",
        ])
        NSLog("[NetworkChangeMonitor] wake — force kick")
        lastPrimaryIPv4 = nil
        evaluateAndKick(reason: "wake")
    }

    private func evaluateAndKick(reason: String) {
        let current = Self.readPrimaryIPv4()
        if current == lastPrimaryIPv4 {
            return
        }
        UnifiedLog.info(.network, "primary IPv4 changed", [
            "event.action": "network.path.change",
            "secret.previous_ipv4": lastPrimaryIPv4 ?? "<nil>",
            "secret.next_ipv4": current ?? "<nil>",
            "network.change_reason": reason,
        ])
        NSLog("[NetworkChangeMonitor] IPv4 변경 감지 (\(lastPrimaryIPv4 ?? "<nil>") → \(current ?? "<nil>"), \(reason))")
        lastPrimaryIPv4 = current
        onChange()
    }

    /// primary egress 로 쓰일 IPv4 를 BSD `getifaddrs(3)` 로 읽는다. lo / utun / awdl /
    /// llw / link-local 같은 비-egress 는 걸러내고, 남은 active IPv4 중 첫 번째 — 보통
    /// en0 (Wi-Fi/유선) 이거나 en1.
    ///
    /// 정확도 vs 단순성: «진짜 default route 가 어디로 나가는가» 를 routing socket 으로
    /// 물으면 더 정확하지만 코드가 훨씬 무거워진다. egress 후보를 좁힌 첫 IPv4 로도
    /// 우리 «변경 감지» 목적엔 충분하고, false-positive 가 발생해도 daemon 쿨다운이 흡수.
    private static func readPrimaryIPv4() -> String? {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return nil }
        defer { freeifaddrs(ifaddr) }

        var p: UnsafeMutablePointer<ifaddrs>? = first
        while let cur = p {
            defer { p = cur.pointee.ifa_next }
            guard let name = cur.pointee.ifa_name else { continue }
            let ifname = String(cString: name)
            // egress 후보가 아닌 인터페이스 전부 skip
            if ifname == "lo0" { continue }
            if ifname.hasPrefix("utun") { continue }   // VPN/Personal Hotspot
            if ifname.hasPrefix("awdl") { continue }   // Apple Wireless Direct Link
            if ifname.hasPrefix("llw") { continue }    // low-latency WLAN
            if ifname.hasPrefix("bridge") { continue }
            if ifname.hasPrefix("anpi") { continue }

            let flags = Int32(cur.pointee.ifa_flags)
            guard (flags & IFF_UP) != 0 && (flags & IFF_RUNNING) != 0 else { continue }

            guard let addr = cur.pointee.ifa_addr else { continue }
            guard addr.pointee.sa_family == sa_family_t(AF_INET) else { continue }

            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let ok = getnameinfo(
                addr,
                socklen_t(addr.pointee.sa_len),
                &host,
                socklen_t(host.count),
                nil,
                0,
                NI_NUMERICHOST,
            )
            guard ok == 0 else { continue }
            let ip = String(cString: host)
            // 169.254.x.x = link-local, IP 못 받은 인터페이스. egress 후보 아님.
            if ip.hasPrefix("169.254.") { continue }
            return ip
        }
        return nil
    }
}
