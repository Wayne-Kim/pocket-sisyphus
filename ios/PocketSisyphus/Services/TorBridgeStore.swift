import Foundation
import Combine

/// 한 줄 «bridge line» 의 파싱 결과.
///
/// torrc 의 `Bridge` 지시문 문법을 따른다:
///   - vanilla:  `IP:PORT [FINGERPRINT]`                         (전송 없이 «숨은» relay)
///   - PT(obfs4): `obfs4 IP:PORT FINGERPRINT cert=… iat-mode=0`   (pluggable transport)
/// 사용자가 붙여넣는 라인은 앞에 torrc 키워드 `Bridge ` 가 붙어 있을 수도 있어 벗겨낸다.
struct TorBridgeLine: Identifiable, Equatable {
    /// 정규화 문자열을 그대로 id 로 — 같은 라인은 같은 id (중복 제거에도 활용).
    var id: String { normalized }
    /// `Bridge ` 키워드를 벗기고 공백을 한 칸으로 정리한, tor `--Bridge` 인자에 그대로 넣을 형태.
    let normalized: String
    /// 전송 이름. nil 이면 vanilla(전송 없음).
    let transport: String?
    /// `host:port` (IPv6 는 `[..]:port`).
    let address: String
    /// 40-hex relay fingerprint (있으면).
    let fingerprint: String?

    var transportLower: String? { transport?.lowercased() }
    var isPluggable: Bool { transport != nil }
}

/// bridge line 텍스트(여러 줄)를 파싱한다. 빈 줄/`#` 주석은 무시.
enum TorBridgeParser {
    static func parse(_ text: String) -> (valid: [TorBridgeLine], invalid: [String]) {
        var valid: [TorBridgeLine] = []
        var invalid: [String] = []
        var seen = Set<String>()

        for rawLine in text.split(whereSeparator: { $0 == "\n" || $0 == "\r" }) {
            var line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            // torrc 스타일 «Bridge » 접두 키워드 제거 (대소문자 무시).
            if line.lowercased().hasPrefix("bridge ") {
                line = String(line.dropFirst("bridge ".count)).trimmingCharacters(in: .whitespaces)
            }
            let tokens = line.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
            guard !tokens.isEmpty else { continue }

            var transport: String? = nil
            var rest = tokens
            // 첫 토큰이 주소(host:port)가 아니면 전송 이름이다 (obfs4 / meek_lite / snowflake …).
            if !isAddress(tokens[0]) {
                transport = tokens[0]
                rest = Array(tokens.dropFirst())
            }
            guard let first = rest.first, isAddress(first) else {
                invalid.append(String(rawLine).trimmingCharacters(in: .whitespaces))
                continue
            }
            let address = first
            var fingerprint: String? = nil
            if rest.count >= 2, isFingerprint(rest[1]) { fingerprint = rest[1] }

            let normalized = (([transport].compactMap { $0 }) + rest).joined(separator: " ")
            if seen.contains(normalized) { continue }   // 같은 라인 중복 입력 제거
            seen.insert(normalized)
            valid.append(TorBridgeLine(
                normalized: normalized,
                transport: transport,
                address: address,
                fingerprint: fingerprint
            ))
        }
        return (valid, invalid)
    }

    /// `host:port` / `[ipv6]:port` 판별 — 마지막 «:» 뒤가 1–65535 정수면 주소로 본다.
    static func isAddress(_ t: String) -> Bool {
        guard let colon = t.lastIndex(of: ":") else { return false }
        let portStr = t[t.index(after: colon)...]
        guard let port = Int(portStr), (1...65535).contains(port) else { return false }
        let host = String(t[..<colon])
        return !host.isEmpty
    }

    /// 40-hex SHA1 relay fingerprint (옵션 토큰).
    static func isFingerprint(_ t: String) -> Bool {
        let s = t.uppercased()
        return s.count == 40 && s.allSatisfy { $0.isHexDigit }
    }
}

/// «Tor bridge» 사용자 설정 + 런타임 상태 보관소.
///
/// ## 역할
/// - 평문 Tor 가 ISP/방화벽 DPI 에 막히는 네트워크(학교·회사·일부 국가)에서 onion fallback 을
///   살리기 위한 **선택형** 우회 경로. 미설정 사용자에겐 아무 영향이 없다 — 평문 Tor 우선,
///   실패 시에만 bridge 경유 재시도 (`TorManager`).
/// - obfs4 같은 pluggable transport 는 iOS 에서 별도 바이너리 exec 가 불가능하므로 `IPtProxy`
///   (in-process gomobile PT 라이브러리) 로 돈다. `PluggableTransport` 가 그 wrapper.
///
/// ## 단일 인스턴스
/// `TorManager`(서비스) 와 설정 UI 가 같은 상태를 봐야 하므로 `shared` 싱글톤. SwiftUI 관찰을
/// 위해 같은 인스턴스를 EnvironmentObject 로도 주입한다(`PocketSisyphusApp`).
@MainActor
final class TorBridgeStore: ObservableObject {
    static let shared = TorBridgeStore()

