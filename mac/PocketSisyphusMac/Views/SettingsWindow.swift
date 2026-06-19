import SwiftUI
import AppKit

/// 통합 「설정」 창 — 옛 메뉴바의 흩어진 설정 버튼(Discord 알림 / 포트 / 전체 디스크 접근 /
/// 언어)을 한 창의 탭으로 모은다. QRWindowController 와 같은 lifecycle 패턴: 한 번 만들고
/// 재사용(isReleasedWhenClosed=false), show(daemon:power:) 가 앞으로 가져온다. show 마다 reloadToken
/// 을 bump 해 각 탭이 서버/디스크 상태를 다시 읽게 한다.
/// 설정창 탭 — 프로그램적으로 특정 탭을 열기 위한 식별자(권한 자동 안내 등).
enum SettingsTab: Hashable { case llm, notify, asc, design, port, power, permissions, devices, language }

@MainActor
final class SettingsWindowController: ObservableObject {
    private var window: NSWindow?
    /// show() 마다 bump — 탭 내용이 (서버 설정/포트 등) 최신값을 다시 읽도록 트리거.
    @Published var reloadToken = UUID()
    /// 현재 선택된 탭 — TabView 가 바인딩. 권한 자동 안내 시 .permissions 로 설정 후 show.
    @Published var selectedTab: SettingsTab = .llm
    /// 권한 탭에서 강조할 카드 — "screen"|"accessibility"|nil. 몇 초 후 자동 해제.
    @Published var highlightPermission: String?
    /// 권한 자동 오픈 throttle — 사용자가 허용하는 동안 반복해서 다시 열지 않게(종류별).
    private var lastPermShow: [String: Date] = [:]

    func show(daemon: DaemonManager, power: PowerManager) {
        reloadToken = UUID()
        if let w = window {
            w.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let content = SettingsContent(controller: self, daemon: daemon, power: power)
        let host = NSHostingController(rootView: content)
        let w = NSWindow(contentViewController: host)
        // Dev 빌드면 제목에도 ·Dev 표시 — 권한 자동 안내로 열렸을 때 어느 앱인지 바로 보이게.
        let isDev = Bundle.main.bundleIdentifier?.hasSuffix(".dev") == true
        w.title = String(localized: "Pocket Sisyphus — 설정") + (isDev ? " · Dev" : "")
        w.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        w.setContentSize(NSSize(width: 600, height: 660))
        w.center()
        w.isReleasedWhenClosed = false
        window = w
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// iOS 가 캡처/제어를 요구했을 때 호출 — 해당 TCC 권한이 «없을 때만» 설정창을 권한 탭으로 열고
    /// 누락 카드를 강조한다. 이미 허용돼 있으면 아무것도 안 한다(불필요하게 안 띄움). 사용자가
    /// 권한을 켜는 동안 반복 요청으로 다시 열리지 않게 종류별 throttle(15s).
    func showForPermissionRequest(kind: String, daemon: DaemonManager, power: PowerManager) {
        let granted = kind == "screen"
            ? RemoteControlPermissions.screenRecordingGranted
            : RemoteControlPermissions.accessibilityGranted
        if granted { return }
        let now = Date()
        if let last = lastPermShow[kind], now.timeIntervalSince(last) < 15 { return }
        lastPermShow[kind] = now
        selectedTab = .permissions
        highlightPermission = kind
        show(daemon: daemon, power: power)
        // 강조는 잠깐만 — 6초 뒤 해제(같은 kind 일 때만, 그 사이 다른 요청 덮어쓰기 방지).
        Task {
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            if highlightPermission == kind { highlightPermission = nil }
        }
    }
}

private struct SettingsContent: View {
    @ObservedObject var controller: SettingsWindowController
    let daemon: DaemonManager
    let power: PowerManager

    var body: some View {
        TabView(selection: $controller.selectedTab) {
            LocalLlmSettingsView(reloadToken: controller.reloadToken)
                .tabItem { Label("로컬 LLM", systemImage: "cpu") }
                .tag(SettingsTab.llm)
            DiscordSettingsView(reloadToken: controller.reloadToken)
                .tabItem { Label("알림", systemImage: "bell.badge") }
                .tag(SettingsTab.notify)
            AscSettingsView(reloadToken: controller.reloadToken)
                .tabItem { Label("App Store", systemImage: "star.bubble") }
                .tag(SettingsTab.asc)
            DesignSettingsView(reloadToken: controller.reloadToken)
                .tabItem { Label("디자인", systemImage: "paintpalette") }
                .tag(SettingsTab.design)
            PortSettingsView(reloadToken: controller.reloadToken, daemon: daemon)
                .tabItem { Label("포트", systemImage: "network") }
                .tag(SettingsTab.port)
            PowerSettingsView(power: power)
                .tabItem { Label("전원", systemImage: "bolt") }
                .tag(SettingsTab.power)
            PermissionsSettingsView(reloadToken: controller.reloadToken, highlight: controller.highlightPermission)
                .tabItem { Label("권한", systemImage: "checkmark.shield") }
                .tag(SettingsTab.permissions)
            DeviceSettingsView(reloadToken: controller.reloadToken)
                .tabItem { Label("기기", systemImage: "iphone") }
                .tag(SettingsTab.devices)
            LanguageSettingsView()
                .tabItem { Label("언어", systemImage: "globe") }
                .tag(SettingsTab.language)
        }
        .frame(minWidth: 560, minHeight: 600)
        .padding(.top, 6)
    }
}

// MARK: - 전원 탭 (잠자기 방지 / 클램쉘)

/// 「전원」 탭 — 폰에서 시작한 터미널 세션이 Mac 잠자기/덮개 닫힘으로 끊기지 않게 두 토글을 둔다.
/// 상태/로직은 App 이 소유한 `PowerManager`(메뉴바 토글과 공유) 에 위임. 클램쉘은 관리자 인증이
/// 필요한 비동기 작업이라 setClamshell(_:) 을 호출하는 커스텀 바인딩을 쓰고, 켜진 동안은 시스템
/// 전체가 안 자는 상태라 경고 박스를 노출한다.
private struct PowerSettingsView: View {
    @ObservedObject var power: PowerManager

    /// 클램쉘 토글 — 세터가 비동기(관리자 인증)라 직접 바인딩 불가. setClamshell 을 호출하고,
    /// 실패/취소 시 clamshellEnabled 가 안 바뀌어 토글이 자동 원복된다.
    private var clamshellBinding: Binding<Bool> {
        Binding(
            get: { power.clamshellEnabled },
            set: { newValue in Task { await power.setClamshell(newValue) } }
        )
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header

                // 잠자기 방지
                VStack(alignment: .leading, spacing: 6) {
                    Toggle("잠자기 방지", isOn: $power.keepAwakeEnabled)
                        .font(.headline)
                    Text("유휴 상태나 화면 잠금 중에도 Mac이 잠자기로 들어가지 않아요. 화면은 꺼질 수 있지만 터미널 작업은 계속됩니다. Mac mini 같은 데스크톱에도 적용돼요.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.06))
                .clipShape(RoundedRectangle(cornerRadius: 12))

                // 클램쉘 모드
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Toggle("클램쉘 모드 (덮개 닫고 실행)", isOn: clamshellBinding)
                            .font(.headline)
                            .disabled(power.clamshellBusy)
                        if power.clamshellBusy {
                            ProgressView().controlSize(.small)
                        }
                    }
                    Text("MacBook 덮개를 닫아도 잠들지 않게 합니다. 외장 디스플레이가 없어도 동작하지만, macOS 전체 잠자기를 끄는 시스템 설정이라 켜는 동안 Mac이 전혀 잠들지 않아요. 켜고 끌 때 관리자 암호를 한 번 묻습니다.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let err = power.lastError {
                        Text(err)
                            .font(.callout)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.06))
                .clipShape(RoundedRectangle(cornerRadius: 12))

                // 클램쉘 ON = 시스템 전체가 안 자는 상태 → footgun 경고.
                if power.clamshellEnabled {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                        Text("지금 Mac이 잠들지 않도록 설정돼 있어요. 다 쓰면 꺼 주세요.")
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer()
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.orange.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }

                Spacer()
            }
            .padding(20)
        }
        .frame(minWidth: 480, minHeight: 420)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "bolt")
                .font(.largeTitle)
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 4) {
                Text("전원")
                    .font(.title2.weight(.semibold))
                Text("Mac이 잠들면 폰에서 돌리던 터미널 세션이 끊겨요. 아래를 켜면 잠자기·덮개 닫힘에도 계속 돌아갑니다.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
    }
}

