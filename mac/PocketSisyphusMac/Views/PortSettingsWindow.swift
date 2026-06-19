import SwiftUI
import AppKit

/// 「포트 설정」 — 통합 설정 창(SettingsWindow)의 «포트» 탭으로 임베드된다.
/// (옛 단독 PortSettingsWindowController 는 제거되고 SettingsWindowController 로 통합.)
///
/// daemon HTTP 가 changing port 위에 있으니 API 대신 config.json 을 직접 읽고 쓴 뒤
/// DaemonManager.restart() 로 적용한다. reloadToken 이 바뀌면(설정 창 재오픈) 현재 포트 재로드.
struct PortSettingsView: View {
    /// 설정 창이 다시 열릴 때 bump 되는 토큰 — 바뀌면 현재 포트 값 재로드.
    let reloadToken: UUID
    let daemon: DaemonManager

    /// 사용자가 지정 가능한 포트 하한 — 0–1023 은 시스템 예약(root 권한 필요)이라 daemon 이
    /// user 권한으로 bind 불가. 상한은 TCP 포트 최대.
    private let minPort = 1024
    private let maxPort = 65535

    @State private var portText = ""
    @State private var currentPort = LocalDaemonClient.defaultDaemonPort
    @State private var sshPortText = ""
    @State private var currentSshPort = LocalDaemonClient.defaultSshPort
    @State private var isWorking = false
    @State private var statusText: String?
    @State private var statusIsError = false
    /// LAN 전용(사설망 직결) 모드 — config.json `lanOnly`. 켜면 daemon 이 `/endpoint` 에서
    /// 공인 IPv4/IPv6·onion 을 빼고 direct_lan 만 광고한다(서버측 fail-closed). 폰 토글과 짝.
    @State private var lanOnly = false
    @State private var lanWorking = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                statusBlock
                lanOnlySection
                guideBox
                form
                actions
                if let statusText {
                    Text(statusText)
                        .font(.callout)
                        .foregroundStyle(statusIsError ? Color.red : Color.green)
                        .fixedSize(horizontal: false, vertical: true)
                }
                fallbackNote
            }
            .padding(20)
        }
        .frame(minWidth: 480, minHeight: 460)
        .onAppear { load() }
        .onChange(of: reloadToken) { _ in load() }
    }

    /// LAN 전용(사설망 직결) 모드 토글 + «외부 차단» 상태 표시. 토글 색은 AccentColor(보라)가
    /// 자동으로 잡으므로 칠하지 않는다. 켜지면 외부 경로를 광고하지 않는 «차단» 상태라 danger(빨강)
    /// 아이콘으로 의미를 신호하고, 본문은 .secondary 로 두 테마 대비를 맞춘다.
    private var lanOnlySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: Binding(
                get: { lanOnly },
                set: { newValue in Task { await saveLanOnly(newValue) } }
            )) {
                Label("LAN 전용 모드 (사설망 직결)", systemImage: "house.lock")
            }
            .disabled(lanWorking)
            if lanOnly {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "shield.lefthalf.filled")
                        .foregroundStyle(Color.red)
                    Text("외부(공인 IP·Tor onion) 경로를 광고하지 않아요. 같은 Wi‑Fi 의 폰만 사설 주소로 직접 연결돼요.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text("기본 모드 — 폰이 같은 LAN 의 사설 주소를 우선 쓰되, 닿지 않으면 공인 IP·Tor onion 으로 폴백해요.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if lanWorking {
                ProgressView().controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.secondary.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "network")
                .font(.largeTitle)
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 4) {
                Text("포트 설정")
                    .font(.title2.weight(.semibold))
                Text("맥 데몬이 내부 통신에 쓰는 포트예요. 이미 다른 프로그램이 쓰고 있으면 여기서 바꿀 수 있어요.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
    }

    private var statusBlock: some View {
        HStack(spacing: 8) {
            Image(systemName: "number.circle.fill")
                .foregroundStyle(.secondary)
            Text("현재 데몬 포트 \(currentPort) · SSH 포트 \(currentSshPort)")
                .font(.callout.monospacedDigit())
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(10)
        .background(Color.secondary.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private var guideBox: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("포트가 뭔지 잘 모르겠다면")
                .font(.headline)
            Text("• 포트는 0–65535 사이의 숫자예요.")
            Text("• 0–1023 은 시스템 예약이라 쓸 수 없어요.")
            Text("• 추천: 49152–65535 (다른 프로그램과 거의 안 겹쳐요).")
            Text("• 데몬 포트(기본 7777)는 충돌이 나면 앱이 알아서 빈 포트를 찾아 써요.")
            Text("• SSH 포트(기본 22022)는 폰 접속용이라 자동으로 안 바꿔요 — 겹치면 직접 다른 값으로 바꿔주세요.")
        }
        .font(.callout)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.accentColor.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("데몬 포트 (내부용)")
                    .font(.subheadline.weight(.medium))
                HStack(spacing: 8) {
                    TextField("7777", text: $portText)
                        .textFieldStyle(.roundedBorder)
                        .font(.body.monospacedDigit())
                        .frame(width: 140)
                        .disableAutocorrection(true)
                    Text("(\(minPort)–\(maxPort))")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
                Text("맥 안에서만 쓰는 포트. 충돌하면 자동으로 빈 포트를 찾아 써요.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("SSH 포트 (외부 접속용)")
                    .font(.subheadline.weight(.medium))
                HStack(spacing: 8) {
                    TextField("22022", text: $sshPortText)
                        .textFieldStyle(.roundedBorder)
                        .font(.body.monospacedDigit())
                        .frame(width: 140)
                        .disableAutocorrection(true)
                    Text("(\(minPort)–\(maxPort))")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
                Text("폰이 맥에 붙을 때 쓰는 포트. 잘 모르겠으면 그대로 두세요.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var actions: some View {
        HStack(spacing: 10) {
            Button {
                Task { await save() }
            } label: {
                Label("저장하고 데몬 재시작", systemImage: "tray.and.arrow.down")
            }
            .keyboardShortcut("s")
            .disabled(isWorking)

            Button {
                portText = "\(LocalDaemonClient.defaultDaemonPort)"
                sshPortText = "\(LocalDaemonClient.defaultSshPort)"
            } label: {
                Label("기본값으로 되돌리기", systemImage: "arrow.uturn.backward")
            }
            .disabled(isWorking)

            Spacer()
            if isWorking {
                ProgressView().controlSize(.small)
            }
        }
    }

    private var fallbackNote: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "wand.and.stars")
                .foregroundStyle(.secondary)
            Text("충돌이 나도 앱이 자동으로 빈 포트를 찾아 띄우니, 잘 모르겠으면 기본값을 그대로 두세요.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 4)
    }

    // MARK: - Actions

    private func load() {
        statusText = nil
        currentPort = LocalDaemonClient.configuredPort()
        portText = "\(currentPort)"
        currentSshPort = LocalDaemonClient.configuredSshPort()
        sshPortText = "\(currentSshPort)"
        lanOnly = LocalDaemonClient.configuredLanOnly()
    }

    /// LAN 전용 토글 변경 — config.json 에 쓰고 daemon 을 재시작해 `/endpoint` 광고에 반영.
    /// 실패(config.json 없음)면 토글 상태를 되돌린다.
    private func saveLanOnly(_ enabled: Bool) async {
        lanWorking = true
        defer { lanWorking = false }
        do {
            try LocalDaemonClient.setConfiguredLanOnly(enabled)
            lanOnly = enabled
            setStatus(enabled
                ? String(localized: "LAN 전용 모드를 켰어요 — 외부 경로 광고를 끄고 데몬을 재시작했어요")
                : String(localized: "LAN 전용 모드를 껐어요 — 공인 IP·Tor 폴백을 다시 광고하고 데몬을 재시작했어요"),
                isError: false)
            daemon.restart()
        } catch {
            // 되돌리기 — 쓰기 실패면 토글이 잘못된 상태로 남지 않게.
            lanOnly = LocalDaemonClient.configuredLanOnly()
            setStatus(String(localized: "config.json 을 찾지 못했어요 — 메뉴바에서 데몬을 먼저 시작하세요"), isError: true)
        }
    }

    private func save() async {
        let trimmedDaemon = portText.trimmingCharacters(in: .whitespaces)
        let trimmedSsh = sshPortText.trimmingCharacters(in: .whitespaces)
        guard let dp = Int(trimmedDaemon), dp >= minPort, dp <= maxPort,
              let sp = Int(trimmedSsh), sp >= minPort, sp <= maxPort
        else {
            setStatus(String(localized: "1024–65535 사이의 숫자를 입력하세요 (데몬·SSH 둘 다)"), isError: true)
            return
        }
        guard dp != sp else {
            setStatus(String(localized: "데몬 포트와 SSH 포트는 서로 달라야 해요"), isError: true)
            return
        }
        isWorking = true
        defer { isWorking = false }
        do {
            try LocalDaemonClient.setConfiguredPort(dp)
            try LocalDaemonClient.setConfiguredSshPort(sp)
            currentPort = dp
            currentSshPort = sp
            setStatus(String(localized: "포트를 저장하고 데몬을 재시작했어요 (데몬 \(dp) · SSH \(sp))"), isError: false)
            // config.json 의 새 포트를 daemon 이 읽도록 재시작. reclaim + 데몬포트 자동 폴백이 충돌을 흡수.
            daemon.restart()
        } catch {
            setStatus(String(localized: "config.json 을 찾지 못했어요 — 메뉴바에서 데몬을 먼저 시작하세요"), isError: true)
        }
    }

    private func setStatus(_ text: String, isError: Bool) {
        statusText = text
        statusIsError = isError
    }
}
