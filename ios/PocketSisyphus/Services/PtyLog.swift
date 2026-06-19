import Foundation
import os

/// PTY 흐름 디버그 전용 로거.
///
/// iOS 17/18 의 unified logging 은 NSLog 호출의 모든 format argument 를 기본적으로
/// `<private>` 로 redact 한다. `idevicesyslog` / Console.app 에서 메시지가 «<private>»
/// 로만 보이는 이유. 이 헬퍼는 `Logger` (os.log) 를 통해 .public 명시적 인터폴레이션을
/// 사용해 모든 값이 실제 device 로그에 그대로 노출되게 한다.
///
/// # 사용 지침
///
/// 라이프사이클 이벤트 (bind / makeUIView / 페어링 / WS 연결) 는 `PtyLog.shared.notice(...)`
/// 그대로 사용. 매 청크마다 발사되는 hot-path 로그 (예: PTY-2/VM appendPtyBytes, PTY-5
/// enqueueFeed) 는 `#if DEBUG` 안에서만 호출 — Release 빌드에서 초당 수십 회 호출 시
/// 누적 오버헤드 + 사용자 device 의 unified-log 캐시 노이즈 회피.
///
/// 사용:
///   PtyLog.shared.notice("[PTY-N] msg=\(value, privacy: .public)")
enum PtyLog {
    static let shared = Logger(
        subsystem: "pe.wayne.pocketsisyphus",
        category: "PTY",
    )
}
