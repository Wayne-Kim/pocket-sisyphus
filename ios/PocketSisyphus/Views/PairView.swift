import SwiftUI
import AVFoundation
import UIKit  // UIPasteboard — 한 줄 설치 명령 복사

struct PairView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var tor: TorManager
    @EnvironmentObject var conn: ConnectionManager

    /// QR 페이로드에서 추출되는 값들. 직접 입력 UI 는 의도적으로 없음 — 52자 base32
    /// client-auth 키는 오타가 거의 보장되는 길이라 수동 입력 자체가 비실용적.
    @State private var error: String?
    @State private var verifying = false
    /// «설치 방법 보기» 시트 — 첫 진입한 사용자에게 Mac 앱이 따로 필요하다는 사실을
    /// 명확히 보여주기 위해 callout 에서 띄운다.
    @State private var showMacSetup = false
    /// 한 줄 설치 명령을 클립보드에 복사한 직후의 «복사됨» 피드백. 잠시 뒤 자동으로 풀린다.
    @State private var copied = false
    /// «프로 보기» 시트 — 페어링(Mac 연결) «전» 에도 인앱구매를 둘러볼 수 있는 진입점.
    /// 앱의 다른 페이월 진입점(워크플로우 탭·프로 기능)은 모두 페어링+연결 뒤에야 닿아서,
    /// Mac 이 없는 App Store 심사관은 IAP 에 도달할 길이 없었다(2.1(b) «IAP 못 찾음» 거절).
    /// 첫 화면에서 바로 PaywallView 를 띄워 누구나 상품을 볼 수 있게 한다.
    @State private var showPaywall = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                HStack(spacing: 6) {
                    Text("Pocket Sisyphus 페어링")
                        .font(.title2.weight(.semibold))
                    InfoButton(categoryId: "start", font: .callout)
                }
                Text("Mac 메뉴바 «페어링 QR 보기» 의 QR 을 스캔하세요")
                    .font(.callout)
                    .foregroundStyle(.secondary)

                // 이 iPhone 앱만으로는 동작하지 않는다는 사실은 첫 진입한 사용자에게 명확하지
                // 않다 — 작은 (?) InfoButton 만으로는 놓치기 쉬워서 강조 callout 으로 박는다.
                macSetupCallout

                QRScannerView { payload in
                    // sticky 페어링 차단(이미 다른 기기가 연결됨 등) 중엔 같은 QR 을 자동
                    // 재스캔하지 않는다 — 안 그러면 «실패→재스캔→실패» 루프가 돼 사용자가
                    // 영문도 모르고 «여러 번 시도» 하게 된다. 아래 «다시 스캔» 으로 비워야 재개.
                    guard auth.lastPairingError == nil else { return }
                    Task { await handleQRPayload(payload) }
                }
                .frame(maxWidth: .infinity)
                .frame(height: 320)
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .padding(.horizontal)
                if verifying {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("페어링 검증 중…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Text("페어링 QR 스캔")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let shown = error ?? auth.lastPairingError {
                    Text(LocalizedStringKey(shown))
                        .font(.caption)
                        .foregroundStyle(Theme.danger)
                        .padding(.horizontal)
                        .multilineTextAlignment(.center)
                    // 페어링/host key 막힘은 사람에게 묻기 전에 in-app 보안가이드가 더 맞아
                    // 목적지를 가이드로 분기한다(엣지케이스). 에러가 떠 있을 때만 노출.
                    StuckHelpLink(guideCategory: "security")
                        .padding(.top, 2)
                }
                // sticky 차단(이미 다른 기기 연결됨)일 때만 명시적 재개 버튼 — 비우면 위
                // QRScannerView 가드가 풀려 다음 스캔부터 다시 처리된다.
                if auth.lastPairingError != nil {
                    Button("다시 스캔") {
                        auth.lastPairingError = nil
                        error = nil
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .padding(.top, 2)
                }

                Spacer()
            }
            .padding(.vertical)
            // 페어링 전에도 인앱구매를 볼 수 있는 진입점 — 상단에 항상 노출(심사관·신규 사용자
            // 공통). 텍스트 라벨이라 작은 아이콘보다 발견성이 높다. 색은 기본 틴트(accent) 유지
            // (주황은 «프로 탭 버튼» 전용 — 일반 버튼엔 쓰지 않는다).
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showPaywall = true
                    } label: {
                        // 툴바 Label 은 기본적으로 아이콘만 보이므로 텍스트도 함께 노출 —
                        // 심사관/신규 사용자가 «프로 보기» 글자를 바로 읽고 찾게.
                        Label("프로 보기", systemImage: "crown")
                            .labelStyle(.titleAndIcon)
                    }
                }
            }
            .sheet(isPresented: $showMacSetup) {
                GuideView(initialCategoryId: "start")
            }
            .sheet(isPresented: $showPaywall) {
                NavigationStack {
                    PaywallView()
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                // 해제 버튼은 강조색이 아니라 중립(primary) — color 정책.
                                Button("닫기") { showPaywall = false }
                                    .tint(.primary)
                            }
                        }
                }
            }
        }
    }

    /// «Mac 앱이 먼저 필요해요» 강조 카드. 헤더/설명을 누르면 GuideView 의 «시작하기»
    /// 카테고리가 시트로 열리고, 안에는 «한 줄 설치» 명령 박스를 같이 단다. 카드 안에 버튼이
    /// 여러 개라(가이드 열기 + 복사) 바깥을 Button 으로 감싸지 않고 형제로 나란히 둔다.
    private var macSetupCallout: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                showMacSetup = true
            } label: {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "laptopcomputer.and.iphone")
                        .font(.title3)
                        .foregroundStyle(Theme.accent)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Mac 앱이 먼저 필요해요")
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(.primary)
                        Text("이 iPhone 앱만으로는 동작하지 않습니다. Mac에 Pocket Sisyphus 데스크탑 앱을 설치·실행한 뒤, 메뉴바 아이콘의 «페어링 QR 보기» 를 눌러주세요.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("설치 방법 보기 →")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Theme.accent)
                            .padding(.top, 2)
                    }
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)

            installCommandBox
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Theme.accent.opacity(0.10))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Theme.accent.opacity(Theme.Opacity.border), lineWidth: 1)
        )
        .padding(.horizontal)
    }

    /// «터미널 한 줄로 빠르게 설치» — install.sh 원라이너를 등폭으로 보여주고 복사 버튼을 단다.
    /// 사용자가 iPhone 에서 복사하면 iCloud(Universal) 클립보드로 Mac 터미널에 바로 붙여넣을 수
    /// 있어, QR 만 보던 첫 진입 흐름에서 Mac 앱 설치까지 한 화면에서 끝난다.
    private var installCommandBox: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("터미널 한 줄로 빠르게 설치", systemImage: "terminal")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.accent)

            HStack(alignment: .top, spacing: 8) {
                Text(verbatim: GuideContent.macInstallCommand)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    copyInstallCommand()
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.callout)
                        .foregroundStyle(copied ? Theme.success : Theme.accent)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(copied ? Text("클립보드에 복사됨") : Text("복사"))
            }
            .padding(8)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color(.secondarySystemBackground))
            )

            if copied {
                Text("클립보드에 복사됨")
                    .font(.caption2)
                    .foregroundStyle(Theme.success)
            } else {
                Text("Mac 터미널에 붙여넣어 실행하세요. 복사하면 iCloud 클립보드로 Mac 에서 바로 붙여넣을 수 있어요.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// 한 줄 설치 명령을 클립보드에 넣고 1.8초간 «복사됨» 표시. iPhone 의 Universal 클립보드를
    /// 통해 Mac 터미널에 바로 붙여넣을 수 있다.
    private func copyInstallCommand() {
        UIPasteboard.general.string = GuideContent.macInstallCommand
        withAnimation { copied = true }
        Task {
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            withAnimation { copied = false }
        }
    }

    private func handleQRPayload(_ raw: String) async {
        guard let data = raw.data(using: .utf8) else {
            error = String(localized: "QR 형식이 올바르지 않습니다. Mac 의 새 QR 을 다시 스캔해 주세요.")
            return
        }
        do {
            let payload = try JSONDecoder().decode(PairQRPayload.self, from: data)
            // 듀얼 채널 모델 v=3 부터 SSH 필드 필수. v<3 페이로드는 SSH 인증 불가 → 거부.
            guard payload.v >= 3 else {
                error = String(localized: "오래된 QR 입니다 — Mac 앱을 최신 버전으로 업데이트한 뒤 새 QR 을 출력하세요.")
                return
            }
            guard let onionAuth = payload.onion_auth, onionAuth.count == 52 else {
                error = String(localized: "QR 의 onion 인증 키 형식이 올바르지 않습니다 — Mac 에서 새 QR 을 출력해 주세요.")
                return
            }
            guard let daemonToken = payload.daemon_token, daemonToken.count >= 30 else {
                error = String(localized: "QR 에 daemon 토큰이 없습니다 — Mac 에서 새 QR 을 출력해 주세요.")
                return
            }
            guard let endpointToken = payload.endpoint_token, !endpointToken.isEmpty else {
                error = String(localized: "QR 에 endpoint 토큰이 없습니다 — Mac 에서 새 QR 을 출력해 주세요.")
                return
            }
            guard let sshFingerprint = payload.ssh_host_key_fingerprint,
                  sshFingerprint.hasPrefix("SHA256:") else {
                error = String(localized: "QR 의 SSH host fingerprint 가 올바르지 않습니다 — Mac 에서 새 QR 을 출력해 주세요.")
                return
            }
            guard let sshClientPriv = payload.ssh_client_priv, !sshClientPriv.isEmpty else {
                error = String(localized: "QR 의 SSH client 키가 없습니다 — Mac 에서 새 QR 을 출력해 주세요.")
                return
            }
            guard let sshUser = payload.ssh_user, !sshUser.isEmpty else {
                error = String(localized: "QR 에 SSH user 가 없습니다 — Mac 에서 새 QR 을 출력해 주세요.")
                return
            }
            guard payload.onion.hasSuffix(".onion") else {
                error = String(localized: "QR 의 onion 주소 형식이 올바르지 않습니다 — Mac 에서 새 QR 을 출력해 주세요.")
                return
            }
            await verifyAndSave(
                cfg: PairConfig(
                    onion: payload.onion,
                    onionAuth: onionAuth,
                    endpointToken: endpointToken,
                    daemonToken: daemonToken,
                    sshHostKeyFingerprint: sshFingerprint,
                    sshHostKey: payload.ssh_host_key,
                    sshClientPriv: sshClientPriv,
                    sshUser: sshUser,
                    name: payload.name ?? "Mac",
                    pairedAt: Date(),
                    lanHost: payload.lan_host,
                    sshPort: payload.ssh_port.flatMap { UInt16(exactly: $0) },
                    daemonPort: payload.daemon_port.flatMap { UInt16(exactly: $0) }
                )
            )
        } catch {
            self.error = String(localized: "QR 디코드 실패 — Mac 에서 새 QR 을 출력해 다시 스캔해 주세요.")
        }
    }

    private func verifyAndSave(cfg: PairConfig) async {
        guard !verifying else { return }
        verifying = true
        defer { verifying = false }
        // 페어링 흐름(연결→등록→첫 토큰)을 PairView 가 직접 운전하는 동안엔 AppRoot 의 잠금
        // 게이트(LockView)를 억제한다 — 안 그러면 auth.save 직후 conn 이 .running 이 되는 순간
        // 게이트가 떠서 ensureToken 을 발사, pairingEnroll 의 challenge-response 와 겹쳐 생체
        // 프롬프트가 두 번 뜬다.
        AttestSession.shared.beginPairing()
        defer { AttestSession.shared.endPairing() }
        error = nil

        NSLog("[Pair] start verify onion=\(cfg.onion.prefix(16))... torSocks=\(tor.currentSocksPort ?? 0)")

        // .auth_private 파일 작성 (Tor 가 떠 있다면 RELOAD 까지) — onion descriptor 복호화에 필요.
        await tor.installClientAuth(for: cfg)

        auth.save(cfg)

        // ConnectionManager 가 캐시된 endpoint 가 없으니 Tor 띄워 /endpoint 받아오고 SSH 채택.
        // 직접 채널 가능하면 빠른 SSH, 아니면 Tor onion SSH fallback.
        error = String(localized: "데몬에 연결 중…")
        await conn.connect()

        let api = ApiClient(auth: auth, conn: conn)
        do {
            NSLog("[Pair] calling /health")
            error = String(localized: "/health 호출 중…")
            let h = try await api.health()
            NSLog("[Pair] /health ok: \(h.time)")
            // Secure Enclave 기기 인증 등록 — daemon 이 지원하면 이 기기 SE 키를 등록하고
            // 첫 토큰까지 확보한다(Face ID 1회). 등록 후로는 이 기기만 daemon 에 접근 가능.
            // 옛 daemon(404)·SE 미지원(시뮬레이터)이면 pairingEnroll 이 조용히 통과한다.
            error = String(localized: "기기 인증 등록 중…")
            NSLog("[Pair] attest pairingEnroll")
            try await AttestSession.shared.pairingEnroll(api: api)
            error = String(localized: "/api/sessions 호출 중…")
            let ss = try await api.listSessions()
            NSLog("[Pair] /api/sessions ok: \(ss.count) sessions")
            error = nil
            // auth.save 이미 됐음 — AppRoot가 SessionsView로 전환
        } catch ApiError.attestFailed(let msg) {
            // 단일 기기 위반(이미 다른 폰이 등록됨) 등 기기 인증 단계의 «안내성» 실패.
            // 이 메시지는 그 자체로 다음 행동(Mac 에서 기기 해제)을 담고 있으니, 모호한
            // «연결 실패:» 접두사 없이 그대로 보여 준다. 스토어(durable)에 담아: auth.clear 로
            // PairView 가 새로 그려져도 메시지가 살아남고, 비워질 때까지 자동 재스캔도 멈춘다.
            NSLog("[Pair] attest blocked: \(msg)")
            auth.clear()
            await tor.removeClientAuth(for: cfg)
            auth.lastPairingError = msg
        } catch let e {
            NSLog("[Pair] FAILED: \(e)")
            auth.clear()
            // 실패한 시도가 남긴 .auth_private 도 같이 제거 — 다음 회로 빌드에 잔재 키가
            // 섞여 들어가지 않도록.
            await tor.removeClientAuth(for: cfg)
            let inner: String = (e as? LocalizedError)?.errorDescription ?? "\(e)"
            self.error = String(localized: "연결 실패: \(inner)")
        }
    }
}