// MARK: - 권한 탭 (화면 기록 / 손쉬운 사용 / 전체 디스크 접근)

/// 「권한」 탭 — 폰에서 이 Mac 을 보고 조작하는 데 필요한 권한을 «먼저» 한 자리에서 켜 둔다.
///   - 화면 기록: 라이브 미리보기(capture-helper 의 CGDisplay 캡처).
///   - 손쉬운 사용: 원격 제어(capture-helper 의 CGEvent 주입).
///   - 전체 디스크 접근: 보호 폴더 repo 접근 프롬프트 제거(옛 메뉴바 항목을 여기로 통합).
/// 화면 기록·손쉬운 사용은 OS 가 프로그램적 요청 API 를 주므로 첫 승인 프롬프트를 버튼으로 바로
/// 띄운다. 탭이 보이거나 앱으로 돌아올 때마다(시스템 설정에서 켜고 복귀) 부여 여부를 다시 읽는다.
private struct PermissionsSettingsView: View {
    let reloadToken: UUID
    /// iOS 가 요구했는데 없는 권한 강조 — "screen"|"accessibility"|nil.
    var highlight: String?
    /// bump 하면 각 카드가 부여 여부를 다시 읽는다. onAppear/탭전환/앱 복귀/요청 직후.
    @State private var tick = UUID()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header

                PermissionCardView(
                    icon: "rectangle.dashed.badge.record",
                    title: "화면 기록",
                    detail: "폰에서 이 Mac 화면을 라이브로 보려면 필요해요. 켜 두면 폰의 «결과 › 화면» 에서 데스크톱이 실시간으로 보입니다.",
                    isGranted: { RemoteControlPermissions.screenRecordingGranted },
                    requestTitle: "권한 요청",
                    request: { RemoteControlPermissions.requestScreenRecording(); tick = UUID() },
                    test: { await Task.detached { RemoteControlPermissions.testScreenRecording() }.value },
                    openSettings: { RemoteControlPermissions.openScreenRecordingSettings() },
                    refreshTick: tick,
                    highlighted: highlight == "screen",
                    requiresRestart: true
                )

                PermissionCardView(
                    icon: "hand.tap",
                    title: "손쉬운 사용",
                    detail: "폰에서 이 Mac 을 원격으로 조작(클릭·드래그·키보드 입력)하려면 필요해요. 화면 보기만 할 거면 없어도 됩니다.",
                    isGranted: { RemoteControlPermissions.accessibilityGranted },
                    requestTitle: "권한 요청",
                    request: { RemoteControlPermissions.requestAccessibility(); tick = UUID() },
                    test: { RemoteControlPermissions.testAccessibility() },
                    openSettings: { RemoteControlPermissions.openAccessibilitySettings() },
                    refreshTick: tick,
                    highlighted: highlight == "accessibility"
                )

                PermissionCardView(
                    icon: "folder.badge.gearshape",
                    title: "전체 디스크 접근",
                    detail: "repo 가 Documents·Desktop·Downloads 등 보호 폴더에 있으면 접근할 때마다 «폴더 접근 허용» 프롬프트가 떠요. 한 번 켜 두면 더는 묻지 않습니다.",
                    isGranted: { FullDiskAccess.isProbablyGranted },
                    requestTitle: nil,
                    request: nil,
                    test: nil,
                    openSettings: { FullDiskAccess.openSettings() },
                    refreshTick: tick
                )

                Text("켠 뒤 «테스트» 로 실제로 동작하는지 확인하세요. 실행 중에 권한을 켰다면 앱을 재시작해야 반영될 수 있어요(특히 화면 기록).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Spacer()
            }
            .padding(20)
        }
        .frame(minWidth: 480, minHeight: 420)
        .onAppear { tick = UUID() }
        .onChange(of: reloadToken) { _ in tick = UUID() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            tick = UUID()
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "checkmark.shield")
                .font(.largeTitle)
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 4) {
                Text("권한")
                    .font(.title2.weight(.semibold))
                Text("폰에서 이 Mac 의 화면을 보고 원격으로 조작하려면 아래 권한이 필요해요. 먼저 켜 두면 기능이 바로 동작합니다.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
    }
}

/// 권한 한 칸 — 아이콘·설명·현재 상태 + (요청 가능하면)요청 버튼 + (테스트 가능하면)실동작
/// 테스트 + 시스템 설정 바로가기. 자기 부여 여부(`granted`)와 마지막 테스트 결과를 직접 들고,
/// `refreshTick` 이 바뀌면 부여 여부를 다시 읽는다. TCC 는 켜졌다는데 테스트가 실패하면(실행
/// 세션에 아직 반영 안 됨) «앱 재시작» 안내를 띄운다.
private struct PermissionCardView: View {
    let icon: String
    let title: LocalizedStringKey
    let detail: LocalizedStringKey
    let isGranted: () -> Bool
    let requestTitle: LocalizedStringKey?
    let request: (() -> Void)?
    /// 실동작 테스트. nil 이면 «테스트» 버튼 미노출(예: 전체 디스크 접근).
    let test: (() async -> RemoteControlPermissions.TestResult)?
    let openSettings: () -> Void
    let refreshTick: UUID
    /// iOS 가 이 권한을 요구했는데 없을 때 강조(노란 테두리) — 어떤 권한이 없는지 한눈에.
    var highlighted: Bool = false
    /// 화면 기록처럼 «켠 뒤 앱 재시작이 필요한» 권한 — CGPreflight 가 프로세스 시작 시점 값을
    /// 캐시해 승인해도 재시작 전엔 false 로 남는다. 그래서 미부여 표시여도 «켰다면 재시작» 안내.
    var requiresRestart: Bool = false

    @State private var granted = false
    @State private var lastTest: RemoteControlPermissions.TestResult?
    @State private var testing = false
    @State private var showRestart = false

