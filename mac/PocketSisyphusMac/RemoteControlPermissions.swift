import AppKit
import CoreGraphics
import ApplicationServices

/// 라이브 화면 미리보기 + 원격 제어(capture-helper)에 필요한 두 TCC 권한 헬퍼.
///
/// ## 왜 «메인 앱» 이 권한을 받나
/// 캡처/입력 주입은 daemon 이 띄운 capture-helper(손자 프로세스: 앱→node→helper)가 실행하지만,
/// macOS TCC 는 «responsible process» 기준으로 권한을 판정한다 — 손자의 책임 프로세스는 결국
/// 이 Mac 앱이다. 그래서 **이 앱** 이 화면 기록 / 손쉬운 사용 권한을 받으면 헬퍼의 CGDisplay
/// 캡처·CGEvent 주입이 동작한다. (adhoc 으로 사인된 헬퍼는 별도 승인 대상이 아니다 — 터미널에서
/// 헬퍼를 직접 띄우면 «터미널» 권한을 상속해 캡처되는 것과 같은 원리.)
///
/// ## 두 권한
/// - 화면 기록(Screen Recording): `CGDisplayCreateImage` → 라이브 미리보기. 미승인 시 빈/검은 프레임.
/// - 손쉬운 사용(Accessibility): `CGEvent` 주입 → 원격 제어(클릭·키보드). 미승인 시 입력이 무시됨.
///
/// FullDiskAccess 와 같은 형태(상태 추정 + 시스템 설정 바로가기)에, 화면 기록/손쉬운 사용은
/// OS 가 «프로그램적 요청» API 를 주므로 첫 승인 프롬프트를 직접 띄우는 request* 도 같이 둔다.
enum RemoteControlPermissions {

    // MARK: - 화면 기록 (Screen Recording)

    /// 화면 기록 권한이 이미 부여돼 있나 (프롬프트 없이 조회).
    static var screenRecordingGranted: Bool {
        CGPreflightScreenCaptureAccess()
    }

    /// 화면 기록 권한을 요청한다. 아직 결정 안 됐으면 시스템 프롬프트를 띄우고(앱을 목록에 추가),
    /// 이미 결정됐으면 현재 상태만 반환. 승인은 다음 캡처 헬퍼 spawn 부터 적용된다(헬퍼가 매
    /// 캡처 세션마다 새로 뜨므로 앱 재시작 없이 반영).
    @discardableResult
    static func requestScreenRecording() -> Bool {
        CGRequestScreenCaptureAccess()
    }

    /// 시스템 설정 → 개인정보 보호 및 보안 → 화면 기록 창을 연다(거부 후 재허용 경로).
    @MainActor
    static func openScreenRecordingSettings() {
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
    }

    // MARK: - 손쉬운 사용 (Accessibility)

    /// 손쉬운 사용 권한이 이미 부여돼 있나 (프롬프트 없이 조회).
    static var accessibilityGranted: Bool {
        AXIsProcessTrusted()
    }

    /// 손쉬운 사용 권한을 요청한다. 프롬프트 옵션을 켜 «손쉬운 사용 허용» 안내를 띄우고 앱을
    /// 시스템 설정 목록에 추가한다. 반환값은 호출 시점의 신뢰 여부(보통 첫 호출에선 false).
    @discardableResult
    static func requestAccessibility() -> Bool {
        let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        return AXIsProcessTrustedWithOptions([promptKey: true] as CFDictionary)
    }

    /// 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용 창을 연다.
    @MainActor
    static func openAccessibilitySettings() {
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    }

    // MARK: - 실동작 테스트

    /// «TCC 가 granted 라고 답하는 것» 과 «이 실행에서 실제로 동작하는 것» 은 다르다 —
    /// 화면 기록은 권한 부여 후에도 실행 중인 프로세스엔 즉시 반영 안 돼(앱 재시작 전까지
    /// 검은 프레임), dev 빌드는 cdhash 가 바뀌며 권한이 떨어질 수 있다. 그래서 «정말 되는지»
    /// 는 실제로 한 프레임 캡처해보고 검은 화면이 아닌지로 판정한다.
    struct TestResult: Equatable {
        let ok: Bool
        let detail: String
    }

