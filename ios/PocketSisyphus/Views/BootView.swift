import SwiftUI

struct BootView: View {
    @EnvironmentObject var tor: TorManager
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var attest: AttestSession

    /// 연결이 비정상적으로 오래 걸릴 때(아래 task) true. 페어된 기기인데 한참 «연결 준비 중» 에
    /// 머물면, 이미 «다른 기기가 등록됨»(단일 기기 모델)이거나 페어링 값이 바뀐 경우가 많다 —
    /// 그땐 스피너만 돌아 «멈춘 듯» 보이므로, 가능 원인 + 탈출구를 안내한다.
    @State private var stalled = false

    // LockView 와 동일한 생체 표기를 재사용 — 연결 대기 중 «곧 이 인증으로 풀려요» 를 미리
    // 신호할 때 Face ID / Touch ID / Optic ID 를 기기에 맞춰 보여 준다.
    private let bio = DeviceAttestor.biometryDisplayName
    private var bioIcon: String { DeviceAttestor.biometryType == .touchID ? "touchid" : "faceid" }

    /// 페어된 기기이고, 연결이 .running 으로 붙는 즉시 생체 잠금 게이트(LockView)가 뜰 예정인가.
    /// 그때만 BootView 가 «연결되면 곧 Face ID 로 풀려요» 를 미리 신호해, 연결 대기 → LockView
    /// 자동 인증으로 매끄럽게 이어진다(진입 경로의 공백 메우기). 페어 전(Tor 부트스트랩 → PairView)
    /// 이거나 미등록(soft·옛 daemon·시뮬레이터)이면 LockView 가 안 뜨므로 숨긴다 — 안 지킬
    /// 약속을 미리 하지 않는다.
    private var willPromptBiometric: Bool {
        auth.config != nil && attest.needsAuthGate
    }

    /// 진행률 표시 가능한 단계인지 — Tor bootstrap 만 progress 가 있다. SSH 채택은 불확실
    /// (라우터 응답 시간 + libssh2 handshake) 이라 spinner 만.
    private var showsProgress: Bool {
        // 페어 후 SSH 단계로 들어갔으면 progress 숨김.
        if case .connecting = conn.state, case .running = tor.state {
            return false
        }
        return true
    }

    private var progress: Int {
        if case .starting(let p) = tor.state { return p }
        return 0
    }