    /// TCC 는 granted 인데 실동작 테스트가 실패 = 이 실행 세션에 아직 반영 안 됨 → 재시작하면 됨.
    private var staleSession: Bool {
        granted && (lastTest.map { !$0.ok } ?? false)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: icon)
                    .font(.title)
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 30)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.headline)
                    Text(detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
            }

            HStack(spacing: 8) {
                Image(systemName: granted ? "checkmark.circle.fill" : "circle.dashed")
                    .foregroundStyle(granted ? Color.green : Color.secondary)
                (granted ? Text("허용됨") : Text("아직 허용되지 않음"))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Spacer()
                if !granted, let request, let requestTitle {
                    Button(action: request) { Text(requestTitle) }
                        .buttonStyle(.borderedProminent)
                }
                if let test {
                    Button {
                        testing = true
                        Task {
                            let r = await test()
                            lastTest = r
                            testing = false
                        }
                    } label: {
                        if testing {
                            ProgressView().controlSize(.small)
                        } else {
                            Label("테스트", systemImage: "checkmark.seal")
                        }
                    }
                    .disabled(testing)
                }
                Button(action: openSettings) {
                    Label("시스템 설정 열기", systemImage: "gearshape")
                }
            }

            if let lastTest {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: lastTest.ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                        .foregroundStyle(lastTest.ok ? Color.green : Color.red)
                    Text(lastTest.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                }
            }

            // 재시작 안내 — ① staleSession(TCC 는 켜졌다는데 테스트 실패=실행 세션 미반영), 또는
            // ② requiresRestart(화면 기록)이고 아직 미부여로 «보일» 때. ②는 CGPreflight 가 캐시라
            // 승인해도 재시작 전엔 계속 false 로 나오는 함정 — 그래서 «켰다면 재시작» 을 항상 안내해
            // 사용자가 앱(+daemon)을 재시작하게 한다. 재시작하면 캡처 헬퍼가 새 권한으로 동작.
            if staleSession || (requiresRestart && !granted) {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.clockwise")
                        .foregroundStyle(.secondary)
                    Text(staleSession
                        ? "권한은 켜졌지만 실행 중인 앱에 아직 반영되지 않았어요. 재시작하면 적용됩니다."
                        : "이미 시스템 설정에서 켰다면, 적용하려면 앱을 재시작하세요(화면 기록은 재시작 후 반영).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("앱 재시작") { showRestart = true }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        // «설정 필요» 강조 — 색 정책상 warning(노랑). iOS 가 이 권한을 요구했는데 없을 때만.
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color.yellow, lineWidth: highlighted ? 3 : 0)
        )
        .onAppear { granted = isGranted() }
        .onChange(of: refreshTick) { _ in granted = isGranted() }
        .alert("앱을 재시작할까요?", isPresented: $showRestart) {
            Button("지금 재시작", role: .destructive) { LanguageOverride.relaunchSelf() }
            Button("나중에", role: .cancel) {}
        } message: {
            Text("권한을 이 실행에 반영하려면 앱을 재시작해야 해요. 연결된 폰은 잠깐 끊겼다 다시 붙습니다.")
        }
    }
}

// MARK: - 기기 탭 (페어링된 기기 정보 / 해제)

/// 「기기」 탭 — 이 Mac 에 인증/페어링된 폰들(최대 3대)을 보여 주고 관리한다.
/// 기본은 1대만 허용. «추가 기기 허용» 토글을 켜야 1대를 넘는 기기가 페어링할 수 있다.
/// - 기기별 해제(revoke): 그 기기의 인증만 무효화(나머지는 유지).
/// - 모든 기기 해제 + 새 QR(rotate-pairing): 전부 무효화하고 새 페어링 QR 발급.
private struct DeviceSettingsView: View {
    let reloadToken: UUID

    @State private var info: DaemonAPI.DeviceInfo?
    @State private var loadError: String?
    @State private var loading = true
    /// 토글의 표시 상태 — info 로드 시 동기화, 사용자가 만지면 낙관적 갱신 후 실패 시 되돌림.
    @State private var extraSlotOn = false
    @State private var slotBusy = false
    @State private var confirmRotate = false
    @State private var busy = false
    /// 해제 확인 중인 기기 지문 (nil = 확인 알럿 닫힘).
    @State private var confirmRevokeFingerprint: String?
    @State private var actionResult: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header

                if loading {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("불러오는 중…").font(.callout).foregroundStyle(.secondary)
                    }
                } else if let loadError {
                    Text(loadError)
                        .font(.callout)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                } else if let info {
                    if info.enrolled {
                        ForEach(Array(info.devices.enumerated()), id: \.element.id) { idx, device in
                            enrolledCard(device, index: idx, sshFingerprint: info.sshClientKeyFingerprint)
                        }
                        slotToggleSection(info)
                        rotateSection
                    } else {
                        notEnrolledCard
                    }
                }

                if let actionResult {
                    Text(actionResult)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer()
            }
            .padding(20)
        }
        .frame(minWidth: 480, minHeight: 420)
        .onAppear { Task { await load() } }
        .onChange(of: reloadToken) { _ in Task { await load() } }
        .alert("이 기기를 해제할까요?", isPresented: revokeAlertPresented) {
            Button("해제", role: .destructive) {
                if let fp = confirmRevokeFingerprint { Task { await revoke(fingerprint: fp) } }
            }
            Button("취소", role: .cancel) { confirmRevokeFingerprint = nil }
        } message: {
            Text("해제하면 이 기기의 인증만 무효화돼요. 다른 기기는 그대로 유지돼요. 이 기기를 다시 쓰려면 폰에서 다시 페어링해야 합니다.")
        }
        .alert("모든 기기를 해제할까요?", isPresented: $confirmRotate) {
            Button("모두 해제", role: .destructive) { Task { await rotateAll() } }
            Button("취소", role: .cancel) {}
        } message: {
            Text("연결된 모든 기기의 인증이 무효화되고 새 페어링 QR 이 생성돼요. 다시 쓰려면 폰에서 새 QR 을 스캔해야 합니다.")
        }
    }

    private var revokeAlertPresented: Binding<Bool> {
        Binding(
            get: { confirmRevokeFingerprint != nil },
            set: { if !$0 { confirmRevokeFingerprint = nil } })
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "iphone")
                .font(.largeTitle)
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 4) {
                Text("기기")
                    .font(.title2.weight(.semibold))
                Text("이 Mac 에 인증된 폰을 확인하고, 필요하면 접근을 해제할 수 있어요. 기본은 한 대만 연결되며, 아래에서 추가 기기를 허용할 수 있어요.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
    }

    /// 등록(=Secure Enclave 기기 인증 활성)된 폰 카드 + 기기별 해제 버튼.
    private func enrolledCard(
        _ device: DaemonAPI.DeviceInfo.Device, index: Int, sshFingerprint: String?
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.seal.fill").foregroundStyle(.green)
                Text("기기 \(index + 1)").font(.headline)
                Spacer()
                Text("인증됨")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Color.green.opacity(0.18))
                    .foregroundStyle(.green)
                    .clipShape(Capsule())
            }
            infoRow(label: Text("등록"), value: Self.formatDate(device.registeredAt))
            infoRow(
                label: Text("마지막 접속"),
                value: device.lastSeen != nil
                    ? Self.formatDate(device.lastSeen)
                    : String(localized: "이번 부팅 후 기록 없음"))
            if let fp = device.attestKeyFingerprint {
                fingerprintRow(label: Text("기기 키 지문"), value: fp)
            }
            if let fp = sshFingerprint {
                fingerprintRow(label: Text("SSH 키 지문"), value: fp)
            }
            HStack {
                Button(role: .destructive) {
                    confirmRevokeFingerprint = device.attestKeyFingerprint
                } label: {
                    Label("이 기기 해제", systemImage: "xmark.shield")
                }
                .disabled(busy || device.attestKeyFingerprint == nil)
                Spacer()
            }
            .padding(.top, 2)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    /// «추가 기기 허용» 토글 — 기본 꺼짐. 켜야 1대를 넘는 기기가 페어링 가능.
    private func slotToggleSection(_ info: DaemonAPI.DeviceInfo) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle(isOn: slotBinding) {
                Text("추가 기기 허용")
                    .font(.headline)
            }
            .disabled(slotBusy)
            Text("켜면 기기를 최대 \(info.maxSlots)대까지 연결할 수 있어요. 끄려면 먼저 기기를 한 대만 남겨 두세요.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("현재 \(info.devices.count)대 연결됨")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    /// 토글 바인딩 — 사용자가 만지면 낙관적으로 표시 갱신하고 daemon 에 반영, 실패 시 되돌림.
    private var slotBinding: Binding<Bool> {
        Binding(
            get: { extraSlotOn },
            set: { newValue in
                let previous = extraSlotOn
                extraSlotOn = newValue
                Task { await applySlot(newValue, previous: previous) }
            })
    }

    private var rotateSection: some View {
        HStack {
            Button(role: .destructive) {
                confirmRotate = true
            } label: {
                if busy {
                    ProgressView().controlSize(.small)
                } else {
                    Label("모든 기기 해제 + 새 QR", systemImage: "arrow.triangle.2.circlepath")
                }
            }
            .disabled(busy)
            Spacer()
        }
    }

    /// 아직 기기 인증이 등록되지 않은 상태(옛 폰 앱 / 미등록) 안내.
    private var notEnrolledCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.shield").foregroundStyle(.secondary)
                Text("아직 기기 인증이 설정되지 않았어요").font(.headline)
            }
            Text("폰 앱을 최신 버전으로 업데이트하고 다시 페어링하면, 인증된 폰만 이 Mac 에 접근하도록 잠겨요. 그 전까지는 페어링 정보를 가진 기기가 접근할 수 있어요.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func infoRow(label: Text, value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            label.font(.callout).foregroundStyle(.secondary)
            Spacer()
            Text(verbatim: value).font(.callout.monospacedDigit())
        }
    }

    private func fingerprintRow(label: Text, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            label.font(.caption).foregroundStyle(.secondary)
            Text(verbatim: value)
                .font(.caption2.monospaced())
                .textSelection(.enabled)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @MainActor
    private func load() async {
        loading = true
        loadError = nil
        defer { loading = false }
        do {
            let fetched = try await DaemonAPI.deviceInfo()
            info = fetched
            extraSlotOn = fetched.extraSlotAllowed
        } catch {
            loadError = String(localized: "기기 정보를 불러오지 못했어요 — daemon 이 실행 중인지 확인하세요")
        }
    }

    /// 추가 기기 슬롯 토글 적용. 1대를 넘게 등록된 상태에서 끄려 하면 daemon 이 거절 → 표시 되돌림.
    @MainActor
    private func applySlot(_ allowed: Bool, previous: Bool) async {
        slotBusy = true
        actionResult = nil
        defer { slotBusy = false }
        do {
            try await DaemonAPI.setExtraDeviceSlot(allowed: allowed)
            await load()
        } catch DaemonAPI.Error.api(let code, _) where code == "remove_extra_device_first" {
            extraSlotOn = previous  // 되돌림
            actionResult = String(localized: "끄기 전에 먼저 기기를 한 대만 남겨 두세요.")
        } catch {
            extraSlotOn = previous
            actionResult = String(localized: "설정 변경 실패: \((error as? LocalizedError)?.errorDescription ?? "\(error)")")
        }
    }

    /// 기기 1대 해제(revoke) — 나머지 기기는 유지.
    @MainActor
    private func revoke(fingerprint: String) async {
        confirmRevokeFingerprint = nil
        busy = true
        actionResult = nil
        defer { busy = false }
        do {
            try await DaemonAPI.revokeDevice(fingerprint: fingerprint)
            actionResult = String(localized: "기기를 해제했어요.")
            await load()
        } catch {
            actionResult = String(localized: "해제 실패: \((error as? LocalizedError)?.errorDescription ?? "\(error)")")
        }
    }

    /// 모든 기기 해제 + 새 QR(rotate-pairing).
    @MainActor
    private func rotateAll() async {
        busy = true
        actionResult = nil
        defer { busy = false }
        do {
            _ = try await DaemonAPI.rotatePairing()
            actionResult = String(localized: "모두 해제됐어요 — 메뉴 › 페어링 QR 보기 의 새 QR 을 폰에서 다시 스캔하세요")
            await load()  // 이제 enrolled=false 로 갱신
        } catch {
            actionResult = String(localized: "해제 실패: \((error as? LocalizedError)?.errorDescription ?? "\(error)")")
        }
    }

    /// epoch ms → 사용자 로케일 medium 날짜+시각. nil 이면 "—".
    private static func formatDate(_ ms: Int64?) -> String {
        guard let ms else { return "—" }
        let date = Date(timeIntervalSince1970: Double(ms) / 1000.0)
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f.string(from: date)
    }
}

