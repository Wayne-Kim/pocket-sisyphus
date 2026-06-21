import Foundation
#if canImport(IPtProxy)
import IPtProxy
#endif

/// obfs4 pluggable transport 를 **프로세스 내** 에서 돌리는 wrapper.
///
/// ## 왜 in-process 인가 (iOS 제약)
/// iOS 샌드박스는 별도 실행 파일의 `fork`/`exec` 를 금지한다 — 그래서 데스크탑 Tor 가 쓰는
/// `ClientTransportPlugin obfs4 exec /path/to/obfs4proxy` 경로는 iOS 에서 **불가능**하다.
/// 대신 `IPtProxy`(gomobile 로 obfs4=lyrebird 를 라이브러리로 컴파일한 xcframework — Onion
/// Browser / Orbot 가 운영 검증) 를 링크해 PT 를 goroutine 으로 띄우고, 로컬 SOCKS 포트를
/// 얻어 Tor 에 `ClientTransportPlugin obfs4 socks5 127.0.0.1:<port>` 로 연결한다.
///
/// ## 빌드 게이트
/// `IPtProxy` pod 가 아직 vendoring 안 된 빌드에서도 컴파일되도록 `#if canImport(IPtProxy)` 로
/// 감싼다. 미링크 시 `isAvailable == false` 가 되어 obfs4 라인은 «미지원» 으로 떨어지고,
/// vanilla bridge 만 동작한다 (회귀 없음 — bridge 미사용 기본 경로는 전혀 안 건드림).
@MainActor
final class PluggableTransport {
    static let shared = PluggableTransport()
    private init() {}

    /// 이 빌드에 obfs4 PT(IPtProxy)가 링크돼 있는가.
    var isAvailable: Bool {
        #if canImport(IPtProxy)
        return true
        #else
        return false
        #endif
    }

    #if canImport(IPtProxy)
    private var controller: IPtProxyController?
    #endif

    /// 실행 중 obfs4 가 듣는 로컬 SOCKS 포트 (nil = 미실행).
    private(set) var obfs4Port: Int?

    /// obfs4 PT 를 시작하고 Tor 가 붙을 로컬 SOCKS 포트를 돌려준다. 실패/미링크 시 nil.
    /// 이미 떠 있으면 같은 포트를 재사용한다 (멱등).
    func startObfs4(stateDir: URL) -> Int? {
        #if canImport(IPtProxy)
        if let p = obfs4Port, controller != nil { return p }
        try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        guard let c = IPtProxyController(
            stateDir.path,
            enableLogging: false,
            unsafeLogging: false,
            logLevel: "ERROR",
            transportEvents: nil
        ) else {
            NSLog("[PT] IPtProxyController 생성 실패")
            return nil
        }
        do {
            try c.start(IPtProxyObfs4, proxy: nil)
            let port = c.port(IPtProxyObfs4)
            guard port > 0 else {
                NSLog("[PT] obfs4 포트 미할당")
                c.stop(IPtProxyObfs4)
                return nil
            }
            controller = c
            obfs4Port = Int(port)
            NSLog("[PT] obfs4 started on 127.0.0.1:%ld", port)
            return Int(port)
        } catch {
            NSLog("[PT] obfs4 start failed: %@", String(describing: error))
            return nil
        }
        #else
        NSLog("[PT] IPtProxy 미번들 — obfs4 사용 불가")
        return nil
        #endif
    }

    /// PT 정지. Tor 정지(stopImpl) 시 같이 호출한다.
    func stop() {
        #if canImport(IPtProxy)
        if let c = controller { c.stop(IPtProxyObfs4) }
        controller = nil
        #endif
        obfs4Port = nil
    }
}
