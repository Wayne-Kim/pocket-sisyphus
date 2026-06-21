import SwiftUI
import AppKit

/// 「Discord 알림 설정」 — 통합 설정 창(SettingsWindow)의 «알림» 탭으로 임베드된다.
/// (옛 단독 DiscordSettingsWindowController 는 제거되고 SettingsWindowController 로 통합.)
/// reloadToken 이 바뀌면(설정 창 재오픈) 서버 설정을 다시 읽는다.
struct DiscordSettingsView: View {
    /// 설정 창이 다시 열릴 때 bump 되는 토큰 — 바뀌면 서버 설정 재로드.
    let reloadToken: UUID

    // Discord 공식 «Intro to Webhooks» 가이드 (article 228383668) — 채널 설정에서 웹후크 만드는 전 과정.
    // 앱 언어에 맞는 Discord 도움말 로케일로 연다. slug 없이 article id 만 줘도 Zendesk 가 알아서
    // 해당 로케일 페이지로 리다이렉트하고, Discord help center 미지원 언어(ar·hi 등)는 en-us 로 폴백.
    private var webhookHelpURL: URL {
        let discordLocale: String
        switch Locale.current.language.languageCode?.identifier {
        case "ko": discordLocale = "ko"
        case "ja": discordLocale = "ja"
        case "fr": discordLocale = "fr"
        case "ru": discordLocale = "ru"
        case "es": discordLocale = "es"
        case "pt": discordLocale = "pt-br"
        case "zh": discordLocale = "zh-cn"
        default:   discordLocale = "en-us"
        }
        return URL(string: "https://support.discord.com/hc/\(discordLocale)/articles/228383668")!
    }

    @State private var webhookURL = ""
    @State private var enabled = true
    @State private var evTurnComplete = true
    @State private var evSessionExit = true
    @State private var evError = true

    // «Open in app» 딥링크 브리지 페이지 — 빈값이면 기본 페이지(개발자 GitHub Pages).
    // 사용자가 자기 GitHub Pages 등에 직접 호스팅한 브리지 페이지로 바꿀 수 있다.
    @State private var deepLinkBaseUrl = ""
    /// daemon 이 알려주는 기본 브리지 URL — placeholder 표시용. 응답에 없으면 이 fallback.
    @State private var deepLinkDefaultBase = "https://pocketsisyphus.app/open"

    // 직접 호스팅용 브리지 페이지 소스 (공개 레포 web/public/open/index.html) — 복사해 쓰면 된다.
    private let bridgeSourceURL =
        URL(string: "https://github.com/Wayne-Kim/pocket-sisyphus/blob/main/web/public/open/index.html")!

    // 서버에서 읽은 현재 상태 (redact 된 미리보기).
    @State private var configuredPreview: String?
    @State private var isConfigured = false

    @State private var isWorking = false
    @State private var statusText: String?
    @State private var statusIsError = false