    /// 화면 기록 실동작 — 번들 capture-helper 를 직접 띄워 헬퍼가 시작 직후 stderr 로 찍는
    /// `__PS_SCREENPERM__ <0|1>`(헬퍼의 CGPreflightScreenCaptureAccess)을 읽어 판정한다.
    ///
    /// 왜 이게 신뢰 가능한가: 헬퍼는 매번 «새 프로세스» 라 라이브 TCC 를 읽는다(메인 앱의
    /// CGPreflight 는 시작 시점 캐시라 승인해도 false 로 남는다). 헬퍼의 책임 프로세스 = 이 Mac
    /// 앱이라, 헬퍼가 1 을 보고하면 daemon 이 띄우는 프로덕션 헬퍼도 캡처 가능하다는 뜻.
    /// (옛 버전은 프레임을 받아 «내용 있음» 으로 판정했는데, 권한이 없어도 바탕화면이 캡처돼
    ///  거짓 통과가 났다 — 그래서 권한 플래그를 직접 읽는 방식으로 바꿈.) 블로킹(최대 ~3s).
    static func testScreenRecording() -> TestResult {
        let bin = DaemonPaths.captureBinary
        guard FileManager.default.isExecutableFile(atPath: bin) else {
            return TestResult(ok: false, detail: String(localized: "캡처 헬퍼를 찾을 수 없어요(앱 번들 확인 필요)"))
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: bin)
        let inPipe = Pipe(), outPipe = Pipe(), errPipe = Pipe()
        proc.standardInput = inPipe
        proc.standardOutput = outPipe
        proc.standardError = errPipe
        do {
            try proc.run()
        } catch {
            return TestResult(ok: false, detail: String(localized: "헬퍼 실행 실패: \(error.localizedDescription)"))
        }
        defer { if proc.isRunning { proc.terminate() } }

        let fh = errPipe.fileHandleForReading
        let sem = DispatchSemaphore(value: 0)
        var result = TestResult(ok: false, detail: String(localized: "권한 상태를 확인하지 못했어요(헬퍼 응답 없음)"))
        let q = DispatchQueue(label: "pe.wayne.capture-test")
        q.async {
            var buf = Data()
            while true {
                let chunk = fh.availableData
                if chunk.isEmpty { break }  // EOF
                buf.append(chunk)
                guard let s = String(data: buf, encoding: .utf8),
                      let r = s.range(of: "__PS_SCREENPERM__ ") else { continue }
                let granted = s[r.upperBound...].first == "1"
                result = granted
                    ? TestResult(ok: true, detail: String(localized: "정상 — 화면 기록 권한이 확인됐어요(캡처 가능)"))
                    : TestResult(ok: false, detail: String(localized: "화면 기록 권한이 없어요 — 시스템 설정에서 이 앱(이름 확인)을 켠 뒤 앱을 재시작하세요"))
                break
            }
            sem.signal()
        }
        if sem.wait(timeout: .now() + 3) == .timedOut {
            proc.terminate()
            _ = sem.wait(timeout: .now() + 1)
        }
        return result
    }

    /// 손쉬운 사용 실동작 — `AXIsProcessTrusted` 는 현재 신뢰 상태를 그대로 반영(화면 기록과
    /// 달리 부여 직후 대체로 즉시 반영). 입력을 실제로 쏘면 커서가 움직여 부작용이 있어, 신뢰
    /// 여부만 본다.
    static func testAccessibility() -> TestResult {
        if AXIsProcessTrusted() {
            return TestResult(ok: true, detail: String(localized: "정상 — 손쉬운 사용 신뢰됨(입력 주입 가능)"))
        }
        return TestResult(ok: false, detail: String(localized: "신뢰되지 않음 — 손쉬운 사용에서 켜 주세요"))
    }

    // MARK: - 공통

    @MainActor
    private static func open(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        NSWorkspace.shared.open(url)
    }
}