    /// bridge 경유 연결의 런타임 상태 — `TorManager` 가 갱신, 설정 화면이 표시.
    enum Status: Equatable {
        case idle          // 시도 안 함 (평문 Tor 만으로 동작 중이거나 미사용)
        case connecting    // bridge 경유 부트스트랩 중
        case connected     // bridge 경유로 Tor 가 떴음
        case failed(String)// bridge 로도 실패 (사유)
    }

    /// 사용자가 bridge 사용을 켰는지. 꺼져 있으면 fallback 자체가 일어나지 않는다.
    @Published var enabled: Bool = false {
        didSet { UserDefaults.standard.set(enabled, forKey: Self.kEnabled) }
    }
    /// 붙여넣은 raw 여러 줄 bridge line 텍스트 (원문 보존 — 편집 편의).
    @Published var linesText: String = "" {
        didSet { UserDefaults.standard.set(linesText, forKey: Self.kLines) }
    }
    /// 런타임 상태 — UI 표시 전용 (영속 안 함). `TorManager.setBridgeStatus` 가 갱신.
    @Published private(set) var status: Status = .idle

    private static let kEnabled = "tor.bridge.enabled.v1"
    private static let kLines = "tor.bridge.lines.v1"

    private init() {
        enabled = UserDefaults.standard.bool(forKey: Self.kEnabled)
        linesText = UserDefaults.standard.string(forKey: Self.kLines) ?? ""
        // (위 두 줄은 init 단계 대입이라 didSet 이 안 불려 불필요한 재기록이 없다.)
    }

    // MARK: - 파싱 파생값

    var parsed: (valid: [TorBridgeLine], invalid: [String]) { TorBridgeParser.parse(linesText) }
    var hasValidLines: Bool { !parsed.valid.isEmpty }
    var requiresPluggableTransport: Bool { parsed.valid.contains { $0.isPluggable } }
    var usesObfs4: Bool { parsed.valid.contains { $0.transportLower == "obfs4" } }

    /// 이 빌드가 지원하지 않는 전송(obfs4 외 PT — snowflake/meek_lite/webtunnel 등) 집합.
    /// UI 가 «이 전송은 아직 지원 안 함» 경고를 띄우는 데 쓴다.
    var unsupportedTransports: Set<String> {
        Set(parsed.valid.compactMap { line -> String? in
            guard let t = line.transportLower else { return nil }   // vanilla 는 지원
            return t == "obfs4" ? nil : t
        })
    }

    /// 실제로 시도 가능한 bridge 라인 — tor `--Bridge` 인자로 넣을 정규화 문자열.
    /// vanilla 는 항상, obfs4 는 PT(IPtProxy) 가 살아 있을 때만. 그 외 PT 는 제외.
    func usableBridgeLines(ptObfs4Available: Bool) -> [String] {
        parsed.valid.compactMap { line in
            switch line.transportLower {
            case nil:       return line.normalized                          // vanilla
            case "obfs4":   return ptObfs4Available ? line.normalized : nil // PT 필요
            default:        return nil                                      // 미지원 전송
            }
        }
    }

    func setStatus(_ s: Status) { status = s }

    /// 내장 기본 obfs4 bridge 세트.
    ///
    /// Tor Browser 가 동봉하는 «built-in» obfs4 bridge 들 (BridgeDB 분배 대상이 아닌, Tor 가
    /// 직접 운용하는 고용량 bridge). 이 값들은 **주기적으로 회전**하므로 앱에 하드코딩하면
    /// 시간이 지나며 막힌다 — 따라서 이 배열은 메인테이너가 릴리스마다 갱신하는 «씨앗» 이고,
    /// 비어 있으면 설정 화면의 «내장 기본 bridge 사용» 버튼이 숨겨진다.
    ///
    /// 갱신 출처: Tor Browser → 설정 → 연결 → «기본 제공 bridge 선택» → obfs4, 또는
    /// `tor-browser-build` 의 `bridges_list.obfs4.txt`. (오프라인 검증 불가로 stale cert 를
    /// 박지 않으려 기본 비움 — 사용자는 항상 직접 붙여넣을 수 있다.)
    static let builtInObfs4Bridges: [String] = []
}