// MARK: - 언어 탭

/// 「언어」 탭 — 10개 언어 + 시스템 언어. 선택 시 self-relaunch 확인 alert. 옛 메뉴바의
/// 「언어」 서브메뉴를 여기로 통합. 진짜 NSWindow 라 SwiftUI .alert 가 정상 동작한다
/// (메뉴바 popover 의 자동닫힘 문제 없음).
private struct LanguageSettingsView: View {
    @State private var showRestart = false
    @State private var pendingCode: String? = nil  // nil = 시스템으로 되돌리기
    /// 화면 갱신용 — 선택 직후 체크 위치를 즉시 반영. 실제 적용은 재시작 후.
    @State private var currentSelection: String? = LanguageOverride.current

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "globe")
                        .font(.largeTitle)
                        .foregroundStyle(Color.accentColor)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("언어")
                            .font(.title2.weight(.semibold))
                        Text("앱 화면 언어를 고릅니다. 선택하면 앱을 재시작해 적용해요.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                }

                VStack(spacing: 0) {
                    languageRow(label: Text("시스템 언어 사용"), selected: currentSelection == nil) {
                        pendingCode = nil
                        showRestart = true
                    }
                    Divider()
                    ForEach(LanguageOverride.languages, id: \.code) { lang in
                        languageRow(label: Text(verbatim: lang.name), selected: currentSelection == lang.code) {
                            pendingCode = lang.code
                            showRestart = true
                        }
                        if lang.code != LanguageOverride.languages.last?.code {
                            Divider()
                        }
                    }
                }
                .background(Color.secondary.opacity(0.06))
                .clipShape(RoundedRectangle(cornerRadius: 10))

                Spacer()
            }
            .padding(20)
        }
        .frame(minWidth: 480, minHeight: 420)
        .alert("앱을 재시작해야 적용됩니다", isPresented: $showRestart) {
            Button("지금 재시작") {
                LanguageOverride.set(pendingCode)
                LanguageOverride.relaunchSelf()
            }
            Button("나중에", role: .cancel) {}
        } message: {
            Text("선택한 언어가 앱 재시작 후에 적용됩니다.")
        }
    }

    private func languageRow(label: Text, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                label
                Spacer()
                if selected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(.tint)
                        .accessibilityHidden(true)  // 장식 — 선택 상태는 .isSelected 트레잇으로 전달.
                }
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - 로컬 LLM 탭 (모델 다운로드 / 삭제 / 선택)

/// 「로컬 LLM」 탭 — 카탈로그 모델을 받고(다운로드), 받은 모델을 삭제하고, 사용할 모델을
/// 고른다(선택). 다운로드는 동시 1개라 진행 중에는 다른 다운로드 버튼을 막는다. 진행률은
/// daemon GET /api/local-llm/status 를 ~1.2s 폴링해 표시(다운로드 활성일 때만).
private struct LocalLlmSettingsView: View {
    let reloadToken: UUID

    @State private var models: [DaemonAPI.LlmCatalogModel] = []
    @State private var recommendedId: String?
    @State private var selectedId: String?
    @State private var hardware: DaemonAPI.LlmHardware?
    @State private var download: DaemonAPI.LlmDownloadProgress?
    @State private var loadError: String?
    @State private var actionError: String?
    @State private var busyModelId: String?   // select/delete in-flight
    @State private var pollTask: Task<Void, Never>?
    /// 로컬 LLM 런타임(llama-server / qwen) 설치 여부 — daemon status.binaries.
    @State private var binaries: DaemonAPI.LlmBinaries?
    /// 방금 복사한 명령 — 복사 버튼이 잠깐 「복사됨」 으로 바뀌게.
    @State private var copiedCmd: String?
    /// 런타임 구성요소(llama-server/qwen) 설치 진행 — daemon 폴링 결과. nil 이면 미시작.
    @State private var installProgress: DaemonAPI.AgentInstallProgress?
    /// 진행 중인 설치 폴링 task — 탭 종료 시 취소.
    @State private var installTask: Task<Void, Never>?
    @State private var selectedCtxSize: Int = 32768
    /// llama-server 런타임 상태 — ctx 변경 후 「재시작 필요」 안내 판정에 쓴다.
    @State private var server: DaemonAPI.LlmServerInfo?