    /// 단계별 안내. tor + conn 두 상태의 조합으로 phase 를 결정.
    ///
    /// 페어 후 (auth.config != nil, AppRoot 가 BootView 띄움) 의 흐름:
    ///   Tor 부트스트랩 → /endpoint 조회 → SSH happy eyeballs → 채택
    /// 페어 전 (auth.config == nil) 은 단순히 Tor bootstrap progress.
    private var phaseText: String {
        // 페어 후: conn 의 단계 우선.
        if case .connecting = conn.state {
            switch tor.state {
            case .starting:
                return String(localized: "Tor 네트워크 연결 중…")
            case .running:
                // Tor 떴고 endpoint 조회 또는 SSH 시도 단계 — 둘 다 사용자에겐 "SSH 연결" 로 보임.
                return String(localized: "SSH 연결 중…")
            case .idle, .failed:
                return String(localized: "연결 준비 중…")
            }
        }
        // 페어 전 또는 conn 비활성 — 옛 흐름.
        switch tor.state {
        case .idle:
            return String(localized: "연결 준비 중…")
        case .starting(let p):
            if p == 0 {
                return String(localized: "Tor 네트워크 연결 중…")
            }
            if p < 100 {
                return String(localized: "암호화 회로 빌드 중…")
            }
            return String(localized: "데몬과 연결 중…")
        case .running, .failed:
            return ""
        }
    }

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            // 잠금/페이월과 동일하게 «앱 로고» 로 통일 — 연결 스크린에 SF 방패 아이콘 대신.
            Image("AppLogo")
                .resizable()
                .scaledToFit()
                .frame(width: Theme.IconSize.xxxl, height: Theme.IconSize.xxxl)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous))
            Text("Pocket Sisyphus")
                .font(.largeTitle.weight(.semibold))
            // 처음 켠 사용자가 맥락 없는 진행바만 보지 않도록 한 줄 설명. 모든 상태(페어 전/후)
            // 에서 참이라 안전하다 — 이 앱은 폰 단독이 아니라 Mac 컴패니언의 원격 제어다.
            Text("Mac 의 코드 에이전트를 폰에서 원격 제어합니다")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Text(phaseText)
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(minHeight: 22)
                .animation(.easeInOut(duration: 0.2), value: phaseText)

            // 진행률 가능한 단계 (Tor bootstrap) 에서만 progress bar. SSH 단계는 spinner.
            if showsProgress {
                ProgressView(value: Double(progress), total: 100)
                    .progressViewStyle(.linear)
                    .tint(Theme.accent)
                    .frame(maxWidth: 240)
                Text("\(progress)%")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            } else {
                ProgressView()
                    .progressViewStyle(.circular)
                    .tint(Theme.accent)
                    .padding(.top, 4)
            }

            // 연결 직후 생체 잠금이 예정돼 있으면, 대기 중에 «곧 잠금이 풀려요» 를 미리 신호한다.
            // 회로 빌드가 느리거나(5–10s) 늦게 떠도 사용자가 «FaceID 단계에 도달 못 한 채» 종료·
            // 재실행하지 않도록 — 연결되면 AppRoot 가 LockView 로 바꾸고 LockView.task 가 자동
            // 인증을 발사해 추가 탭 없이 프롬프트로 이어진다. 색은 «대기» 라 상태색 차용 금지
            // (warning/pro 안 씀): .secondary 텍스트 + 기본 아이콘만.
            if willPromptBiometric {
                HStack(spacing: 6) {
                    Image(systemName: bioIcon)
                        .accessibilityHidden(true)
                    Text("연결되면 \(bio)로 잠금을 해제해요")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.top, 4)
                .padding(.horizontal, 32)
                .accessibilityElement(children: .combine)
            }

            Spacer()
            // 오래 멈춰 있을 때만, 페어된 기기에 한해 가능 원인 안내(단일 기기 충돌 / stale 페어링).
            // 정상 콜드 부팅의 Tor 빌드(5–30s)에서는 안 뜨도록 충분히 지연된 뒤에만 나타난다.
            if stalled, auth.config != nil {
                Text("연결이 계속 안 되나요? 이미 다른 기기가 연결돼 있거나 페어링 정보가 바뀐 경우일 수 있어요. 아래에서 다시 페어링하거나 Mac 설정 → 「기기」 탭을 확인하세요.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                    .padding(.bottom, 4)
                    .transition(.opacity)
            }
            // 페어링 값이 stale 해 «연결 중» 에서 영영 못 빠져나오는 경우의 탈출구.
            // 페어된 상태(auth.config != nil)에서만 스스로 나타난다 — 페어 전 Tor
            // 부트스트랩 단계에서는 비울 페어링이 없어 숨겨진다.
            RePairButton()
                .padding(.bottom, 8)
            // 부팅이 오래 막혔을 때만 도움 허브(GitHub Discussions) 진입점 노출 — 정상
            // 콜드 부팅(5–30s)에는 안 뜬다. 연결 전이라도 폰 일반 인터넷으로 열린다.
            if stalled {
                StuckHelpLink()
                    .padding(.bottom, 8)
            }
            Text("직접 SSH + Tor fallback — 외부 SaaS 0개 의존")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .padding(.bottom, 20)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task {
            // 정상 Tor 콜드 부팅은 보통 5–30s. 그보다 넉넉히(25s) 지나도 여전히 BootView 면
            // «정상 대기» 가 아니라 막힌 상태로 보고 원인 안내를 띄운다. 연결되면 AppRoot 가
            // BootView 를 치워 이 task 도 취소된다 → 안내는 안 뜬다.
            try? await Task.sleep(nanoseconds: 25_000_000_000)
            withAnimation { stalled = true }
        }
    }
}