    /// 딥링크 브리지 도달 가능성 점검 상태 — «죽은 주소» 경고를 띄울지 판단.
    private enum DeepLinkHealthState: Equatable {
        case idle          // 아직 검사 안 함 (또는 알림 꺼짐)
        case checking      // 검사 중 (로딩)
        case ok            // 정상 — 경고 없음
        case warning       // 응답 없음/오류 — 경고 (도메인 사망 또는 4xx/5xx)
        case inconclusive  // 오프라인/판단 불가 — 거짓 경고 방지로 경고 안 함(중립 안내만)
    }
    @State private var deepLinkHealth: DeepLinkHealthState = .idle
    @State private var deepLinkHealthTask: Task<Void, Never>?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                statusBlock
                guideBox
                form
                actions
                if let statusText {
                    Text(statusText)
                        .font(.callout)
                        .foregroundStyle(statusIsError ? Color.red : Color.green)
                        .fixedSize(horizontal: false, vertical: true)
                }
                securityNote
            }
            .padding(20)
        }
        .frame(minWidth: 520, minHeight: 560)
        .onAppear { load() }
        .onChange(of: reloadToken) { _ in load() }
        .onChange(of: enabled) { _ in checkDeepLinkHealth() }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "bell.badge")
                .font(.largeTitle)
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 4) {
                Text("Discord 알림 설정")
                    .font(.title2.weight(.semibold))
                Text("맥에서 작업이 끝나거나 입력이 필요할 때 Discord 로 알려드려요.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Text("외부 서버 없이, 당신의 Discord 웹후크로 직접 보냅니다.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
        }
    }

    @ViewBuilder
    private var statusBlock: some View {
        HStack(spacing: 8) {
            Image(systemName: isConfigured && enabled ? "checkmark.circle.fill" : "circle.dashed")
                .foregroundStyle(isConfigured && enabled ? Color.green : Color.secondary)
            if isConfigured {
                if let preview = configuredPreview {
                    Text("현재 설정됨: \(preview)")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                } else {
                    Text("현재 설정됨")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("아직 설정되지 않았어요")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(10)
        .background(Color.secondary.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private var guideBox: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("설정 방법")
                .font(.headline)
            step(1, "Discord 에서 알림 받을 채널 옆 ⚙︎(편집) → 「연동」 → 「웹후크」 → 「새 웹후크」")
            step(2, "「웹후크 URL 복사」를 누르세요")
            step(3, "아래 칸에 붙여넣고 「저장」 → 「테스트」 로 확인하세요")
            Link(destination: webhookHelpURL) {
                Label("Discord 웹후크 만드는 법 (공식 가이드)", systemImage: "arrow.up.right.square")
                    .font(.callout)
            }
            .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.accentColor.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func step(_ n: Int, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("\(n)")
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(.white)  // design-lint: allow — accent 배경 위 단계 번호, Mac 은 onAccent 토큰 부재라 흰색 고정 정상
                .frame(width: 18, height: 18)
                .background(Circle().fill(Color.accentColor))
            Text(text)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Webhook URL")
                    .font(.subheadline.weight(.medium))
                TextField("https://discord.com/api/webhooks/…", text: $webhookURL)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
                    .disableAutocorrection(true)
            }

            Toggle(isOn: $enabled) {
                Text("알림 켜기")
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("알림 이벤트")
                    .font(.subheadline.weight(.medium))
                Toggle(isOn: $evTurnComplete) { Text("작업 완료 · 입력 대기") }
                Toggle(isOn: $evSessionExit) { Text("세션 종료") }
                Toggle(isOn: $evError) { Text("에러") }
            }
            .disabled(!enabled)
            .opacity(enabled ? 1 : 0.5)

            deepLinkSection
        }
    }

    /// «Open in app» 딥링크가 거치는 브리지 페이지 주소 — 고급 설정. 비워두면 기본 페이지.
    private var deepLinkSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("딥링크 페이지 주소 (고급)")
                .font(.subheadline.weight(.medium))
            TextField(deepLinkDefaultBase, text: $deepLinkBaseUrl)
                .textFieldStyle(.roundedBorder)
                .font(.body.monospaced())
                .disableAutocorrection(true)
            Text("알림의 「Open in app」 링크가 이 페이지를 거쳐 앱으로 연결돼요. 자신의 GitHub Pages 등에 직접 호스팅한 페이지 주소로 바꿀 수 있어요. 비워두면 기본 페이지를 사용해요.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            deepLinkHealthNotice
            Link(destination: bridgeSourceURL) {
                Label("브리지 페이지 소스 보기 (직접 호스팅용)", systemImage: "arrow.up.right.square")
                    .font(.caption)
            }
        }
    }

    /// 딥링크 브리지 도달 가능성 상태 표시 — 검사 중(로딩)·정상(무표시)·실패(노랑 경고)·
    /// 네트워크 불가(중립 안내)를 일관되게 구분한다. 색은 의미 토큰(Theme.warning)을 쓰고,
    /// 본문은 적응색(.primary/.secondary). 경고가 아닌 상태는 거짓 경고를 피하려 노랑을 안 쓴다.
    @ViewBuilder
    private var deepLinkHealthNotice: some View {
        switch deepLinkHealth {
        case .idle, .ok:
            EmptyView()
        case .checking:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("딥링크 주소가 동작하는지 확인 중…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
        case .inconclusive:
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "wifi.slash")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                Text("지금은 딥링크 주소가 동작하는지 확인할 수 없어요 — 네트워크 연결을 확인해 주세요.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(Text("딥링크 주소의 도달 여부를 지금은 확인할 수 없어요"))
        case .warning:
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.warning)
                    .accessibilityHidden(true)
                Text("이 딥링크 주소가 응답하지 않아요 — 알림의 「Open in app」 링크가 동작하지 않을 수 있어요. 주소를 확인하거나 칸을 비워 기본 페이지로 되돌리세요.")
                    .font(.caption)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(10)
            .background(Theme.warning.opacity(0.12))  // design-lint: allow — warning 틴트 채움(.12), Mac 은 Theme.Opacity 토큰 부재라 리터럴 정상(파일 내 기존 패턴과 동일)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .accessibilityElement(children: .combine)
            .accessibilityLabel(Text("경고: 딥링크 주소가 응답하지 않아 「Open in app」 링크가 동작하지 않을 수 있어요"))
        }
    }

    private var actions: some View {
        HStack(spacing: 10) {
            Button {
                Task { await save() }
            } label: {
                Label("저장", systemImage: "tray.and.arrow.down")
            }
            .keyboardShortcut("s")
            .disabled(isWorking)

            Button {
                Task { await test() }
            } label: {
                Label("테스트 알림 보내기", systemImage: "paperplane")
            }
            .disabled(isWorking)

            if isConfigured {
                Button(role: .destructive) {
                    Task { await clear() }
                } label: {
                    Label("설정 해제", systemImage: "trash")
                }
                .disabled(isWorking)
            }

            Spacer()
            if isWorking {
                ProgressView().controlSize(.small)
            }
        }
    }

    private var securityNote: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "lock.fill")
                .foregroundStyle(.secondary)
            Text("webhook URL 은 비밀이에요 — config.json(0600)에만 저장되고, 화면엔 가려서 보여줍니다.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 4)
    }

    // MARK: - Actions

    private func load() {
        statusText = nil
        Task {
            do {
                let cfg = try await DaemonAPI.getNotifyConfig().discord
                isConfigured = cfg.configured
                configuredPreview = cfg.webhookUrlPreview
                enabled = cfg.enabled || !cfg.configured  // 미설정이면 기본 켜짐 상태로 보여줌
                evTurnComplete = cfg.events.turnComplete
                evSessionExit = cfg.events.sessionExit
                evError = cfg.events.error
                deepLinkBaseUrl = cfg.deepLinkBaseUrl ?? ""  // 비밀 아님 — 평문 복원
                if let def = cfg.deepLinkBaseUrlDefault { deepLinkDefaultBase = def }
                // 설정 화면 진입 시 딥링크 브리지 도달 가능성을 비차단으로 점검 (수용 기준).
                checkDeepLinkHealth()
            } catch {
                // daemon 미실행이 가장 흔한 케이스 — 가이드는 그대로 보이게 두고 안내만.
                setStatus(String(localized: "daemon 이 실행 중인지 확인하세요 (메뉴바 → 시작)"), isError: true)
            }
        }
    }

    private func save() async {
        // 입력칸이 비어 있어도 이미 설정돼 있으면 기존 URL 을 유지한 채 나머지만 저장 —
        // 평문 URL 은 저장 후 화면에 안 남기므로 재입력을 강요하지 않는다.
        let trimmedURL = webhookURL.trimmingCharacters(in: .whitespaces)
        let urlUpdate: DaemonAPI.WebhookURLUpdate
        if !trimmedURL.isEmpty {
            urlUpdate = .set(trimmedURL)
        } else if isConfigured {
            urlUpdate = .keep
        } else {
            setStatus(String(localized: "Webhook URL 을 입력하세요"), isError: true)
            return
        }
        isWorking = true
        defer { isWorking = false }
        do {
            try await DaemonAPI.setDiscordWebhook(
                url: urlUpdate,
                enabled: enabled,
                turnComplete: evTurnComplete,
                sessionExit: evSessionExit,
                error: evError,
                deepLinkBaseUrl: deepLinkBaseUrl.trimmingCharacters(in: .whitespaces)
            )
            setStatus(String(localized: "저장됐어요"), isError: false)
            // 저장 후 redact 미리보기 갱신 + 입력칸 비움 (평문 URL 화면에 안 남김).
            webhookURL = ""
            load()
        } catch {
            setStatus((error as? LocalizedError)?.errorDescription ?? "\(error)", isError: true)
        }
    }

    private func test() async {
        isWorking = true
        defer { isWorking = false }
        // 테스트 알림 시 딥링크 브리지 도달 가능성도 비차단으로 점검 (수용 기준). 점검은
        // 백그라운드라 테스트 발송 자체를 지연시키지 않는다.
        checkDeepLinkHealth()
        // 입력칸에 URL 이 있으면 저장 전 그 값으로 테스트, 없으면 저장된 설정으로.
        let trimmed = webhookURL.trimmingCharacters(in: .whitespaces)
        let trimmedBase = deepLinkBaseUrl.trimmingCharacters(in: .whitespaces)
        do {
            try await DaemonAPI.testDiscord(
                url: trimmed.isEmpty ? nil : trimmed,
                deepLinkBaseUrl: trimmedBase.isEmpty ? nil : trimmedBase
            )
            setStatus(String(localized: "테스트 알림을 보냈어요 — Discord 를 확인하세요"), isError: false)
        } catch {
            setStatus((error as? LocalizedError)?.errorDescription ?? "\(error)", isError: true)
        }
    }

    private func clear() async {
        isWorking = true
        defer { isWorking = false }
        do {
            try await DaemonAPI.setDiscordWebhook(
                url: .clear, enabled: false,
                turnComplete: evTurnComplete, sessionExit: evSessionExit, error: evError,
                deepLinkBaseUrl: ""
            )
            webhookURL = ""
            deepLinkBaseUrl = ""
            setStatus(String(localized: "설정을 해제했어요"), isError: false)
            load()
        } catch {
            setStatus((error as? LocalizedError)?.errorDescription ?? "\(error)", isError: true)
        }
    }

    private func setStatus(_ text: String, isError: Bool) {
        statusText = text
        statusIsError = isError
    }

    /// 딥링크 브리지 도달 가능성을 «비차단»으로 점검한다 — 알림 발송과 무관한 백그라운드 Task.
    /// 알림이 꺼져 있으면 검사·경고를 생략한다. 입력칸 값이 있으면(저장 전) 그 값을, 없으면
    /// 저장된 설정/기본 페이지를 점검한다. 점검 실패(daemon 미실행 등)는 거짓 경고를 피해
    /// inconclusive 로 처리한다.
    private func checkDeepLinkHealth() {
        deepLinkHealthTask?.cancel()
        guard enabled else {
            deepLinkHealth = .idle
            return
        }
        let base = deepLinkBaseUrl.trimmingCharacters(in: .whitespaces)
        deepLinkHealth = .checking
        deepLinkHealthTask = Task {
            do {
                let result = try await DaemonAPI.checkDeepLinkHealth(base: base.isEmpty ? nil : base)
                if Task.isCancelled { return }
                switch result.status {
                case "ok": deepLinkHealth = .ok
                case "unreachable", "http_error": deepLinkHealth = .warning
                default: deepLinkHealth = .inconclusive  // "inconclusive" / 미지의 값
                }
            } catch {
                if Task.isCancelled { return }
                deepLinkHealth = .inconclusive
            }
        }
    }
}
