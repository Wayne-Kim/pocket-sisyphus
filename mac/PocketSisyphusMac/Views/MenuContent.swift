import SwiftUI
import AppKit
import Sparkle

struct MenuContent: View {
    @EnvironmentObject var daemon: DaemonManager
    @EnvironmentObject var qrWindow: QRWindowController
    @EnvironmentObject var guideWindow: GuideWindowController
    // 세션·워크플로우 진입점은 메뉴에서 제거됨 — Mac 은 «호스트 점검/페어/전원» 에 집중하고,
    // 세션/워크플로우는 폰에서 더 잘 된다(제품 thesis: 맥 CLI 를 폰에서 제어). 관련 창/컨트롤러
    // 코드(TerminalWindow·WorkflowWindow)는 6bf98b5 에서 삭제됨 — App 의 와이어링도 함께 제거.
    // 흩어져 있던 Discord 알림 / 포트 / 전체 디스크 접근 / 언어 설정을 한 창으로 통합.
    @EnvironmentObject var settingsWindow: SettingsWindowController
    // 잠자기 방지 / 클램쉘 모드 — 설정 「전원」 탭과 같은 인스턴스를 공유. 메뉴에서 빠르게 토글.
    @EnvironmentObject var power: PowerManager
    // 사일런트(iOS 원격) 업데이트 진행 상태 — 진행 중이면 헤더 아래 배너로 노출.
    @EnvironmentObject var updateProgress: UpdateProgress
    // Sparkle updater — App 의 SPUStandardUpdaterController 가 보유한 SPUUpdater
    // 인스턴스를 받아 «업데이트 확인…» 메뉴에서 직접 트리거. canCheckForUpdates 를
    // 관찰해 진행 중에는 버튼 disable.
    let updater: SPUUpdater
    // 언어 / 전체 디스크 접근 권한 설정은 통합 설정 창(SettingsWindow)으로 이전 —
    // 옛 showLangRestart/pendingLangCode/fdaGranted state 는 거기로 옮겼다.
    // 로컬 LLM(llama-server) — 우리가 띄워 메모리를 점유 중일 때만 「종료」 버튼/점유량을
    // 노출한다. 메뉴 열릴 때 onAppear 에서 daemon 에 status 를 물어 채운다.
    @State private var llmRunning = false
    @State private var llmMemoryGB: Double? = nil
    @State private var llmStopping = false
    // Sparkle 의 canCheckForUpdates 는 KVO observable — SwiftUI 에서 직접 바인딩
    // 못 하므로 ObservableObject 어댑터로 한 단계 우회.
    @StateObject private var updaterAdapter: UpdaterAdapter