    /// 지금 무언가를 받는 중인지 — 다른 다운로드 버튼을 막는 데 쓴다.
    private var downloadActive: Bool {
        guard let s = download?.state else { return false }
        return s == "downloading" || s == "verifying"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if let hw = hardware {
                    hardwareLine(hw)
                }
                runtimeSection
                contextSizeSection
                if let loadError {
                    errorBox(loadError)
                }
                if let actionError {
                    errorBox(actionError)
                }
                ForEach(models) { m in
                    modelCard(m)
                }
            }
            .padding(20)
        }
        .frame(minWidth: 480, minHeight: 460)
        .onAppear { Task { await loadAll() } }
        .onChange(of: reloadToken) { _ in Task { await loadAll() } }
        .onDisappear {
            pollTask?.cancel()
            pollTask = nil
            installTask?.cancel()
            installTask = nil
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "cpu")
                .font(.largeTitle)
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 4) {
                Text("로컬 LLM")
                    .font(.title2.weight(.semibold))
                Text("로컬에서 도는 코드 에이전트 모델을 받아 관리해요.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
    }

    private func hardwareLine(_ hw: DaemonAPI.LlmHardware) -> some View {
        // "Apple M4 Pro · 64 GB" — 칩/용량은 번역 대상 아님.
        let ram = Int((Double(hw.totalRamBytes) / 1_073_741_824).rounded())
        let chip = hw.chipBrand ?? "Mac"
        return HStack(spacing: 8) {
            Image(systemName: "memorychip")
                .foregroundStyle(.secondary)
            Text("\(chip) · \(ram) GB")
                .font(.callout.monospacedDigit())
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(10)
        .background(Color.secondary.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func errorBox(_ msg: String) -> some View {
        Text(msg)
            .font(.callout)
            .foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func modelCard(_ m: DaemonAPI.LlmCatalogModel) -> some View {
        let recRam = Int((Double(m.recommendedRamBytes) / 1_073_741_824).rounded())
        let tight = (hardware?.totalRamBytes ?? Int64.max) < m.recommendedRamBytes
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(verbatim: m.displayName)
                    .font(.headline)
                if m.id == recommendedId { badge(Text("추천"), .green) }
                if m.id == selectedId { badge(Text("선택됨"), Color.accentColor) }
                if m.downloaded { badge(Text("받음"), .secondary) }
                Spacer()
                Text(verbatim: sizeGB(m.fileSizeBytes))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Text(verbatim: m.description)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                Text(verbatim: "≥ \(recRam) GB RAM · ~\(Int(m.estDecodeTokSec)) tok/s")
                    // 빠듯 = 진짜 주의 → warning(노랑). 주황(.orange)은 pro 전용이라 안 쓴다.
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(tight ? Color.yellow : Color.secondary)
                if tight {
                    Text("이 Mac 메모리에는 빠듯할 수 있어요")
                        .font(.caption2)
                        .foregroundStyle(.yellow)
                }
                Spacer()
                // 도구호출 적합성 — 분석 전용은 warning(노랑), 가능은 중립(secondary). nil(구버전 daemon)=가능 취급.
                if m.toolCallCapable == false {
                    Label("분석 전용", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.yellow)
                } else {
                    Label("도구호출", systemImage: "wrench.and.screwdriver")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            if download?.modelId == m.id && downloadActive {
                downloadProgress(m)
            } else {
                actionRow(m)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func badge(_ text: Text, _ color: Color) -> some View {
        text
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.18))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }

    @ViewBuilder
    private func downloadProgress(_ m: DaemonAPI.LlmCatalogModel) -> some View {
        let d = download
        VStack(alignment: .leading, spacing: 4) {
            if d?.state == "verifying" {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("검증 중…").font(.caption)
                }
            } else {
                ProgressView(value: min(1, max(0, (d?.percent ?? 0) / 100)))
                    .controlSize(.small)
                Text(verbatim: progressText(d))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Button(role: .destructive) {
                Task { await cancel() }
            } label: {
                Label("취소", systemImage: "xmark.circle")
            }
            .controlSize(.small)
        }
    }

    @ViewBuilder
    private func actionRow(_ m: DaemonAPI.LlmCatalogModel) -> some View {
        HStack(spacing: 10) {
            if m.downloaded {
                if m.id != selectedId {
                    Button {
                        Task { await select(m.id) }
                    } label: {
                        Label("선택", systemImage: "checkmark.circle")
                    }
                    // 분석 전용(도구호출 불가) 모델은 에이전트 백엔드로 못 쓴다 — 선택 비활성.
                    .disabled(busyModelId != nil || m.toolCallCapable == false)
                }
                Button(role: .destructive) {
                    Task { await delete(m.id) }
                } label: {
                    Label("삭제", systemImage: "trash")
                }
                .disabled(busyModelId != nil)
            } else {
                Button {
                    Task { await startDownload(m.id) }
                } label: {
                    Label("다운로드", systemImage: "arrow.down.circle")
                }
                .disabled(downloadActive || busyModelId != nil)
            }
            Spacer()
            if busyModelId == m.id {
                ProgressView().controlSize(.small)
            }
        }
    }

    // MARK: - 표시 헬퍼 (번역 대상 아님)

    private func sizeGB(_ bytes: Int64) -> String {
        String(format: "%.1f GB", Double(bytes) / 1_000_000_000)
    }

    private func progressText(_ d: DaemonAPI.LlmDownloadProgress?) -> String {
        guard let d else { return "" }
        let pct = Int(d.percent.rounded())
        if d.bytesPerSec > 0 {
            let mbps = String(format: "%.0f", d.bytesPerSec / 1_000_000)
            return "\(pct)% · \(mbps) MB/s"
        }
        return "\(pct)%"
    }

    // MARK: - 동작

    @MainActor
    private func loadAll() async {
        actionError = nil
        do {
            async let cat = DaemonAPI.localLlmModels()
            async let st = DaemonAPI.localLlmFullStatus()
            let catalog = try await cat
            let status = try await st
            models = catalog.catalog
            recommendedId = catalog.recommendedModelId
            selectedId = catalog.selectedModelId
            selectedCtxSize = status.ctxSize ?? Self.ctxDefault
            hardware = status.hardware
            download = status.download
            binaries = status.binaries
            server = status.server
            loadError = nil
            startPollingIfNeeded()
        } catch {
            loadError = String(localized: "모델 목록을 불러오지 못했어요 — daemon 이 실행 중인지 확인하세요")
        }
    }

    @MainActor
    private func loadModels() async {
        if let catalog = try? await DaemonAPI.localLlmModels() {
            models = catalog.catalog
            recommendedId = catalog.recommendedModelId
            selectedId = catalog.selectedModelId
        }
    }

    /// 다운로드가 활성이면 ~1.2s 폴링으로 진행률을 갱신하고, 끝나면 모델 목록을 새로고침한 뒤
    /// 폴링을 멈춘다. 이미 폴링 중이면 중복 시작하지 않는다.
    private func startPollingIfNeeded() {
        guard downloadActive, pollTask == nil else { return }
        pollTask = Task { @MainActor in
            defer { pollTask = nil }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_200_000_000)
                if Task.isCancelled { return }
                guard let st = try? await DaemonAPI.localLlmFullStatus() else { continue }
                download = st.download
                let s = st.download.state
                if s != "downloading" && s != "verifying" {
                    await loadModels()   // downloaded 플래그 갱신
                    return
                }
            }
        }
    }

    @MainActor
    private func startDownload(_ id: String) async {
        actionError = nil
        do {
            try await DaemonAPI.downloadLocalLlmModel(id)
            // 즉시 진행 상태를 한 번 당겨와 카드가 곧장 progress 로 전환되게.
            if let st = try? await DaemonAPI.localLlmFullStatus() { download = st.download }
            startPollingIfNeeded()
        } catch {
            actionError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    @MainActor
    private func cancel() async {
        actionError = nil
        try? await DaemonAPI.cancelLocalLlmDownload()
        if let st = try? await DaemonAPI.localLlmFullStatus() { download = st.download }
        await loadModels()
    }

    @MainActor
    private func delete(_ id: String) async {
        actionError = nil
        busyModelId = id
        defer { busyModelId = nil }
        do {
            try await DaemonAPI.deleteLocalLlmModel(id)
            await loadModels()
        } catch {
            actionError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    @MainActor
    private func select(_ id: String) async {
        actionError = nil
        busyModelId = id
        defer { busyModelId = nil }
        do {
            try await DaemonAPI.saveLocalLlmConfig(modelId: id, ctxSize: selectedCtxSize)
            await loadModels()
        } catch {
            actionError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    // MARK: - 런타임 환경 (설치/제거 가이드)

    /// 로컬 LLM 런타임(추론 서버 llama.cpp + 에이전트 CLI Qwen Code) 설치 상태 + 가이드.
    /// 둘은 .app 에 번들되지 않고 사용자 시스템(Homebrew/npm)에 설치돼야 한다 — 데몬이
    /// 그 설치 여부를 status.binaries 로 보고하고, 여기서 상태 + 설치/제거 명령을 보여 준다.
    @ViewBuilder
    private var runtimeSection: some View {
        let homebrew = binaries?.homebrew ?? false
        let llama = binaries?.llamaServer ?? false
        let qwen = binaries?.qwen ?? false
        // Homebrew 가 없으면 brew 설치가 전부 막힌다 — 점검 항목 + 준비 판정에 모두 포함.
        let ready = homebrew && llama && qwen
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("로컬 LLM 환경").font(.headline)
                Spacer()
                Button { Task { await loadAll() } } label: {
                    Label("새로고침", systemImage: "arrow.clockwise")
                }
                .controlSize(.small)
            }
            runtimeStatusRow(label: Text("Homebrew(필수)"), detail: "brew", ok: homebrew)
            runtimeStatusRow(label: Text("추론 서버"), detail: "llama.cpp", ok: llama)
            runtimeStatusRow(label: Text("에이전트 CLI"), detail: "Qwen Code", ok: qwen)

            if !ready {
                VStack(alignment: .leading, spacing: 8) {
                    Text("로컬 LLM 을 실행하려면 아래 도구가 필요해요. 버튼 한 번으로 설치하거나, 명령을 복사해 직접 설치할 수 있어요. Homebrew 와 Node(npm) 가 설치돼 있어야 해요.")
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                    // Homebrew 미설치면 llama/qwen 설치 행보다 먼저 brew 설치 안내를 보여 막다른
                    // 길을 막는다. brew 원탭 자동 설치는 sudo/CLT 프롬프트로 헤드리스가 깨지고
                    // 셸 프로필을 건드리므로 만들지 않는다 — 감지 + 복사 안내가 안전한 착지점.
                    if !homebrew {
                        homebrewSetupBlock
                    }
                    if !llama || !qwen {
                        Text("설치 방법").font(.subheadline.weight(.medium))
                        if !llama {
                            runtimeInstallRow(component: "llama-server", cmd: "brew install llama.cpp")
                        }
                        if !qwen {
                            runtimeInstallRow(component: "qwen", cmd: "npm install -g @qwen-code/qwen-code")
                        }
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.orange.opacity(0.10))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }

            DisclosureGroup {
                VStack(alignment: .leading, spacing: 8) {
                    commandRow("brew uninstall llama.cpp")
                    commandRow("npm uninstall -g @qwen-code/qwen-code")
                }
                .padding(.top, 6)
            } label: {
                Text("제거 방법").font(.subheadline.weight(.medium))
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - 컨텍스트 크기

    /// 제공하는 컨텍스트 옵션 — 선택 모델의 ctxMax 를 넘는 항목은 숨긴다.
    private static let ctxOptions: [Int] = [16_384, 32_768, 65_536, 98_304, 131_072]
    private static let ctxDefault = 32_768

    private var availableCtxOptions: [Int] {
        let cap = models.first(where: { $0.id == selectedId })?.ctxMax ?? 131_072
        return Self.ctxOptions.filter { $0 <= cap }
    }

    /// 떠 있는 우리 서버가 다른 ctx 로 돌고 있으면 true — 재시작 안내 표시.
    /// adopted 외부 서버는 ctxSize 를 모르므로(nil) 안내하지 않는다.
    private var ctxRestartNeeded: Bool {
        guard let srv = server, srv.state == "ready", let running = srv.ctxSize else { return false }
        return running != selectedCtxSize
    }

    @ViewBuilder
    private var contextSizeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Text("컨텍스트 크기").font(.headline)
                Spacer()
                Picker("컨텍스트 크기", selection: Binding(
                    get: { selectedCtxSize },
                    set: { newSize in
                        selectedCtxSize = newSize
                        Task { await saveCtxSize(newSize) }
                    }
                )) {
                    ForEach(availableCtxOptions, id: \.self) { size in
                        ctxOptionText(size).tag(size)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .fixedSize()
            }
            Text("컨텍스트가 클수록 한 번에 더 많은 코드와 대화를 다룰 수 있지만, 메모리 사용량과 응답 지연이 늘어요. 64k 이상은 RAM 64GB 이상 Mac 에서 권장해요. 모델의 네이티브 한계를 넘는 크기는 rope 스케일링(YaRN)이 자동 적용돼요.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if ctxRestartNeeded {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text("실행 중인 서버는 아직 이전 크기로 떠 있어요 — 정지하면 다음 사용 때 새 크기로 시작해요.")
                        .font(.caption)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button {
                        Task { await stopRunningServer() }
                    } label: {
                        Label("서버 정지", systemImage: "stop.circle")
                    }
                    .controlSize(.small)
                }
                .padding(8)
                .background(Color.orange.opacity(0.10))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    /// "32,768 (32k · 기본값)" / "65,536 (64k)" — 숫자 표기는 비번역, 「기본값」 만 번역 대상.
    private func ctxOptionText(_ size: Int) -> Text {
        let formatted = size.formatted(.number)
        let short = "\(size / 1024)k"
        if size == Self.ctxDefault {
            return Text("\(formatted) (\(short) · 기본값)")
        }
        return Text(verbatim: "\(formatted) (\(short))")
    }

    @MainActor
    private func saveCtxSize(_ size: Int) async {
        actionError = nil
        do {
            try await DaemonAPI.saveLocalLlmConfig(modelId: selectedId, ctxSize: size)
            await loadAll()
        } catch {
            actionError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// 재시작 안내의 「서버 정지」 — 우리가 띄운 서버만 정지된다(daemon 보장). 다음
    /// 온디맨드 기동이 새 ctx 로 뜬다.
    @MainActor
    private func stopRunningServer() async {
        actionError = nil
        do {
            try await DaemonAPI.stopLocalLlm()
            await loadAll()
        } catch {
            actionError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// Homebrew 미설치 Mac 의 막다른 길 방지 — 복사 가능한 공식 설치 명령(+ 선행 Xcode CLT)과
    /// brew.sh 링크. 자동 설치 버튼은 일부러 만들지 않는다(sudo/CLT 프롬프트·셸 프로필 변경).
    @ViewBuilder
    private var homebrewSetupBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Homebrew 설치").font(.subheadline.weight(.medium))
            Text("llama.cpp 는 Homebrew 로 설치해요. 먼저 Xcode 명령행 도구를 설치한 뒤 Homebrew 설치 스크립트를 실행하고, 끝나면 「새로고침」 을 누르세요.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            commandRow("xcode-select --install")
            commandRow("/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"")
            Link(destination: URL(string: "https://brew.sh")!) {
                Label("brew.sh", systemImage: "arrow.up.right.square").font(.caption)
            }
        }
    }

    private func runtimeStatusRow(label: Text, detail: String, ok: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(ok ? Color.green : Color.orange)
            label.font(.callout)
            Text(verbatim: detail).font(.caption).foregroundStyle(.secondary)
            Spacer()
            (ok ? Text("설치됨") : Text("미설치"))
                .font(.caption.weight(.medium))
                .foregroundStyle(ok ? Color.green : Color.orange)
        }
    }

    /// 복사 가능한 쉘 명령 한 줄 — monospace + 「복사」 버튼(누르면 잠깐 「복사됨」).
    private func commandRow(_ cmd: String) -> some View {
        HStack(spacing: 8) {
            Text(verbatim: cmd)
                .font(.callout.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                copyCommand(cmd)
            } label: {
                Label {
                    copiedCmd == cmd ? Text("복사됨") : Text("복사")
                } icon: {
                    Image(systemName: copiedCmd == cmd ? "checkmark" : "doc.on.doc")
                }
            }
            .controlSize(.small)
        }
        .padding(8)
        .background(Color.black.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func copyCommand(_ cmd: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(cmd, forType: .string)
        copiedCmd = cmd
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if copiedCmd == cmd { copiedCmd = nil }
        }
    }

    /// 구성요소 설치 행 — monospace 명령 + 「복사」(폴백) + 「설치」 버튼. 설치 버튼은 폰과 같은
    /// daemon 라우트(/api/admin/install-agent { component })를 호출하고, 진행/로그/완료/실패를
    /// 행 아래에 표시한다. 버튼은 기본 accent(별도 tint 없음).
    @ViewBuilder
    private func runtimeInstallRow(component: String, cmd: String) -> some View {
        let targetId = "local_llm/\(component)"
        let active = installProgress.map { $0.adapterId == targetId } ?? false
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(verbatim: cmd)
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    copyCommand(cmd)
                } label: {
                    Label {
                        copiedCmd == cmd ? Text("복사됨") : Text("복사")
                    } icon: {
                        Image(systemName: copiedCmd == cmd ? "checkmark" : "doc.on.doc")
                    }
                }
                .controlSize(.small)
                Button {
                    startInstall(component: component)
                } label: {
                    Label("설치", systemImage: "arrow.down.circle")
                }
                .controlSize(.small)
                // 한 번에 하나만 — 다른 구성요소 설치 중엔 비활성(daemon 도 409 busy).
                .disabled(installProgress?.state == "installing")
            }
            .padding(8)
            .background(Color.black.opacity(0.06))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            if active, let p = installProgress {
                installStatusView(p)
            }
        }
    }

    /// 설치 진행 표시 — 스피너+상태, 누적 로그(말미), 실패 시 폴백 안내. (8ffc54d2 수준 — 종료
    /// 코드/로그 tail 만, 빌드 스트리밍은 비-목표.)
    @ViewBuilder
    private func installStatusView(_ p: DaemonAPI.AgentInstallProgress) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                if p.state == "installing" {
                    ProgressView().controlSize(.small)
                    Text("설치하는 중…").foregroundStyle(.secondary)
                } else if p.state == "done" {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.green)
                    Text("설치 완료").foregroundStyle(Color.green)
                } else {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Color.orange)
                    Text("설치 실패").foregroundStyle(Color.orange)
                }
            }
            .font(.caption)
            if !p.log.isEmpty {
                ScrollView {
                    Text(verbatim: p.log)
                        .font(.system(.caption2, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 140)
            }
            if p.state == "error" {
                Text("자동 설치에 실패했어요. 위 명령을 터미널에서 직접 실행한 뒤 다시 시도하세요.")
                    .font(.caption2)
                    .foregroundStyle(Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                // brew 자체가 없어 실패한 경우만 (daemon 의 homebrew_missing 코드) — 정확한
                // Homebrew 설치 안내로 분기. 빌드 오류 등 다른 실패엔 띄우지 않아 오해를 막는다.
                if p.error == "homebrew_missing" {
                    Text("Homebrew 가 없으면 llama.cpp 를 설치할 수 없어요. brew.sh 에서 Homebrew 를 설치한 뒤 다시 시도하세요.")
                        .font(.caption2)
                        .foregroundStyle(Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                // npm/node 자체가 없어 실패한 경우 (daemon 의 node_missing 코드) — 정확한 Node.js
                // 설치 안내로 분기. npm 설치 명령은 Node.js 가 깔려 있어야 동작하는데 그 전제가 안내에 빠져 있었다.
                if p.error == "node_missing" {
                    Text("Node.js(npm) 가 없으면 이 도구를 설치할 수 없어요. nodejs.org 의 Node.js 를 설치한 뒤 다시 시도하세요.")
                        .font(.caption2)
                        .foregroundStyle(Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// 「설치」 탭 — 진행 중 task 를 취소하고 새 설치 폴링 루프를 시작한다.
    private func startInstall(component: String) {
        installTask?.cancel()
        installTask = Task { await runInstall(component: component) }
    }

    /// daemon 에 구성요소 설치를 시작시키고 완료까지 폴링한다. 성공하면 상태를 재조회해
    /// runtimeSection 의 「설치됨」 이 갱신된다. llama.cpp 빌드는 분 단위로 길 수 있어 종료까지
    /// 무기한 폴링(타임아웃 없음). 다른 대상이 이미 설치 중이면 daemon 이 409 — 합류해 폴링만 한다.
    @MainActor
    private func runInstall(component: String) async {
        let targetId = "local_llm/\(component)"
        actionError = nil
        do {
            installProgress = try await DaemonAPI.installLocalLlmComponent(component)
        } catch {
            // 시작 자체 실패 — 막다른 길 대신 실패 상태로 폴백 표시.
            installProgress = DaemonAPI.AgentInstallProgress(
                adapterId: targetId,
                state: "error",
                command: nil,
                log: (error as? LocalizedError)?.errorDescription ?? "\(error)",
                exitCode: nil,
                error: "spawn_failed",
                installed: false,
                startedAt: nil
            )
            return
        }
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if Task.isCancelled { break }
            guard let p = try? await DaemonAPI.agentInstallStatus() else { continue }
            // 다른 대상이 설치 중인 스냅샷이면 이 행과 무관 — 무시.
            guard p.adapterId == targetId else { continue }
            installProgress = p
            if p.state != "installing" {
                if p.state == "done" { await loadAll() }   // 「설치됨」 갱신
                break
            }
        }
    }
}

// MARK: - 디자인 탭 (design_directive 부트스트랩 / 검토 / 승인)

/// 「디자인」 탭 — design_directive 가 NULL 이면 PO 수집/리서치/워크플로우가 매번 디자인 규칙을 새로
/// 탐색하는 «약한 신호» 로 떨어진다. 손으로 규칙을 쓰는 건 채택 장벽이라, 디자이너 에이전트가 레포의
/// 디자인 SSOT(토큰/테마·i18n 카탈로그·디자인 문서)를 읽어 directive 초안을 제안하고, 사람이 여기서
/// «승인 한 번» 으로 «선언된 강신호» 를 켠다 (승인 전엔 절대 적용 안 됨). design_directive 는 repo
/// 별이라 먼저 레포를 고른다(최근 프로젝트 픽커 + 직접 입력). reloadToken 이 바뀌면 다시 읽는다.
private struct DesignSettingsView: View {
    let reloadToken: UUID

    @State private var recents: [DaemonAPI.RecentProject] = []
    /// 현재 선택된 레포 (디자인 상태의 키). 빈 문자열 = 미선택.
    @State private var repoPath: String = ""
    @State private var customPath: String = ""

    @State private var designDirective: String?
    @State private var designDraft: String?
    @State private var draftEdit: String = ""
    /// non-nil = 초안 «생성 중» (부트스트랩 세션 진행). 폴링이 이걸 보고 멈춘다.
    @State private var generatingSession: String?

    @State private var loadingRepos = true
    @State private var busy = false
    @State private var statusText: String?
    @State private var statusIsError = false
    @State private var pollTask: Task<Void, Never>?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                repoPicker
                if !repoPath.isEmpty {
                    stateBlock
                }
                if let statusText {
                    Text(statusText)
                        .font(.callout)
                        .foregroundStyle(statusIsError ? Color.red : Color.green)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
            }
            .padding(20)
        }
        .frame(minWidth: 520, minHeight: 560)
        .onAppear { Task { await loadRepos() } }
        .onChange(of: reloadToken) { _ in Task { await loadRepos() } }
        .onDisappear {
            pollTask?.cancel()
            pollTask = nil
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "paintpalette")
                .font(.largeTitle)
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 4) {
                Text("디자인 규칙 선언")
                    .font(.title2.weight(.semibold))
                Text("손으로 규칙을 쓰지 않아도 돼요 — 에이전트가 이 레포의 디자인 토큰·i18n 카탈로그·디자인 문서를 읽어 규칙 초안을 제안해요. 승인하면 PO 수집·리서치가 따르는 «강한 신호» 가 켜집니다 (승인 전엔 적용 안 됨).")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
    }

    private var repoPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("레포 선택")
                .font(.headline)
            if loadingRepos {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("불러오는 중…").font(.callout).foregroundStyle(.secondary)
                }
            } else if !recents.isEmpty {
                Picker("최근 프로젝트", selection: repoBinding) {
                    Text("레포를 고르세요").tag("")
                    ForEach(recents) { p in
                        Text(verbatim: (p.path as NSString).lastPathComponent).tag(p.path)
                    }
                }
                .labelsHidden()
            }
            HStack(spacing: 8) {
                TextField("/path/to/repo", text: $customPath)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
                    .disableAutocorrection(true)
                Button("이 레포 사용") {
                    selectRepo(customPath.trimmingCharacters(in: .whitespaces))
                }
                .disabled(customPath.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if !repoPath.isEmpty {
                Text(verbatim: repoPath)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var repoBinding: Binding<String> {
        Binding(get: { repoPath }, set: { selectRepo($0) })
    }

    @ViewBuilder private var stateBlock: some View {
        VStack(alignment: .leading, spacing: 12) {
            if generatingSession != nil {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("디자인 규칙을 읽는 중…").font(.callout).foregroundStyle(.secondary)
                }
                Text("에이전트가 이 레포의 색·간격·금지 패턴·지원 언어를 읽어 초안을 만들고 있어요.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if designDraft != nil {
                Text("검토 대기 초안").font(.headline)
                Text("검토하고 필요하면 고친 뒤 «승인» 하면 수집·리서치가 이 규칙을 강한 신호로 따라요. 승인 전엔 적용되지 않아요.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                // 초안 본문은 에이전트 산출(레포 고유 규칙)이라 번역 대상 아님 — verbatim 편집.
                TextEditor(text: $draftEdit)
                    .font(.callout.monospaced())
                    .frame(minHeight: 220)
                    .padding(6)
                    .background(Color.secondary.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .disabled(busy)
                HStack(spacing: 10) {
                    Button {
                        Task { await approve() }
                    } label: {
                        Label("승인하고 켜기", systemImage: "checkmark.circle")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || draftEdit.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button(role: .destructive) {
                        Task { await discard() }
                    } label: {
                        Label("버리기", systemImage: "trash")
                    }
                    .disabled(busy)
                    Spacer()
                    if busy { ProgressView().controlSize(.small) }
                }
            } else if let declared = designDirective {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.seal.fill").foregroundStyle(.green)
                    Text("디자인 규칙이 선언됐어요").font(.headline)
                }
                Text("승인된 규칙을 강한 신호로 쓰고 있어요. 규칙이 바뀌었으면 초안을 다시 만들어 갱신하세요.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                ScrollView {
                    Text(verbatim: declared)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 180)
                Button {
                    Task { await generate() }
                } label: {
                    if busy {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("초안 다시 만들기", systemImage: "arrow.clockwise")
                    }
                }
                .disabled(busy)
            } else {
                Text("아직 선언된 디자인 규칙이 없어요. 지금은 수집·리서치가 매번 디자인 규칙을 새로 탐색하는 «약한 신호» 로 동작해요.")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    Task { await generate() }
                } label: {
                    if busy {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("디자인 초안 만들기", systemImage: "wand.and.stars")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - 동작

    @MainActor
    private func loadRepos() async {
        loadingRepos = true
        defer { loadingRepos = false }
        recents = (try? await DaemonAPI.recentProjects()) ?? []
    }

    /// 레포 선택 — 폴링을 멈추고 상태를 초기화한 뒤 그 레포의 디자인 상태를 읽는다.
    private func selectRepo(_ path: String) {
        pollTask?.cancel()
        pollTask = nil
        statusText = nil
        repoPath = path
        designDirective = nil
        designDraft = nil
        draftEdit = ""
        generatingSession = nil
        guard !path.isEmpty else { return }
        Task { await loadState() }
    }

    @MainActor
    private func loadState() async {
        guard !repoPath.isEmpty else { return }
        do {
            let s = try await DaemonAPI.getPoDesignState(repoPath: repoPath)
            applyState(s)
            startPollIfGenerating()
        } catch {
            statusText = String(localized: "디자인 상태를 불러오지 못했어요 — daemon 이 실행 중인지 확인하세요")
            statusIsError = true
        }
    }

    private func applyState(_ s: DaemonAPI.PoDesignState) {
        designDirective = s.designDirective
        generatingSession = s.designDirectiveDraftSessionId
        if s.designDirectiveDraft != designDraft {
            designDraft = s.designDirectiveDraft
            draftEdit = s.designDirectiveDraft ?? ""
        }
    }

    /// «생성 중» 이면 끝날 때까지 ~2s 폴링 — 초안이 도착하면 검토 UI 로 전환된다.
    private func startPollIfGenerating() {
        guard generatingSession != nil, pollTask == nil else { return }
        let repo = repoPath
        pollTask = Task { @MainActor in
            defer { pollTask = nil }
            while !Task.isCancelled, generatingSession != nil, repo == repoPath {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if Task.isCancelled { return }
                guard repo == repoPath else { return }
                guard let s = try? await DaemonAPI.getPoDesignState(repoPath: repo) else { continue }
                applyState(s)
            }
        }
    }

    private func generate() async {
        busy = true
        defer { busy = false }
        statusText = nil
        do {
            try await DaemonAPI.bootstrapPoDesignDirective(repoPath: repoPath)
            // 생성 시작 — 상태를 다시 읽어 «생성 중» 으로 전환 + 폴링 시작.
            await loadState()
        } catch {
            statusText = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            statusIsError = true
        }
    }

    private func approve() async {
        let edited = draftEdit.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !edited.isEmpty else { return }
        busy = true
        defer { busy = false }
        do {
            try await DaemonAPI.approvePoDesignDirective(repoPath: repoPath, directive: edited)
            designDirective = edited
            designDraft = nil
            draftEdit = ""
            statusText = String(localized: "승인했어요 — 이제 수집·리서치가 이 규칙을 강한 신호로 따라요")
            statusIsError = false
        } catch {
            statusText = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            statusIsError = true
        }
    }

    private func discard() async {
        busy = true
        defer { busy = false }
        do {
            try await DaemonAPI.discardPoDesignDraft(repoPath: repoPath)
            designDraft = nil
            draftEdit = ""
            statusText = nil
        } catch {
            statusText = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            statusIsError = true
        }
    }
}
