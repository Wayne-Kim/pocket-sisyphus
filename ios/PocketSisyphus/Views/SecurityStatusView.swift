import SwiftUI

/// 설정 → 「보안 상태」. 분산돼 있던 보안 신호를 «한 패널» 에 읽기 전용으로 모아, 사용자가
/// «지금 얼마나 안전한지» 를 직접 확인하게 한다. 신규 보안 메커니즘이 아니라 기존 방어
/// (기기 인증·듀얼 채널·host key TOFU+핀)의 «표면화» 다 — raw TOFU 인 경쟁 제품과의 차별점.
///
/// ## 한 패널에 모으는 4가지
///   1. **기기 인증** — Secure Enclave 키 등록됨(hard) vs soft 모드 + 생체 종류(Face/Touch/Optic ID).
///      출처: `AttestSession.shared.enrollment` · `DeviceAttestor`.
///   2. **현재 채널** — 직접(IPv6/IPv4) vs onion. onion 은 주소 자체가 공개키 hash 라
///      «암호학적 신원 보장» 배지. 출처: `ConnectionManager.currentEndpointType`.
///   3. **호스트 키 검증 등급** — pinned(완전 공개키 핀) / anchor-strict(신뢰 지문) / TOFU(첫 신뢰)
///      + fingerprint. host key 변경(불일치) 감지 시 강조 경고. 출처: `PairConfig` · `ConnectionManager`.
///   4. **등록 기기** — daemon attest 의 등록 기기 + 마지막 접속(lastSeen). 관리(해제·슬롯)는
///      기존 `DevicesView` 로 링크. 출처: `ApiClient.deviceInfo()`.
///
/// 색 정책: «안전/보장» 상태 = success(초록), «더 약한 자세»(soft 모드·순수 TOFU) = warning(노랑·주의),
/// «변조 의심»(host key 불일치) = danger(빨강). 강조는 accent(보라)로 둔다.
struct SecurityStatusView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker

    /// LAN 전용(사설망 직결) 모드 — SettingsSheet 토글과 같은 키. 켜짐/차단 상태를 표면화한다.
    @AppStorage(LanOnlyPolicy.defaultsKey) private var lanOnly: Bool = false

    /// daemon 등록 기기 목록 — DevicesView 와 같은 라우트. nil = 아직 로드 전.
    @State private var deviceInfo: ApiClient.DeviceInfoResponse?
    @State private var devicesLoading = true
    @State private var devicesError = false
    /// 이 폰의 SE 공개키 지문 — «이 기기» 판정 + 표시용. 시뮬레이터(SE 없음)는 nil.
    @State private var myFingerprint: String?

    var body: some View {
        List {
            if conn.sawHostKeyMismatch {
                hostKeyMismatchBanner
            }
            deviceAuthSection
            channelSection
            lanOnlySection
            hostKeySection
            registeredDevicesSection
        }
        .navigationTitle("보안 상태")
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadDevices() }
        .refreshable { await loadDevices() }
    }

    // MARK: - 1. 기기 인증

    /// SE 키가 daemon 에 등록돼 강제되는 «hard» 모드인지, 아니면 페어링 비밀만으로 접근하는
    /// «soft» 모드인지. AttestSession 이 daemon /attest/status 로 판정한 값을 그대로 읽는다.
    private var deviceAuthSection: some View {
        Section {
            let enrolled = AttestSession.shared.enrollment == .enrolled
            statusRow(
                icon: enrolled ? "checkmark.shield.fill" : "exclamationmark.shield",
                tint: enrolled ? Theme.success : Theme.warning,
                title: enrolled
                    ? Text("기기 인증 켜짐")
                    : Text("기기 인증 꺼짐 (soft 모드)"),
                detail: enrolled
                    ? Text("이 Mac은 등록된 기기의 Secure Enclave 키 서명만 받아들여요.")
                    : Text("아직 하드웨어 기기 인증이 설정되지 않아, 페어링 정보를 가진 기기가 접근할 수 있어요."))

            if DeviceAttestor.isAvailable {
                infoRow(label: Text("생체 인증"), value: DeviceAttestor.biometryDisplayName)
            } else {
                infoRow(label: Text("생체 인증"), value: String(localized: "이 기기에서 사용 불가"))
            }

            if let fp = myFingerprint {
                fingerprintRow(label: Text("이 기기 키 지문"), value: fp)
            }
        } header: {
            Text("기기 인증")
        } footer: {
            Text("기기 인증은 폰의 Secure Enclave에 묶인 추출 불가능한 키로, 매번 생체 인증으로 서명을 게이팅합니다. 페어링 QR이 유출돼도 이 기기 없이는 접근할 수 없어요.")
        }
    }

    // MARK: - 2. 현재 채널

    /// 지금 데이터가 흐르는 채널 — 직접(IPv6/IPv4) vs onion. onion 주소는 공개키 hash 라
    /// 신원이 암호학적으로 보장된다.
    private var channelSection: some View {
        Section {
            let type = conn.currentEndpointType
            statusRow(
                icon: channelIcon(type),
                tint: type == .torOnion ? Theme.success : Theme.accent,
                title: Text(verbatim: channelTitle(type)),
                detail: type == .torOnion
                    ? Text("onion 주소가 곧 서버의 공개키라, 연결 상대가 진짜 이 Mac임이 암호학적으로 보장돼요.")
                    : Text("같은 네트워크 안 직접 연결이에요. 서버 신원은 아래 호스트 키 검증으로 확인합니다."))

            if type == .torOnion {
                badgeRow(text: Text("암호학적 신원 보장"), tint: Theme.success, icon: "lock.shield.fill")
            }

            if let r = conn.lastRTTms {
                infoRow(label: Text("응답 시간"), value: "\(r) ms")
            }
        } header: {
            Text("현재 채널")
        }
    }

    // MARK: - 2.5 LAN 전용 모드

    /// LAN 전용(사설망 직결) 모드의 상태 — 켜짐/꺼짐 + «외부 차단됨/오프-LAN» 인지.
    /// 모드가 꺼져 있으면 섹션 자체를 그리지 않는다(평소엔 노이즈).
    @ViewBuilder
    private var lanOnlySection: some View {
        if lanOnly {
            Section {
                // 현재 LAN 채널로 붙었는지(연결됨) vs 오프-LAN 으로 차단됐는지.
                let onLan = conn.currentEndpointType == .directLan
                let blocked: Bool = {
                    if case .failed(let reason, _) = conn.state { return reason == .offLanBlocked }
                    return false
                }()

                if onLan {
                    statusRow(
                        icon: "checkmark.shield.fill",
                        tint: Theme.success,
                        title: Text("LAN 전용 — 사설망 직결됨"),
                        detail: Text("지금 같은 Wi‑Fi 의 사설 주소로만 연결돼 있어요. 패킷이 사설망을 벗어나지 않아요."))
                } else if blocked {
                    statusRow(
                        icon: "wifi.slash",
                        tint: Theme.danger,
                        title: Text("외부 차단됨 — 오프‑LAN"),
                        detail: Text("같은 Wi‑Fi 의 Mac 을 찾지 못했어요. 외부 경로(공인·Tor)로 폴백하지 않고 연결을 차단했어요(fail‑closed)."))
                    badgeRow(text: Text("외부로 폴백하지 않음"), tint: Theme.danger, icon: "lock.fill")
                } else {
                    statusRow(
                        icon: "house.lock",
                        tint: Theme.accent,
                        title: Text("LAN 전용 모드 켜짐"),
                        detail: Text("같은 Wi‑Fi 일 때만 사설 주소로 직접 연결해요. 공인 IP·Tor onion 발견은 건너뜁니다."))
                }
            } header: {
                Text("LAN 전용 모드")
            } footer: {
                Text("켜면 Tor 발견·공인 IPv4/IPv6·onion 폴백을 건너뛰고 거부해요. 외부 네트워크에선 연결되지 않습니다(설정에서 끌 수 있어요).")
            }
        }
    }

    // MARK: - 3. 호스트 키 검증

    /// 직접 SSH 채널의 host key 를 무엇으로 검증하는지 — 핀(완전 공개키) / 신뢰 지문 / 순수 TOFU.
    /// 강한 anchor 일수록 첫 연결의 신뢰 공백이 작다. 변경(불일치) 감지 시 위 배너로 강조.
    private var hostKeySection: some View {
        Section {
            statusRow(
                icon: hostKeyGrade.icon,
                tint: hostKeyGrade.tint,
                title: Text(verbatim: hostKeyGrade.title),
                detail: Text(verbatim: hostKeyGrade.detail))

            if let fp = hostKeyFingerprint, !fp.isEmpty {
                fingerprintRow(label: Text("서버 호스트 키 지문"), value: fp)
            }
        } header: {
            Text("호스트 키 검증")
        } footer: {
            Text("서버의 SSH 호스트 키를 매 연결마다 대조해 중간자(MITM)가 가로채는 가짜 서버를 거부합니다. 호스트 키가 바뀌면 직접 연결을 막고 경고해요.")
        }
    }

    /// host key 불일치(변경) 감지 — onion 으로 안전하게 fallback 했어도 «바뀌었다» 는 사실을
    /// 사용자에게 강조한다. 정상 자세에선 그려지지 않는다.
    private var hostKeyMismatchBanner: some View {
        Section {
            HStack(alignment: .top, spacing: Theme.Spacing.m) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.danger)
                    .font(.title3)
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Text("서버 호스트 키가 바뀌었어요")
                        .font(.subheadline.weight(.semibold))
                    Text("직접 연결에서 서버의 호스트 키가 기록된 값과 달라 연결을 거부했어요. Mac을 재설치했다면 정상일 수 있지만, 그렇지 않다면 서버 위장(중간자 공격)일 수 있어요. Mac 앱이 맞는지 확인하고 의심되면 페어링을 다시 하세요.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.vertical, Theme.Spacing.xs)
        }
    }

    // MARK: - 4. 등록 기기

    /// daemon 에 등록된 기기 + 마지막 접속. 읽기 전용 요약 — 해제·슬롯 관리는 DevicesView 로.
    @ViewBuilder
    private var registeredDevicesSection: some View {
        Section {
            if devicesLoading {
                HStack(spacing: Theme.Spacing.m) {
                    ProgressView().controlSize(.small)
                    Text("불러오는 중…").foregroundStyle(.secondary)
                }
            } else if devicesError {
                Text("기기 목록을 불러오지 못했어요 — Mac 앱이 실행 중인지 확인하세요")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let info = deviceInfo, info.enrolled, !info.devices.isEmpty {
                ForEach(Array(info.devices.enumerated()), id: \.element.id) { idx, device in
                    deviceRow(device, index: idx)
                }
            } else {
                Text("아직 등록된 기기가 없어요.")
                    .foregroundStyle(.secondary)
            }

            NavigationLink {
                DevicesView()
            } label: {
                Label("기기 관리", systemImage: "iphone")
            }
        } header: {
            Text("등록된 기기")
        } footer: {
            Text("이 Mac에 인증된 기기와 마지막 접속 시각이에요. 기기를 해제하거나 추가 기기를 허용하려면 «기기 관리»로 이동하세요.")
        }
    }

    /// 등록 기기 1대 — 「이 기기」 배지 + 마지막 접속.
    private func deviceRow(_ device: ApiClient.DeviceInfoResponse.Device, index: Int) -> some View {
        let current = isCurrent(device)
        return VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack(spacing: Theme.Spacing.s) {
                Image(systemName: "checkmark.seal.fill").foregroundStyle(Theme.success)
                Text("기기 \(index + 1)")
                if current {
                    Text("이 기기")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, Theme.Spacing.s).padding(.vertical, Theme.Spacing.xxs)
                        .background(Theme.accent.opacity(Theme.Opacity.badge))
                        .foregroundStyle(Theme.accent)
                        .clipShape(Capsule())
                }
                Spacer()
            }
            HStack(alignment: .firstTextBaseline) {
                Text("마지막 접속").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text(verbatim: device.lastSeen != nil
                    ? Self.formatDate(device.lastSeen)
                    : String(localized: "이번 부팅 후 기록 없음"))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, Theme.Spacing.xxs)
    }

    // MARK: - 행 빌더

    private func statusRow(icon: String, tint: Color, title: Text, detail: Text) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.m) {
            Image(systemName: icon)
                .foregroundStyle(tint)
                .font(.title3)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                title.font(.subheadline.weight(.semibold))
                detail
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, Theme.Spacing.xxs)
    }

    private func badgeRow(text: Text, tint: Color, icon: String) -> some View {
        HStack(spacing: Theme.Spacing.s) {
            Label { text } icon: { Image(systemName: icon) }
                .font(.caption.weight(.semibold))
                .padding(.horizontal, Theme.Spacing.m).padding(.vertical, Theme.Spacing.xs)
                .background(tint.opacity(Theme.Opacity.badge))
                .foregroundStyle(tint)
                .clipShape(Capsule())
            Spacer()
        }
    }

    private func infoRow(label: Text, value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            label.foregroundStyle(.secondary)
            Spacer()
            Text(verbatim: value)
                .font(.callout.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }

    private func fingerprintRow(label: Text, value: String) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            label.font(.caption).foregroundStyle(.secondary)
            Text(verbatim: value)
                .font(.caption2.monospaced())
                .textSelection(.enabled)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - 채널 표현

    private func channelIcon(_ type: EndpointEntry.EndpointType?) -> String {
        switch type {
        case .torOnion: return "lock.shield.fill"
        case .directLan: return "house.fill"
        case .directIPv6, .directIPv4: return "bolt.horizontal.fill"
        case nil: return "ellipsis"
        }
    }

    private func channelTitle(_ type: EndpointEntry.EndpointType?) -> String {
        switch type {
        case .torOnion: return String(localized: "Tor onion 채널")
        case .directLan: return String(localized: "직접 연결 (LAN 전용)")
        case .directIPv6: return String(localized: "직접 연결 (IPv6)")
        case .directIPv4: return String(localized: "직접 연결 (IPv4)")
        case nil: return String(localized: "연결 중…")
        }
    }

    // MARK: - 호스트 키 검증 등급

    /// 검증 등급 — 강한 anchor 우선. SSHHostKeyTOFU 의 우선순위와 1:1 대응:
    ///   pinned(완전 공개키) > anchor-strict(신뢰 지문) > TOFU(첫 신뢰).
    private enum HostKeyGrade {
        case pinned, anchorStrict, tofu

        var title: String {
            switch self {
            case .pinned:       return String(localized: "핀 고정됨 (가장 강함)")
            case .anchorStrict: return String(localized: "신뢰 지문으로 검증")
            case .tofu:         return String(localized: "첫 신뢰(TOFU)")
            }
        }
        var detail: String {
            switch self {
            case .pinned:
                return String(localized: "페어링 때 받은 서버의 완전한 공개키와 정확히 일치해야 연결돼요.")
            case .anchorStrict:
                return String(localized: "페어링 때 대면으로 받은 호스트 키 지문과 매 연결마다 대조해요. 첫 연결에도 신뢰 공백이 없어요.")
            case .tofu:
                return String(localized: "첫 연결의 호스트 키를 기억하고 이후 대조해요. 첫 연결만큼은 신뢰 공백이 있어요.")
            }
        }
        var tint: Color {
            switch self {
            case .pinned, .anchorStrict: return Theme.success
            case .tofu:                  return Theme.warning
            }
        }
        var icon: String {
            switch self {
            case .pinned:       return "pin.fill"
            case .anchorStrict: return "checkmark.shield.fill"
            case .tofu:         return "shield.lefthalf.filled"
            }
        }
    }

    /// 현재 페어링 anchor 로 등급 판정. sshHostKey(완전 공개키) 가 있으면 pinned,
    /// 없고 지문이 있으면 anchor-strict, 둘 다 없으면 순수 TOFU.
    private var hostKeyGrade: HostKeyGrade {
        guard let cfg = auth.config else { return .tofu }
        if let key = cfg.sshHostKey, !key.isEmpty { return .pinned }
        if !cfg.sshHostKeyFingerprint.isEmpty { return .anchorStrict }
        return .tofu
    }

    /// 표시할 호스트 키 지문 — 페어링 때 받은 expected 지문 ("SHA256:...").
    private var hostKeyFingerprint: String? {
        auth.config?.sshHostKeyFingerprint
    }

    // MARK: - 데이터 로드

    private func isCurrent(_ device: ApiClient.DeviceInfoResponse.Device) -> Bool {
        guard let mine = myFingerprint, let fp = device.attestKeyFingerprint else { return false }
        return mine == fp
    }

    @MainActor
    private func loadDevices() async {
        devicesLoading = true
        devicesError = false
        defer { devicesLoading = false }
        myFingerprint = DeviceAttestor.publicKeyFingerprint()
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            deviceInfo = try await api.deviceInfo()
        } catch {
            if ApiError.isCancellation(error) { return }
            devicesError = true
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