    init(updater: SPUUpdater) {
        self.updater = updater
        self._updaterAdapter = StateObject(wrappedValue: UpdaterAdapter(updater: updater))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if updateProgress.isActive {
                updateBanner
            }
            Divider()
            statusBlock
            Divider()
            actions
            Divider()
            powerSection
            Divider()
            footer
        }
        .padding(12)
        // daemon 자동 시작은 DaemonManager.init() 에서 처리 — 메뉴 클릭 안 해도 시작됨.
        // 다만 이전 시도가 .failed 로 굳었으면 메뉴 한 번 더 열어 자동 회복 시도.
        .onAppear {
            if case .failed = daemon.state { daemon.start() }
            Task { await refreshLlmStatus() }
        }
    }

    private var header: some View {
        HStack {
            // 방패 SF Symbol 대신 앱 로고(=AppIcon 재활용) — 브랜드 헤더. 아트워크가 이미
            // 둥근 모서리라 추가 마스킹 없이 그대로 렌더.
            Image("AppLogo")
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(width: 30, height: 30)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    // 실제 표시 이름(CFBundleDisplayName) — Dev 빌드는 "Pocket Sisyphus Dev" 라
                    // 메뉴에서 바로 Release/Dev 를 구분할 수 있다(시스템 설정 권한 목록과 동일 이름).
                    Text(Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Pocket Sisyphus")
                        .font(.headline)
                    Text(versionText)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tertiary)
                        // hover 시 빌드 SHA + Xcode 빌드 시각까지 보고 싶을 때 사용.
                        // help 가 풀 buildInfo 를 보여준다.
                        .help(Text(buildInfo))
                }
                Text(stateText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    /// iOS 가 트리거한 사일런트 업데이트의 진행 배너. 사일런트는 화면에 창을 안 띄우는
    /// 설계라 (UpdaterBridge 참고) 메뉴를 연 사용자에게 이 배너 + 메뉴바 파란 아이콘이
    /// 유일한 진행 단서다. 설치 완료는 앱 재시작으로 끝나므로 배너가 사라지는 것 자체가
    /// 완료 신호 — 별도 «완료» 상태는 두지 않는다.
    private var updateBanner: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.down.circle")
                    .foregroundStyle(Color.accentColor)
                Text(updatePhaseText)
                    .font(.caption)
                Spacer()
            }
            if let fraction = updateFraction {
                ProgressView(value: fraction)
                    .controlSize(.small)
            } else {
                ProgressView()
                    .progressViewStyle(.linear)
                    .controlSize(.small)
            }
        }
    }

    private var updatePhaseText: String {
        switch updateProgress.phase {
        case .idle:
            return ""   // 배너 자체가 isActive 일 때만 그려져 도달하지 않음
        case .checking:
            return String(localized: "업데이트 확인 중…")
        case .downloading:
            return String(localized: "업데이트 다운로드 중…")
        case .extracting:
            return String(localized: "설치 준비 중…")
        case .installing:
            return String(localized: "업데이트 설치 중 — 곧 재시작됩니다")
        }
    }

    /// 진행 바에 쓸 0...1 진행률. 단계가 진행률을 모르면 nil → indeterminate 바.
    private var updateFraction: Double? {
        switch updateProgress.phase {
        case .downloading(let fraction):
            return fraction
        case .extracting(let fraction):
            return fraction
        case .idle, .checking, .installing:
            return nil
        }
    }

    /// "v0.2.4 (205)" 형태의 짧은 버전 라벨. 헤더 우측에 인라인으로 박는다.
    /// marketing 은 사용자가 README / Release notes 에서 식별하는 단위, build 는
    /// deploy 스크립트가 git rev-list --count 로 박는 단조 증가 정수 — 두 값이 모두
    /// 필요하다 (어떤 marketing 의 몇 번째 빌드인지 한 줄로 알 수 있게).
    private var versionText: String {
        let info = Bundle.main.infoDictionary
        let marketing = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "v\(marketing) (\(build))"
    }

    /// 마우스 호버 시 보이는 longer 버전 — 디버그/이슈리포트에 필요한 정보까지.
    private var buildInfo: String {
        let info = Bundle.main.infoDictionary
        let marketing = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "Pocket Sisyphus \(marketing) (build \(build))"
    }

    private var statusBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Tor onion — endpoint discovery + SSH fallback 채널의 식별자.
            if let onion = daemon.onionAddress {
                row(label: "Onion", value: shortOnion(onion))
                    .help(onion)
            } else {
                row(label: "Onion", value: "—")
            }

            // 직접 SSH 채널 — UPnP/PMP 자동 매핑 결과. 실패해도 Tor fallback 으로 동작.
            switch daemon.natStatus {
            case .mapped(let ip, let port):
                row(label: "SSH 직접", value: "✅ \(ip):\(port)")
                    .help(String(localized: "외부에서 이 주소로 직접 SSH inbound 가능 (빠름)"))
            case .failed:
                row(label: "SSH 직접", value: "⚠️ 매핑 실패")
                    .help(String(localized: "라우터 UPnP 가 꺼져 있거나 미지원 — 사용자가 라우터에서 \(SSH_PORT_DEFAULT) 포트포워딩 설정해야 직접 SSH 가능. 그 전엔 Tor fallback 으로 동작 (느림)."))
            case .unknown:
                row(label: "SSH 직접", value: daemon.state == .running ? "—" : "")
            }

            // SSH onion 채널 — Tor 가 부팅 되어 있으면 항상 사용 가능. 환경 무관 fallback.
            row(
                label: "SSH onion",
                value: daemon.sshListening && daemon.onionAddress != nil ? "✅" : "—"
            )
            .help(String(localized: "Tor 회로 위 SSH — 라우터 설정 무관, 모든 환경에서 동작 (속도는 Tor 그대로)"))

            // daemon HTTP 헬스 — 헤더의 state(.running) 은 tor "hidden service ready" 기반이라
            // «HTTP 서버가 실제로 응답하는가» 와는 별개. dev/release 가 같은 포트를 다투면
            // .running 인데도 우리 daemon HTTP 가 안 닿을 수 있어, /health 를 직접 찔러 확인한다.
            daemonHealthRow

            // dev/release 동시 실행 → 공유 daemon-runtime.json 을 다른 빌드가 덮어쓴 상태.
            // 우리 daemon 포트(stdout) ≠ 공유 파일 포트면 앱 API 가 엉뚱한 daemon 으로 샐 수 있다.
            if let ours = daemon.listeningPort,
               let shared = daemon.runtimeFilePort,
               ours != shared {
                Label("다른 빌드와 포트 충돌 — 공유 파일이 \(shared) 가리킴", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.yellow)
                    .help(Text("dev·release 앱이 동시에 떠 있어 공유 런타임 파일(daemon-runtime.json)을 다른 빌드가 덮어썼어요. 우리 daemon 은 포트 \(ours) 에서 정상 동작하지만, 앱의 일부 로컬 API 호출이 포트 \(shared) 의 다른 빌드 daemon 으로 갈 수 있어요. 한쪽 앱만 종료하면 해소됩니다."))
            }

            // 로컬 LLM — 우리가 띄운 llama-server 가 메모리를 점유 중일 때만 노출. value 는
            // 점유량(번역 대상 아님: 숫자+GB) 이라 row helper 대신 LocalizedStringKey label 을
            // 직접 그린다. 「로컬 LLM」 label 만 카탈로그 경유로 번역된다.
            if llmRunning {
                HStack {
                    Text("로컬 LLM")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(width: 80, alignment: .leading)
                    Text(llmMemoryValue)
                        .font(.caption.monospaced())
                    Spacer()
                }
                .help(String(localized: "로컬 LLM 모델이 메모리에 올라와 있습니다. 아래 「로컬 LLM 종료」 로 즉시 회수할 수 있어요."))
            }
        }
    }

    /// 로컬 LLM 점유 메모리 표시값. ps RSS 를 GB 로 — 못 읽으면 실행 중 체크만.
    /// "~30 GB" 처럼 숫자+단위라 번역 대상이 아니다 (CLAUDE.md 단위 예외).
    private var llmMemoryValue: String {
        if let gb = llmMemoryGB {
            return String(format: "~%.0f GB", gb)
        }
        return "✅"
    }

    /// daemon ssh/server.ts 의 SSH_PORT 와 짝. UI 안내 메시지에 박는 정수 리터럴.
    private let SSH_PORT_DEFAULT: UInt16 = 22022

    // 액션 순서 = 페어링 → (조건부) 로컬 LLM 종료. 페어링이 최우선(정보 그룹 바로 아래),
    // 로컬 LLM 종료는 실제로 로컬 LLM 서버가 떠 있다고 감지될 때(llmRunning)만 노출한다.
    private var actions: some View {
        VStack(alignment: .leading, spacing: 4) {
            // 페어링 — 「QR 보기」 + 「페어링 값 바꾸기」 를 한 창으로 통합. 버튼은 창만 열고,
            // QR 표시·재발급(rotate)은 그 창 안에서 한다. (옛 두 버튼을 하나로.)
            // daemon 중지/재시작 버튼은 제거 — daemon 은 항상 떠 있어야 하고, 비정상 종료 시
            // DaemonManager 가 지수 백오프로 자동 재시작한다 (scheduleAutoRestart). 앱 종료는
            // 푸터의 「종료」 가 처리.
            Button {
                qrWindow.show()
            } label: {
                Label("페어링", systemImage: "qrcode")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .disabled(daemon.onionAddress == nil)

            // 로컬 LLM 종료 — daemon 은 살려둔 채 llama-server 만 내려 메모리를 즉시 회수한다.
            // 우리가 띄운 서버가 실제로 떠 있다고 감지될 때(llmRunning=spawnedByUs+pid)만 노출.
            // (adopt 한 외부 서버는 stop 이 no-op 이라 무의미.) 다음 로컬 LLM 세션에서
            // supervisor 가 온디맨드로 다시 띄우므로 비파괴적.
            if llmRunning {
                Button {
                    Task { @MainActor in await stopLocalLlm() }
                } label: {
                    Label("로컬 LLM 종료", systemImage: "memorychip")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
                .disabled(llmStopping)
                .help(Text("llama-server 를 종료해 점유 메모리를 즉시 회수합니다. daemon·폰 연결은 그대로 유지되고, 다음 로컬 LLM 세션에서 자동으로 다시 시작됩니다."))
            }
        }
    }

    /// 클램쉘 토글 — 세터가 비동기(관리자 인증)라 setClamshell 을 호출. 실패/취소 시
    /// clamshellEnabled 가 안 바뀌어 토글이 자동 원복된다 (설정 탭과 동일 패턴).
    private var clamshellBinding: Binding<Bool> {
        Binding(
            get: { power.clamshellEnabled },
            set: { newValue in Task { await power.setClamshell(newValue) } }
        )
    }

    /// 전원 섹션 — 잠자기 방지(즉시) + 클램쉘 모드(관리자 인증) 빠른 토글. 클램쉘이 켜져 있으면
    /// 시스템 전체가 안 자는 상태라 경고 라인을 노출해 깜빡 켜둔 채 잊는 걸 막는다.
    private var powerSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle(isOn: $power.keepAwakeEnabled) {
                Label("잠자기 방지", systemImage: "zzz")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .toggleStyle(.switch)
            .controlSize(.small)
            .help(Text("유휴·화면 잠금 중에도 Mac이 잠자기로 안 들어가 터미널 세션이 끊기지 않아요."))

            Toggle(isOn: clamshellBinding) {
                Label("클램쉘 모드 (덮개 닫고 실행)", systemImage: "laptopcomputer")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .toggleStyle(.switch)
            .controlSize(.small)
            .disabled(power.clamshellBusy)
            .help(Text("MacBook 덮개를 닫아도 안 잠들게 합니다. 켜고 끌 때 관리자 암호를 한 번 물어요."))

            if power.clamshellEnabled {
                Label("Mac이 잠들지 않는 중", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 4) {
            // 업데이트 확인 — Sparkle 가 EdDSA 검증된 DMG 를 받아 .app 을 자동 교체.
            // 평소엔 24h 자동 polling 도 돌고 있어 새 버전이 나오면 알아서 알림이 뜬다;
            // 이 버튼은 «지금 즉시 확인» 수동 트리거.
            Button {
                updater.checkForUpdates()
            } label: {
                Label("업데이트 확인…", systemImage: "arrow.down.circle")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .disabled(!updaterAdapter.canCheckForUpdates)

            // 로그 보기 — Menu 로 펼침.
            // - 원본 JSON: ECS JSON Lines 를 그대로. jq 로 분석할 때.
            // - Tor 원본 로그: tor 바이너리의 네이티브 포맷. tailer 가 unified.log 로
            //   재발행하긴 하지만 raw 가 필요한 경우 (포맷 변환 손실 의심) 가능.
            // - 진단 패키지: unified + tor + redacted config + version 묶어 Desktop 에 zip.
            Menu {
                Button("원본 JSON (unified.log)") { openUnifiedLogRaw() }
                Button("Tor 원본 로그 (tor.log)") { openTorLogFile() }
                Divider()
                Button("진단 패키지 만들기…") { createDiagnosticPackage() }
            } label: {
                Label("로그 보기", systemImage: "doc.text")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            // 나머지 항목은 .buttonStyle(.plain) 인데 Menu 만 .borderlessButton 이면 메뉴
            // 스타일 자체의 leading inset 때문에 라벨이 살짝 우측으로 밀려 정렬이 어긋난다.
            // .button 메뉴 스타일 + .plain 버튼 스타일로 평범한 버튼과 동일하게 렌더링.
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)

            // 포트포워딩 가이드 — UPnP 자동 매핑 실패한 환경에서만 의미 있음.
            // KT/LG 기본 공유기는 UPnP 디폴트 OFF 라 매핑 실패가 흔하다.
            // 사용자가 라우터 관리 페이지에 들어가 22022 포트를 Mac 으로 forwarding 하는 가이드.
            if case .failed = daemon.natStatus {
                Button {
                    showPortForwardingGuideAlert()
                } label: {
                    Label("포트포워딩 가이드…", systemImage: "network")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
            }

            // 설정 — Discord 알림 / 포트 / 전체 디스크 접근 권한 / 언어를 한 창의 탭으로 통합.
            // 옛 4개 버튼(+언어 서브메뉴)을 이 하나로. 각 설정은 창 안에서 탭으로 분리된다.
            Button {
                settingsWindow.show(daemon: daemon, power: power)
            } label: {
                Label("설정…", systemImage: "gearshape")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)

            // 도움말 — 권한 안내(permissions 카테고리)도 이 창 안에 있으므로 메뉴엔 도움말
            // 하나만 둔다 (옛 「권한 안내…」 딥링크 버튼은 중복이라 제거).
            Button {
                guideWindow.show()
            } label: {
                Label("도움말", systemImage: "questionmark.circle")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)

            Button {
                daemon.stop()
                NSApp.terminate(nil)
            } label: {
                Label("종료", systemImage: "power")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .keyboardShortcut("q")
            .buttonStyle(.plain)
        }
    }

    // 페어링 값 회전(rotate)은 페어링 QR 창(QRWindow)으로 이전 — 「페어링」 버튼이 그 창을
    // 열고, 거기서 QR 보기 + 「페어링 값 바꾸기」 를 함께 한다.

    // MARK: - Helpers

    private var stateText: String {
        switch daemon.state {
        case .stopped: return String(localized: "중지됨")
        case .starting: return String(localized: "시작 중…")
        case .running: return String(localized: "실행 중")
        case .failed(let m): return String(localized: "실패: \(m)")
        }
    }

    private func shortOnion(_ onion: String) -> String {
        if onion.count > 20 {
            return String(onion.prefix(8)) + "…" + String(onion.suffix(10))
        }
        return onion
    }

    /// daemon /health 프로브 결과 행. value 는 포트 번호(번역 대상 아님)라 row helper 대신
    /// 직접 그린다. .unreachable 은 warning(노랑) — «떴다고 표시돼도 실제론 안 닿음» 신호.
    @ViewBuilder
    private var daemonHealthRow: some View {
        HStack {
            Text("데몬")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 80, alignment: .leading)
            switch daemon.health {
            case .ok(let clients):
                Text(daemon.listeningPort.map { "✅ :\($0)" } ?? "✅")
                    .font(.caption.monospaced())
                    .help(Text("HTTP /health 응답 정상 — 연결된 기기 \(clients)대"))
            case .unreachable:
                Text("⚠️ 응답 없음")
                    .font(.caption.monospaced())
                    .foregroundStyle(.yellow)
                    .help(Text("daemon 프로세스는 살아 있지만 HTTP 포트가 응답하지 않아요. 포트 충돌이나 기동 중 오류일 수 있어요 — 「로그 보기」 로 원인을 확인하세요."))
            case .unknown:
                // 시작 중엔 "—", 중지 상태(헤더가 이미 표시)엔 빈칸으로 둔다.
                Text(daemon.state == .running ? "—" : "")
                    .font(.caption.monospaced())
            }
            Spacer()
        }
    }

    private func row(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 80, alignment: .leading)
            Text(value)
                .font(.caption.monospaced())
            Spacer()
        }
    }

    // MARK: - 로컬 LLM 제어

    /// daemon 에 로컬 LLM 서버 상태를 물어 「종료」 버튼/점유 메모리 노출을 갱신.
    /// daemon 이 안 떠 있거나 실패하면 조용히 숨긴다 (메뉴는 LLM 없이도 완전히 동작).
    @MainActor
    private func refreshLlmStatus() async {
        guard daemon.state == .running else {
            llmRunning = false
            llmMemoryGB = nil
            return
        }
        do {
            let info = try await DaemonAPI.localLlmServer()
            // spawnedByUs 일 때만 stop 이 메모리를 회수한다 — adopt 한 외부 서버는 제외.
            let ours = info.spawnedByUs && info.pid != nil
            llmRunning = ours
            llmMemoryGB = ours ? info.pid.flatMap(Self.processMemoryGB(pid:)) : nil
        } catch {
            llmRunning = false
            llmMemoryGB = nil
        }
    }

    /// 우리가 띄운 llama-server 정지 → 메모리 회수. daemon·폰 연결은 유지. 끝나면 상태 갱신.
    @MainActor
    private func stopLocalLlm() async {
        llmStopping = true
        defer { llmStopping = false }
        do {
            try await DaemonAPI.stopLocalLlm()
        } catch {
            UnifiedLog.error(.macapp, "local llm stop failed", [
                "event.action": "llm.stop.fail",
                "error.message": (error as? LocalizedError)?.errorDescription ?? "\(error)",
            ])
        }
        await refreshLlmStatus()
    }

    /// 같은 머신의 프로세스 RSS(KB) 를 `ps` 로 읽어 GB 로. mlock 된 모델이 올라와 있으면
    /// RSS 가 모델 크기만큼 잡힌다 → 사용자가 회수할 메모리의 현실적 추정치. 실패 시 nil.
    private static func processMemoryGB(pid: Int) -> Double? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-o", "rss=", "-p", String(pid)]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        do {
            try task.run()
        } catch {
            return nil
        }
        task.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let s = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              let rssKB = Double(s), rssKB > 0
        else { return nil }
        return rssKB / 1024 / 1024  // KB → GB
    }

    /// Tor 바이너리가 직접 쓰는 네이티브 포맷 로그. tor.log 가 없으면 noop.
    private func openTorLogFile() {
        let path = DaemonPaths.torLogFile.path
        if FileManager.default.fileExists(atPath: path) {
            NSWorkspace.shared.open(URL(fileURLWithPath: path))
        }
    }

    /// unified.log 원본 (JSON Lines) 그대로 열기.
    private func openUnifiedLogRaw() {
        let url = UnifiedLog.logFile
        if FileManager.default.fileExists(atPath: url.path) {
            NSWorkspace.shared.open(url)
        }
    }

    /// 진단 패키지: unified.log + tor.log + redacted config + 버전 정보를 묶어 Desktop 의
    /// `pocketsisyphus-diag-<ts>.zip` 으로 저장. 이슈 리포트 시 한 클릭 첨부 용도.
    /// 민감정보 (token, onion full address, 외부 IPv4) 는 redact.
    private func createDiagnosticPackage() {
        let ts = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
            .replacingOccurrences(of: ".", with: "-")
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("ps-diag-\(ts)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)

        // unified.log: redact secret.* 필드 값들.
        if let raw = try? String(contentsOf: UnifiedLog.logFile, encoding: .utf8) {
            let redacted = redactUnifiedLog(raw)
            try? redacted.write(to: tmpDir.appendingPathComponent("unified.log"),
                                atomically: true, encoding: .utf8)
        }
        // tor.log: redact .onion 주소.
        if let raw = try? String(contentsOf: DaemonPaths.torLogFile, encoding: .utf8) {
            let redacted = raw.replacingOccurrences(
                of: #"[a-z2-7]{56}\.onion"#,
                with: "<redacted-onion>",
                options: .regularExpression
            )
            try? redacted.write(to: tmpDir.appendingPathComponent("tor.log"),
                                atomically: true, encoding: .utf8)
        }
        // 버전 + 플랫폼 + 현재 상태 요약.
        let info = Bundle.main.infoDictionary
        let marketing = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        let summary = """
        Pocket Sisyphus diagnostic package
        generated: \(Date())
        marketing version: \(marketing)
        build: \(build)
        macOS: \(ProcessInfo.processInfo.operatingSystemVersionString)
        daemon state: \(daemon.state)
        daemon health: \(daemon.health)
        daemon listening port: \(daemon.listeningPort.map(String.init) ?? "?")
        runtime file port: \(daemon.runtimeFilePort.map(String.init) ?? "?")
        nat: \(daemon.natStatus)
        sshListening: \(daemon.sshListening)
        onionAddress present: \(daemon.onionAddress != nil)
        """
        try? summary.write(to: tmpDir.appendingPathComponent("summary.txt"),
                           atomically: true, encoding: .utf8)

        // zip — Desktop 에 저장.
        let zipURL = FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("pocketsisyphus-diag-\(ts).zip")
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
        proc.arguments = ["-r", zipURL.path, "."]
        proc.currentDirectoryURL = tmpDir
        do {
            try proc.run()
            proc.waitUntilExit()
            try? FileManager.default.removeItem(at: tmpDir)
            NSWorkspace.shared.activateFileViewerSelecting([zipURL])
            UnifiedLog.info(.macapp, "diagnostic package created", [
                "event.action": "diag.package.create",
                "diag.path": zipURL.path,
            ])
        } catch {
            UnifiedLog.error(.macapp, "diagnostic package failed", [
                "event.action": "diag.package.fail",
                "error.message": error.localizedDescription,
            ])
        }
    }

    /// unified.log 의 secret.* 필드 값과 .onion 주소를 redact.
    private func redactUnifiedLog(_ raw: String) -> String {
        var out = ""
        for line in raw.split(whereSeparator: { $0.isNewline }) {
            let lineStr = String(line)
            guard let data = lineStr.data(using: .utf8),
                  var obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                out += lineStr + "\n"
                continue
            }
            for k in obj.keys where k.hasPrefix("secret.") {
                obj[k] = "<redacted>"
            }
            // message 본문에 박힌 .onion 주소도 마스킹.
            if let msg = obj["message"] as? String {
                obj["message"] = msg.replacingOccurrences(
                    of: #"[a-z2-7]{56}\.onion"#,
                    with: "<redacted-onion>",
                    options: .regularExpression
                )
            }
            if let redacted = try? JSONSerialization.data(withJSONObject: obj, options: []),
               let s = String(data: redacted, encoding: .utf8) {
                out += s + "\n"
            } else {
                out += lineStr + "\n"
            }
        }
        return out
    }

    /// 라우터 관리 페이지에서 22022 포트를 Mac 으로 forwarding 하라는 사용자 안내.
    /// UPnP 자동 매핑이 실패한 환경 (KT/LG 기본 공유기 등) 사용자에게만 노출되는 경로.
    /// 설정 안 해도 Tor fallback 으로 동작하므로 critical 아님 — "빠른 SSH 원하면 설정" 톤.
    @MainActor
    private func showPortForwardingGuideAlert() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = String(localized: "직접 SSH 를 빠르게 쓰려면…")
        alert.informativeText = String(localized: """
        지금은 모든 데이터가 Tor 회로를 거치고 있어 약간 느립니다.
        라우터에서 한 번만 설정하면 직접 SSH 로 10배 빨라집니다.

        설정 방법 (보통 5분 이내):
        1. 공유기 관리 페이지 접속 (대개 192.168.0.1 또는 192.168.1.1)
        2. «포트 포워딩» 또는 «Port Forwarding» 메뉴 진입
        3. 새 규칙 추가:
           - 외부 포트: 22022
           - 내부 포트: 22022
           - 내부 IP: 이 Mac 의 IP
           - 프로토콜: TCP
        4. 저장 후 Pocket Sisyphus 재시작

        설정 안 해도 Tor fallback 으로 계속 동작합니다.
        """)
        alert.alertStyle = .informational
        alert.addButton(withTitle: String(localized: "확인"))
        alert.addButton(withTitle: String(localized: "라우터 IP 확인"))
        if alert.runModal() == .alertSecondButtonReturn {
            openRouterAddress()
        }
    }

    /// macOS 의 기본 게이트웨이 (= 라우터 관리 페이지 IP) 를 브라우저로 연다.
    /// `netstat -nr | grep default` 의 첫 매치를 파싱.
    private func openRouterAddress() {
        let task = Process()
        task.launchPath = "/usr/sbin/netstat"
        task.arguments = ["-nr"]
        let pipe = Pipe()
        task.standardOutput = pipe
        try? task.run()
        task.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8) else { return }
        for line in output.split(separator: "\n") {
            let parts = line.split(separator: " ", omittingEmptySubsequences: true)
            if parts.count >= 2, parts[0] == "default",
               let url = URL(string: "http://\(parts[1])") {
                NSWorkspace.shared.open(url)
                return
            }
        }
    }
}

/// Sparkle 의 SPUUpdater.canCheckForUpdates 는 KVO observable 이지만 SwiftUI 의
/// @StateObject 와 직접 어울리지 않는다 (NSObject KVO ↔ Combine ObservableObject
/// 사이 어댑터가 필요). 한 줄짜리 변환기.
final class UpdaterAdapter: ObservableObject {
    @Published var canCheckForUpdates: Bool = false

    private let updater: SPUUpdater
    private var observation: NSKeyValueObservation?

    init(updater: SPUUpdater) {
        self.updater = updater
        self.canCheckForUpdates = updater.canCheckForUpdates
        // KVO 로 변경 감시 — Sparkle 이 업데이트 체크/다운로드 중에는 false 로 떨어진다.
        self.observation = updater.observe(\.canCheckForUpdates, options: [.new]) { [weak self] _, change in
            DispatchQueue.main.async {
                self?.canCheckForUpdates = change.newValue ?? false
            }
        }
    }
}
