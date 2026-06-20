import SwiftUI
import StoreKit
import SafariServices
import UIKit  // UIPasteboard (진단 블록 클립보드 폴백) · UIDevice (iOS 버전)

/// 통합 설정 시트. 메인 (SessionsView) 좌상단 「설정」 버튼이 띄운다.
///
/// 이전엔 좌상단 gearshape 가 드롭다운 `Menu` 였는데 항목이 계속 늘어 평면 메뉴로는 위계가
/// 없어 시트로 통합. iOS 기본 «설정» 앱처럼 그룹 List 로 묶는다. **«설정 가능한 것» 만** 담는다
/// — 언어 / 가로 모드 / Mac 앱 업데이트 / 페어링 해제 / 버전. 도움말 (안내 문서) 과 예약 작업
/// (기능 사용) 은 설정이 아니라서 메인 화면 좌상단의 별도 버튼으로 빠져 있다.
///
/// 자급자족 — auth / conn / inflight 를 EnvironmentObject 로 받고, daemon 버전·capability 는
/// `.task` 에서 직접 `/api/version` 을 한 번 fetch 한다 (silent_update_v1 판정 + 버전 표시용).
/// 언어는 자체 NavigationStack 을 가진 독립 시트라 **중첩 .sheet** 로 그대로 재사용한다.
struct SettingsSheet: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker
    /// 구독 관리 진입점 노출 판단 — 활성 구독(월/년) 보유 시에만 «구독 관리» 행을 띄운다.
    /// (iapEnabled=false 동안엔 store 가 비어 있어 hasActiveSubscription==false → 행이 안 보인다.)
    @EnvironmentObject var purchase: PurchaseStore

    @Environment(\.dismiss) private var dismiss

    // 중첩 시트 / alert 트리거 — SessionsView 에서 이관.
    @State private var showLanguageSheet = false
    @State private var showLanguageRestartAlert = false

    // 커뮤니티 — GitHub Discussions 를 SFSafariViewController 로 띄우는 시트. 「도움받기」 와
    // 「버그 제보」 가 같은 시트를 쓰되 목적지 URL 만 달라 `.sheet(item:)` 로 묶는다(nil=닫힘).
    @State private var communityDestination: CommunityDestination?
    // 버그 제보 — 진단 블록을 클립보드에 복사했다는 «비차단» 토스트. 잠시 뒤 자동으로 사라진다.
    @State private var showDiagnosticsToast = false

    // 도움말 — 화면별 toolbar 「?」 버튼을 걷어내고, 도움말 허브 진입을 설정 안 이 한 곳으로
    // 일원화한다. GuideView 전체 카테고리(시작·세션·연결·보안 등)를 자체 NavigationStack 시트로 띄운다.
    @State private var showGuideSheet = false

    // Mac 앱 원격 업데이트 — 트리거 결과 alert + 사일런트 진행 플래그. SessionsView 에서 이관.
    @State private var updateTriggerResult: UpdateTriggerResult?
    @State private var updateInProgress = false

    // daemon /api/version 결과. 시트가 직접 fetch — nil = 아직 응답 전.
    @State private var daemonVersion: String?
    @State private var daemonCapabilities: [String] = []

    // 알림 — daemon-level Discord 미리보기 옵트인. 시트가 /api/notify/config 를 직접 읽고 쓴다.
    // notifyConfigured=false 면 Discord 가 아직 연결 안 됨(웹훅은 Mac 앱에서 설정) → 토글 비활성.
    @State private var notifyConfigured = false
    @State private var notifyIncludePreview = false
    @State private var notifyLoaded = false
    @State private var savingPreview = false

    // 앱 테마 (시스템 따라가기 / 라이트 / 다크). PocketSisyphusApp 이 같은 키를 읽어
    // .preferredColorScheme 로 즉시 반영하므로, 여기서 바꾸면 곧바로 화면이 갈아끼워진다.
    @AppStorage(ThemeMode.storageKey) private var themeMode: ThemeMode = .system

    // «컨트롤 숨김 버튼(FAB)» 을 방향별로 띄울지 — 채팅·미러링 화면이 같은 두 키를 본다.
    // 켜진 방향에서만 눈 모양 버튼이 떠 헤더·컨트롤을 숨겨 본문(터미널·미러)을 넓게 볼 수 있다.
    @AppStorage(ChromeHideFAB.landscapeKey) private var showChromeFABLandscape: Bool = ChromeHideFAB.defaultShown
    @AppStorage(ChromeHideFAB.portraitKey) private var showChromeFABPortrait: Bool = ChromeHideFAB.defaultShown

    // LAN 전용(사설망 직결, fail-closed) 모드. 켜면 같은 Wi‑Fi 일 때만 사설/링크로컬 주소로
    // 직접 SSH 하고, Tor 발견·공인 IPv4/IPv6·onion 폴백을 건너뛰고 거부한다. 오프-LAN 이면
    // 연결을 명시적으로 차단한다. 바꾸면 onChange 가 즉시 재연결해 새 정책을 적용한다.
    @AppStorage(LanOnlyPolicy.defaultsKey) private var lanOnly: Bool = false

    // 음성 인식 모델 변종(정확도/용량) — base(기본·가벼움) / small(정확도 우선·큰 다운로드).
    // 선택은 영속되고, 바꾸면 onChange 가 shared 인식기를 새 가중치로 1회 받아 재로드한다.
    @AppStorage(WhisperSpeechRecognizer.ModelVariant.storageKey)
    private var voiceModelVariant: String = WhisperSpeechRecognizer.ModelVariant.default.rawValue

    // 모델 교체(다운로드/로드) 진행 상태·진행률·오류를 보여 주려고 shared 인식기를 관찰한다.
    @ObservedObject private var speech = WhisperSpeechRecognizer.shared

    /// 현재 연결 채널 + RTT 표시 — 옛 채팅방 더보기 메뉴의 「연결 상태」 를 설정으로 이동(세션 무관).
    private var connectionLabel: String {
        guard let t = conn.currentEndpointType else { return String(localized: "연결 중") }
        let kind: String
        switch t {
        case .directLan:  kind = "LAN"
        case .directIPv6: kind = "IPv6"
        case .directIPv4: kind = "IPv4"
        case .torOnion:   kind = "Tor"
        }
        if let r = conn.lastRTTms { return "\(kind) · \(r)ms" }
        return kind
    }
    private var connectionIcon: String {
        guard let t = conn.currentEndpointType else { return "ellipsis" }
        switch t {
        case .torOnion: return "tortoise.fill"
        case .directLan: return "house.fill"
        case .directIPv6, .directIPv4: return "bolt.fill"
        }
    }

    var body: some View {
        NavigationStack {
            List {
                // 일반 — 테마 / 언어 / 가로 모드.
                Section {
                    // 테마 — 시스템 따라가기 / 라이트 / 다크. menu 스타일이라 한 행에서 현재 값을
                    // 보여 주고 탭하면 펼쳐진다. 선택 즉시 @AppStorage 가 바뀌어 화면이 갈아끼워진다.
                    Picker(selection: $themeMode) {
                        ForEach(ThemeMode.allCases) { mode in
                            Text(mode.label).tag(mode)
                        }
                    } label: {
                        Label("테마", systemImage: "circle.lefthalf.filled")
                    }
                    .pickerStyle(.menu)
                    // 현재 선택값 텍스트는 브랜드 보라가 아니라 primary(중립)로 — 대부분의 설정 UI 가
                    // 선택값을 강조색이 아닌 본문색으로 보여 준다(아이콘만 강조). 라이트=검정·다크=흰색 적응.
                    .tint(Color.primary)

                    Button {
                        showLanguageSheet = true
                    } label: {
                        disclosureRow("언어", systemImage: "globe")
                    }
                    .buttonStyle(.plain)
                }

                // 화면 — «컨트롤 숨김 버튼(FAB)» 을 방향별로 켠다. 채팅·미러링 화면에서 헤더/컨트롤을
                // 숨겨 본문(터미널·미러)을 넓게 본다. 거슬리는 방향에선 버튼 자체를 꺼 둘 수 있다.
                Section {
                    Toggle(isOn: $showChromeFABLandscape) {
                        Label("가로 모드에서 컨트롤 숨김 버튼", systemImage: "rectangle")
                    }
                    Toggle(isOn: $showChromeFABPortrait) {
                        Label("세로 모드에서 컨트롤 숨김 버튼", systemImage: "rectangle.portrait")
                    }
                } header: {
                    Text("화면 넓게 보기")
                } footer: {
                    Text("켜면 그 방향에서 채팅·미러링 화면 구석에 버튼이 떠요. 눌러서 헤더와 컨트롤을 숨겨 화면을 넓게 보고, 다시 누르면 돌아옵니다.")
                }

                // 음성 입력 — 인식 모델 정확도(다운로드 용량/지연 트레이드오프). 한국어·CJK 받아쓰기
                // 오인식이 잦으면 «정확도 우선(small)» 으로 올린다. 바꾸면 새 모델을 1회 받아 캐시하고
                // shared 인식기를 새 가중치로 재로드한다 — 교체 중 진행 상태/진행률을 같은 섹션에 보여 준다.
                Section {
                    Picker(selection: $voiceModelVariant) {
                        Text("빠르고 가벼움 (기본)").tag(WhisperSpeechRecognizer.ModelVariant.base.rawValue)
                        Text("정확도 우선").tag(WhisperSpeechRecognizer.ModelVariant.small.rawValue)
                    } label: {
                        Label("음성 인식 정확도", systemImage: "waveform")
                    }
                    .pickerStyle(.menu)
                    // 선택값 텍스트는 강조색이 아니라 primary(중립) — 테마 피커와 같은 규칙.
                    .tint(Color.primary)
                    .onChange(of: voiceModelVariant) { raw in
                        guard let v = WhisperSpeechRecognizer.ModelVariant(rawValue: raw) else { return }
                        Task { await speech.setVariant(v) }
                    }

                    // 교체(다운로드/로드) 진행 상태 — 경고가 아니므로 accent(보라). 평상시엔 안 그린다.
                    if speech.modelState == .preparing {
                        HStack(spacing: 8) {
                            if speech.isLoadingModel {
                                ProgressView().controlSize(.mini)
                                Text("음성 모델 불러오는 중…")
                                    .font(.caption)
                            } else {
                                let pct = "\(Int((speech.downloadProgress * 100).rounded()))%"
                                Image(systemName: "arrow.down.circle")
                                    .font(.caption2.weight(.semibold))
                                Text("음성 모델 다운로드 중 \(pct)")
                                    .font(.caption)
                                    .monospacedDigit()
                                ProgressView(value: speech.downloadProgress)
                                    .frame(maxWidth: 120)
                            }
                            Spacer(minLength: 0)
                        }
                        .foregroundStyle(Theme.accent)
                        .tint(Theme.accent)
                    }
                } header: {
                    Text("음성 입력")
                } footer: {
                    Text("정확도 우선(small)은 한국어·중국어·일본어 받아쓰기가 더 정확하지만 다운로드가 더 큽니다. 빠르고 가벼움 ≈150MB · 정확도 우선 ≈480MB.")
                }

                // 알림 — turn_complete / still_waiting 알림 본문에 «에이전트의 마지막 응답 한두 줄»
                // 미리보기를 실을지. 기본 OFF (프라이버시 옵트인) — 켜야 출력 일부가 외부 Discord 로
                // 나간다. 커스텀 Binding 의 set 은 «사용자 탭» 에만 불려, 로드 시 프로그램 대입은
                // 서버로 되쏘지 않는다. notifyConfigured=false (웹훅 미연결) 면 비활성 + 안내.
                Section {
                    Toggle(isOn: Binding(
                        get: { notifyIncludePreview },
                        set: { newValue in
                            notifyIncludePreview = newValue
                            Task { await saveIncludePreview(newValue) }
                        }
                    )) {
                        Label("알림에 응답 미리보기 포함", systemImage: "text.bubble")
                    }
                    .disabled(!notifyLoaded || !notifyConfigured || savingPreview)
                } header: {
                    Text("알림")
                } footer: {
                    if notifyLoaded && !notifyConfigured {
                        Text("Discord 알림이 아직 연결되어 있지 않아요. Mac 앱의 «Discord 알림 설정» 에서 webhook을 먼저 연결하면 이 옵션을 켤 수 있어요.")
                    } else {
                        Text("켜면 에이전트의 마지막 응답 한두 줄이 알림 본문으로 Discord에 전송됩니다. 폰을 열지 않고도 무슨 응답·질문인지 미리 볼 수 있어요. 감지된 흔한 비밀 패턴(토큰·키 등)은 자동으로 가려지지만 완벽하지 않으니, 민감한 세션에서는 꺼두세요.")
                    }
                }

                // 연결 · 보안 — 현재 채널(IPv6/IPv4/Tor) + RTT 진단 행에 더해, 분산된 보안 신호
                // (기기 인증·채널 신원·host key 검증 등급)를 한 패널로 모은 「보안 상태」 로 들어간다.
                // 세션과 무관한 진단/신뢰 정보라 채팅방 더보기 메뉴가 아니라 여기(설정)에 둔다.
                // conn 이 갱신하면 행도 실시간으로 바뀐다.
                Section {
                    Label {
                        Text(verbatim: connectionLabel)
                    } icon: {
                        Image(systemName: connectionIcon)
                    }
                    NavigationLink {
                        SecurityStatusView()
                    } label: {
                        Label("보안 상태", systemImage: "lock.shield")
                    }
                } header: {
                    Text("연결 · 보안")
                } footer: {
                    Text("기기 인증, 현재 채널의 신원 보장, 서버 호스트 키 검증 등급을 한 곳에서 확인할 수 있어요.")
                }

                // 「같은 Wi‑Fi 전용(LAN 직결)」 — 연결·보안 섹션에 묻혀 잘 안 보이던 토글을 전용
                // 섹션으로 빼 설명을 «항상» 보이게 한다. 켜면 launch 때 Tor 부트스트랩 자체를
                // 건너뛰고(AppRoot), 같은 LAN 의 사설 주소로만 직결한다.
                Section {
                    Toggle(isOn: $lanOnly) {
                        Label("LAN 전용 모드", systemImage: "house.lock")
                    }
                    .onChange(of: lanOnly) { _, _ in
                        // 정책이 바뀌면 즉시 재연결 — 켜면 LAN 직결로, 끄면 일반 듀얼 채널로 전환.
                        Task { await conn.reconnect() }
                    }
                } footer: {
                    Text("같은 Wi‑Fi 일 때만 사설 주소로 직접 연결해요. 외부 네트워크에선 연결이 차단됩니다.")
                }

                // Tor bridge — 평문 Tor 가 막힌 네트워크(학교·회사·일부 국가)에서 onion fallback 을
                // 살리는 선택형 우회. 평문 Tor 가 잘 되는 환경에선 영향 없음(평문 우선·실패 시에만).
                Section {
                    NavigationLink {
                        TorBridgeView()
                    } label: {
                        Label("Tor bridge", systemImage: "shield.lefthalf.filled")
                    }
                } footer: {
                    Text("Tor 연결이 막히는 네트워크에서 bridge(obfs4 등)를 거쳐 우회 연결할 수 있어요.")
                }

                // 기기 — 이 Mac 에 인증된 기기 목록 + 추가 기기 허용 토글 + 개별 해제(revoke).
                // Mac 설정 「기기」 탭과 같은 daemon 라우트를 폰에서 호출한다. '폰이 곧 제어판'
                // 원칙 — 추가 기기 허용을 폰에서 바로 켜고(막다른 길 제거), 분실 기기를 남은
                // 폰에서 즉시 해제할 수 있다.
                Section {
                    NavigationLink {
                        DevicesView()
                    } label: {
                        Label("기기", systemImage: "iphone")
                    }
                } footer: {
                    Text("이 Mac 에 연결된 기기를 확인하고, 추가 기기를 허용하거나 분실한 기기의 접근을 해제할 수 있어요.")
                }

                // Mac 앱 — 원격 업데이트. daemon 의 admin/trigger-update 가 부모 (Mac 앱) 에
                // SIGUSR1 → Sparkle 가 EdDSA 검증된 DMG 받아 .app 교체 + relaunch 까지 알아서.
                // OS 권한 다이얼로그 없음 (같은 Team ID + notarized). relaunch 직후 SSH 채널이
                // 한 번 끊겼다가 ConnectionManager.reconnect 가 자동 재연결 — 사용자는 잠시
                // "재연결 중…" 만 본다.
                Section {
                    Button {
                        Task { await triggerMacUpdate() }
                    } label: {
                        HStack {
                            Label("Mac 앱 업데이트", systemImage: "arrow.down.circle")
                            if updateInProgress {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(updateInProgress)
                } header: {
                    // 브랜드 식별자 — 번역 대상 아님.
                    Text(verbatim: "Mac")
                } footer: {
                    Text(daemonVersionLabel)
                }

                // 구독 — 활성 구독(월/년) 보유 시에만. 해지·플랜 변경은 Apple 이 소유하므로
                // 네이티브 «구독 관리» 시트(AppStore.showManageSubscriptions)로 보낸다. 자동갱신
                // 구독앱은 앱 내에 관리 진입점을 제공해야 한다(App Store 심사 요건). 평생 이용권만
                // 보유한 사용자에겐 관리할 구독이 없어 노출하지 않는다.
                if purchase.hasActiveSubscription {
                    Section {
                        Button {
                            Task { await openManageSubscriptions() }
                        } label: {
                            disclosureRow("구독 관리", systemImage: "creditcard")
                        }
                        .buttonStyle(.plain)
                    } footer: {
                        Text("월간·연간 구독의 해지·플랜 변경은 App Store 계정에서 관리합니다.")
                    }
                }

                // 도구(MCP) — 에이전트가 붙을 사용자 본인 Calendar/Gmail 등 MCP 서버 등록·연결·
                // 상태. mcp_tools_v1 지원 daemon 일 때만 노출(soft — 없으면 숨김). 「고급 도구」
                // 묶음(터미널·로컬 LLM·채팅 도구 칩과 같은 카테고리)이라 행 아이콘만 pro(주황)로
                // 강조하고, 진입 자체는 기본 accent 를 따른다(앱 전역 tint 안 건다).
                if daemonCapabilities.contains("mcp_tools_v1") {
                    Section {
                        NavigationLink {
                            McpServersView(auth: auth, conn: conn, inflight: inflight)
                        } label: {
                            Label {
                                Text("도구")
                            } icon: {
                                Image(systemName: "wrench.and.screwdriver")
                                    .foregroundStyle(Theme.pro)
                            }
                        }
                    } header: {
                        Text("도구")
                    } footer: {
                        Text("캘린더·Gmail 같은 도구를 연결하면, 에이전트가 내 일정·메일을 읽고 도와줄 수 있어요. 토큰은 Mac 에만 안전하게 보관돼요.")
                    }
                }

                // 도움말 — 화면별 toolbar 「?」 버튼을 걷어내고, 도움말 허브 진입을 설정 안 이 한
                // 곳으로 일원화했다. GuideView 전체 카테고리를 자체 NavigationStack 시트로 띄운다.
                // 색은 안내 톤(기본 accent) — 경고(노랑)/프로(주황) 아님. 행은 시트를 열지만
                // 커뮤니티 행들과 같은 disclosureRow 모양을 따른다(설정앱 관례).
                Section {
                    Button {
                        showGuideSheet = true
                    } label: {
                        disclosureRow("사용 안내", systemImage: "questionmark.circle")
                    }
                    .buttonStyle(.plain)
                } header: {
                    Text("도움말")
                } footer: {
                    Text("페어링·세션·연결·보안까지 모든 사용 안내를 한곳에서 볼 수 있어요.")
                }

                // 커뮤니티 — in-app 포럼 대신 공개 repo 의 GitHub Discussions 로 보낸다
                // (인프라·비용 0). 작은 초기 제품이 in-app 포럼의 임계 질량을 만들기 어렵고,
                // 개발자는 이미 GitHub 에 산다. 시스템 쿠키 공유를 위해 Safari(SFSafariViewController)
                // 로 연다 — GitHub 로그인 상태가 그대로 유지돼 바로 글을 쓸 수 있다. 커뮤니티는
                // 프로(주황) 기능이 아니라 기본 틴트(accent=보라)를 그대로 따른다.
                Section {
                    Button {
                        communityDestination = CommunityDestination(url: CommunityLinks.discussions)
                    } label: {
                        disclosureRow("도움받기 · 공유하기", systemImage: "bubble.left.and.bubble.right")
                    }
                    .buttonStyle(.plain)

                    // 버그 제보 — 같은 Discussions 허브로 가되, 앱·OS 버전과 연결 모드(진단 블록)를
                    // 자동으로 채워 「빈 작성창에 '안 돼요'만」 남는 흐릿한 제보를 줄인다. 색은 안내 톤
                    // (기본 accent) — 경고(노랑)/프로(주황) 아님. 아이콘은 welcome.md 의 🐞 와 짝.
                    Button {
                        startBugReport()
                    } label: {
                        disclosureRow("버그 제보", systemImage: "ladybug")
                    }
                    .buttonStyle(.plain)
                } header: {
                    Text("커뮤니티")
                } footer: {
                    Text("질문하고 사용법을 공유하거나 버그를 제보할 수 있어요. 「버그 제보」 를 누르면 앱·OS 버전과 연결 모드를 자동으로 채워 드려요. GitHub Discussions 가 Safari에서 열립니다.")
                }

                // 페어링 해제 — auth.clear() 후 AppRoot 가 auth.config == nil 을 감지해 PairView
                // (QR 스캐너) 로 재라우팅. 그 과정에서 이 시트도 부모와 함께 사라진다.
                Section {
                    Button(role: .destructive) {
                        auth.clear()
                    } label: {
                        Label("페어링 해제", systemImage: "lock.open")
                    }
                } footer: {
                    // 맨 아래 버전 — iOS 자기 자신 + 페어된 Mac daemon. 사용자가 «iOS만 새거,
                    // Mac은 옛 거» mismatch 를 한눈에 식별 → 업데이트 트리거 신호. 이슈 리포트 시
                    // "어떤 버전인지" 한 번에 찾게 marketing version 만 노출 (build 번호는 숨김).
                    Text(versionFooter)
                }
            }
            .navigationTitle("설정")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    // 닫기 같은 «해제» 텍스트 버튼은 강조색(보라)이 아니라 primary(중립) — 대부분의
                    // 시트가 그렇다. 확정 액션만 강조색을 쓰고, 닫기/취소는 본문색으로 둔다.
                    Button("닫기") { dismiss() }
                        .tint(Color.primary)
                }
            }
            // 앱 내 언어 변경 시트. 선택되면 AppleLanguages override 를 박고 재시작 alert.
            .sheet(isPresented: $showLanguageSheet) {
                LanguagePickerSheet { code in
                    applyLanguage(code)
                }
            }
            // 커뮤니티 — GitHub Discussions 를 시스템 Safari 쿠키 공유 컨텍스트로 띄운다.
            // 「도움받기」 는 빈 작성창, 「버그 제보」 는 진단 블록이 프리필된 새 글 URL.
            .sheet(item: $communityDestination) { dest in
                SafariView(url: dest.url)
                    .ignoresSafeArea()
            }
            // 도움말 허브 — 화면별 「?」 버튼을 일원화한 단일 진입점. GuideView 가 자체
            // NavigationStack 을 가진 독립 시트라 중첩 .sheet 로 그대로 재사용한다.
            .sheet(isPresented: $showGuideSheet) {
                GuideView()
            }
            // 버그 제보 진단 복사 안내 — 비차단 토스트. Safari 가 곧 덮으므로 그 «전» 잠깐 보인다.
            .overlay(alignment: .bottom) { diagnosticsToastBanner }
            // 언어 변경 안내 — iOS 는 AppleLanguages 를 부팅 시 한 번만 읽으므로 다음 부팅부터
            // 적용된다. 옛 «지금 재시작 → exit(0)» 은 App Store 가이드라인 2.5.1 위반으로 제거.
            .alert(
                "다음 부팅 시 적용됩니다",
                isPresented: $showLanguageRestartAlert
            ) {
                Button("확인") { }
            } message: {
                Text("선택한 언어는 앱을 완전히 닫고 다시 열면 적용됩니다. 홈에서 위로 스와이프 → Pocket Sisyphus 카드를 위로 밀어 종료한 뒤 아이콘을 다시 탭하세요.")
            }
            // Mac 앱 원격 업데이트 결과 — 성공 / 실패 모두 한 alert 로 묶는다. 성공이라도
            // 사용자에게 "메뉴바 Sparkle UI 가 곧 뜬다" 정도는 안내해야 폰만 보는 사용자가
            // Mac 화면이 멈춘 줄 오해하지 않는다.
            .alert(
                updateTriggerResult?.title ?? "",
                isPresented: Binding(
                    get: { updateTriggerResult != nil },
                    set: { if !$0 { updateTriggerResult = nil } }
                ),
                presenting: updateTriggerResult
            ) { _ in
                Button("확인") { updateTriggerResult = nil }
            } message: { r in
                Text(r.message)
            }
            // 음성 모델 교체 오류(폴백·저장공간 부족 등) — shared 인식기의 lastError 를 노출.
            .alert(
                "음성 입력",
                isPresented: Binding(
                    get: { speech.lastError != nil },
                    set: { if !$0 { speech.lastError = nil } }
                )
            ) {
                Button("확인", role: .cancel) { speech.lastError = nil }
            } message: {
                Text(verbatim: speech.lastError ?? "")
            }
        }
        // (scoped .tint 제거됨 — 이제 AccentColor 에셋이 «전역» 액센트라 기본 컨트롤이 알아서 보라.
        // scoped tint 가 전역 기본(파랑)과 싸워 아이콘이 보라↔파랑 깜빡이던 원인이었다. 닫기 버튼·
        // 테마 피커 값은 위에서 per-element `.tint(Color.primary)` 로 중립 처리.)
        .task { await loadVersion() }
        .task { await loadNotifyConfig() }
    }

    /// 설정 행 — 아이콘 + 제목 + 우측 chevron. 시트/푸시를 여는 Button 을 .plain 스타일로
    /// 감싸 시스템 tint(파랑) 대신 기본 글자색을 쓰게 한다 (iOS 설정앱 행과 같은 모양).
    private func disclosureRow(_ title: LocalizedStringKey, systemImage: String) -> some View {
        HStack {
            Label(title, systemImage: systemImage)
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }

    /// 버그 제보 — 진단 블록(앱 버전+build·iOS·연결 모드)을 클립보드에 복사하고, 비차단
    /// 토스트로 알린 «뒤» 진단이 프리필된 Discussions 새 글을 Safari 로 연다.
    ///
    /// 프리필(URL body)은 best-effort 라 환경에 따라 누락될 수 있어, 클립보드 복사를 항상
    /// 함께 해 «붙여넣기» 폴백을 보장한다. 토스트→Safari 사이 짧은 지연은 Safari 시트가
    /// 토스트를 덮기 전에 안내가 보이게 한다(«토스트 안내 후 작성창 열기»). 사용자가 아무것도
    /// 안 해도 흐름이 끊기지 않는다.
    @MainActor
    private func startBugReport() {
        let type = conn.currentEndpointType
        UIPasteboard.general.string = BugReportDiagnostics.block(connectionType: type)
        let url = BugReportDiagnostics.discussionURL(connectionType: type)
        withAnimation { showDiagnosticsToast = true }
        Task {
            try? await Task.sleep(for: .seconds(0.9))
            communityDestination = CommunityDestination(url: url)
            try? await Task.sleep(for: .seconds(1.8))
            withAnimation { showDiagnosticsToast = false }
        }
    }

    /// 진단 복사 안내 토스트 — CommitsView 토스트와 같은 캡슐 패턴. 안내 톤이라 accent(보라),
    /// 캡슐 위 글자는 토스트 관례대로 흰색(본문 .primary 규칙은 일반 본문에만 적용).
    @ViewBuilder private var diagnosticsToastBanner: some View {
        if showDiagnosticsToast {
            HStack(spacing: 8) {
                Image(systemName: "doc.on.clipboard")
                Text("진단 정보를 복사했어요 — 글 본문에 붙여넣으세요")
                    .font(.subheadline)
            }
            .foregroundStyle(Theme.onAccent)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Theme.accent, in: Capsule())
            .padding(.bottom, 24)
            .padding(.horizontal, 16)
            .shadow(radius: 8, y: 2)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    /// "iOS v0.2.7" 형태. Info.plist 의 marketing version 만 노출 — build 번호는 사용자에게
    /// 의미 없는 단조 증가 정수라 숨긴다.
    private var versionLabel: String {
        let info = Bundle.main.infoDictionary
        let marketing = info?["CFBundleShortVersionString"] as? String ?? "?"
        return "iOS v\(marketing)"
    }

    /// 페어된 Mac 앱(daemon) 의 버전. fetch 한 값을 그대로 표시. nil 이면 «확인 중…».
    private var daemonVersionLabel: String {
        if let v = daemonVersion {
            return "Mac v\(v)"
        }
        return String(localized: "Mac — 확인 중…")
    }

    /// 맨 아래 버전 footer — iOS + Mac 한 줄. "·" 는 비번역 구분자.
    private var versionFooter: String {
        "\(versionLabel) · \(daemonVersionLabel)"
    }

    /// daemon /api/version 한 번 fetch. 실패하면 조용히 nil/옛 값 유지 (보조 정보라 에러 노출 X).
    @MainActor
    private func loadVersion() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        if let info = try? await api.getServerVersion(label: nil) {
            daemonVersion = info.daemonVersion
            daemonCapabilities = info.capabilities
        }
    }

    /// daemon 알림 설정 fetch — 미리보기 토글 초기 상태 + Discord 연결 여부. 실패하면 조용히
    /// 기본값(OFF/미연결) 유지. notifyLoaded 로 «아직 확인 중» 과 «미연결» 을 구분한다.
    @MainActor
    private func loadNotifyConfig() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        if let info = try? await api.getNotifyConfig(label: nil) {
            notifyConfigured = info.configured
            notifyIncludePreview = info.includePreview
        }
        notifyLoaded = true
    }

    /// 미리보기 옵트인 토글 저장. 실패하면 토글을 직전 상태로 되돌려 서버와 어긋나지 않게 한다.
    /// (커스텀 Binding 의 set 에서만 호출되므로 이 되돌림 대입은 서버로 다시 POST 되지 않는다.)
    @MainActor
    private func saveIncludePreview(_ value: Bool) async {
        savingPreview = true
        defer { savingPreview = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            try await api.setNotifyIncludePreview(value)
        } catch {
            notifyIncludePreview = !value
        }
    }

    /// 네이티브 «구독 관리» 시트를 띄운다 (해지·플랜 변경). 활성 windowScene 이 필요하다.
    /// 실패해도 보조 동작이라 조용히 무시 — 사용자는 App Store 설정으로 직접 갈 수 있다.
    @MainActor
    private func openManageSubscriptions() async {
        let scene = UIApplication.shared.connectedScenes
            .first { $0.activationState == .foregroundActive } as? UIWindowScene
            ?? UIApplication.shared.connectedScenes.first as? UIWindowScene
        guard let scene else { return }
        try? await AppStore.showManageSubscriptions(in: scene)
    }

    /// 언어 override 적용. nil = 시스템 언어로 되돌리기 (AppleLanguages 키 제거).
    /// non-nil = 그 단일 BCP-47 코드만 priority list 로 박는다. 다음 부팅에 모든
    /// localizedString lookup 이 이 코드를 우선 본다.
    @MainActor
    private func applyLanguage(_ code: String?) {
        if let code {
            UserDefaults.standard.set([code], forKey: "AppleLanguages")
        } else {
            UserDefaults.standard.removeObject(forKey: "AppleLanguages")
        }
        UserDefaults.standard.synchronize()
        showLanguageRestartAlert = true
    }

    /// 페어된 Mac 앱에 업데이트를 원격 트리거. daemon (`/api/admin/trigger-update`) 이 부모
    /// (Mac 앱) 에 SIGUSR1 을 보낸다.
    ///
    /// Mac 앱이 «사일런트 강제 업데이트» (`silent_update_v1`) 를 지원하면 — Mac 화면에 창
    /// 하나 안 띄우고 다운로드 → .app 교체 → relaunch 까지 무인 진행한다. 트리거 후
    /// `pollUpdateOutcome` 가 결과(완료/최신/실패)를 폴링해서 사용자에게 반영한다.
    ///
    /// 지원하지 않는 옛 Mac 앱은 기존처럼 Sparkle 표준 UI 가 Mac 화면에 뜨므로 그 안내로
    /// 폴백. 옛 daemon (이 라우트 모르는 빌드) 은 404 — Mac 메뉴바에서 직접 확인 안내.
    /// 페어링 끊김 / SSH 미연결 등 다른 실패도 같은 alert 에 사람 읽을 수 있게 surface.
    @MainActor
    private func triggerMacUpdate() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        let supportsSilent = daemonCapabilities.contains("silent_update_v1")
        let versionBefore = daemonVersion
        do {
            try await api.triggerMacUpdate()
            if supportsSilent {
                updateInProgress = true
                updateTriggerResult = .silentStarted
                Task { await pollUpdateOutcome(versionBefore: versionBefore) }
            } else {
                // 옛 Mac 앱 — 사일런트 미지원. Mac 화면의 Sparkle UI 확인 안내로 폴백.
                updateTriggerResult = .legacyStarted
            }
        } catch ApiError.httpStatus(404, _) {
            updateTriggerResult = .failure(
                String(localized: "이 Mac 앱은 원격 업데이트 기능을 지원하지 않는 옛 버전입니다. Mac 메뉴바에서 직접 «업데이트 확인» 을 눌러 주세요.")
            )
        } catch {
            let msg = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            updateTriggerResult = .failure(msg)
        }
    }

    /// 사일런트 강제 업데이트 결과 폴링. `/api/version` 을 주기적으로 다시 읽어:
    ///   - daemonVersion 이 트리거 전보다 ↑      → «업데이트 완료» (설치 + 재시작 성공)
    ///   - lastUpdate.state == "no_update"        → «이미 최신»
    ///   - lastUpdate.state == "error"            → «업데이트 실패: …»
    ///   - 제한 시간 초과                          → 폴백 안내
    ///
    /// relaunch 동안 SSH 가 잠깐 끊기므로 호출 실패는 무시하고 재시도. daemon 이 트리거
    /// 시점에 직전 결과를 비우므로 (`clearUpdateStatus`), 여기서 보이는 `lastUpdate` 는
    /// 반드시 이번 트리거 결과 — 폰/Mac 간 시계 차이에 의존한 비교가 필요 없다.
    @MainActor
    private func pollUpdateOutcome(versionBefore: String?) async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard updateInProgress else { return }  // 이미 처리됐거나 취소됨
            guard let info = try? await api.getServerVersion(label: nil) else {
                continue  // 재연결 중 — 재시도
            }
            daemonVersion = info.daemonVersion
            daemonCapabilities = info.capabilities
            if let before = versionBefore,
               SemverCompare.compare(info.daemonVersion, before) > 0 {
                finishUpdate(.completed(info.daemonVersion))
                return
            }
            if let last = info.lastUpdate {
                switch last.state {
                case "no_update":
                    finishUpdate(.alreadyLatest)
                    return
                case "error":
                    finishUpdate(.failed(last.message ?? ""))
                    return
                default:
                    break
                }
            }
        }
        finishUpdate(.timedOut)
    }

    @MainActor
    private func finishUpdate(_ result: UpdateTriggerResult) {
        guard updateInProgress else { return }
        updateInProgress = false
        updateTriggerResult = result
    }
}

/// 커뮤니티 외부 채널. in-app 포럼 대신 공개 repo 의 GitHub Discussions 를 1차 채널로 쓴다
/// (인프라·비용 0). 백엔드 없이 도움받기·공유·버그 제보가 한 곳에서 이뤄진다.
/// SettingsSheet 「커뮤니티」 외에 막힘 상태 뷰의 `StuckHelpLink` 도 같은 URL 을 재사용한다.
enum CommunityLinks {
    static let discussions = URL(string: "https://github.com/Wayne-Kim/pocket-sisyphus/discussions")!
}

/// 커뮤니티 SafariView 시트의 목적지 — 일반 「도움받기」 와 「버그 제보」 가 같은 시트를 쓰되
/// URL 만 다르므로 `.sheet(item:)` 로 묶기 위한 식별 가능한 래퍼.
struct CommunityDestination: Identifiable {
    let id = UUID()
    let url: URL
}

/// 「버그 제보」 진단 블록 — 제보 글에 «자동으로» 채워 근원에서 피드백 품질을 올린다.
/// 환영 문서(welcome.md)가 요구하는 «앱 버전(+build)·OS 버전·연결 상태» 를 사용자가 매번
/// 설정을 뒤져 옮겨적지 않게 한다.
///
/// 비밀값은 절대 넣지 않는다 — welcome.md 하우스룰(«비밀값은 절대 붙여넣지 마세요 — SSH 키,
/// 페어링 QR, .onion 주소, 토큰») 과 일치. endpoint 의 host/IP/onion 주소·토큰·키는 식별
/// 자료라 제외하고, 연결 «종류»(SSH/Tor/미연결) 만 노출한다. 알림 미리보기 마스킹(bc17a48)
/// 과 같은 원칙: 외부로 나가는 텍스트엔 민감값을 싣지 않는다.
enum BugReportDiagnostics {
    /// 공개 피드백 repo 의 Discussions 새 글 작성 엔드포인트. CommunityLinks 와 같은 repo.
    private static let discussionsNew = "https://github.com/Wayne-Kim/pocket-sisyphus/discussions/new"

    /// 연결 모드 라벨 — directIPv4/IPv6 → SSH(직접), torOnion → Tor, nil → 미연결.
    /// 미연결(연결 모드 미상)이어도 막지 않고 «미연결» 로 표기한다.
    static func connectionMode(_ type: EndpointEntry.EndpointType?) -> String {
        guard let type else { return String(localized: "미연결") }
        switch type {
        case .directLan: return String(localized: "SSH (LAN 직접)")
        case .directIPv4, .directIPv6: return String(localized: "SSH (직접)")
        case .torOnion: return String(localized: "Tor")
        }
    }

    /// 제보 글에 프리필/클립보드로 넣을 진단 블록(마크다운). 라벨·안내문은 로케일 번역,
    /// 버전/OS 값은 데이터. 버전 소스는 설정 하단 버전 표기와 동일한 Info.plist.
    static func block(connectionType: EndpointEntry.EndpointType?) -> String {
        let info = Bundle.main.infoDictionary
        let marketing = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        let os = UIDevice.current.systemVersion
        let mode = connectionMode(connectionType)

        let reproHeader = String(localized: "무슨 일이 있었나요? (증상과 재현 절차를 적어 주세요)")
        let envHeader = String(localized: "환경 (자동 작성됨)")
        let appLabel = String(localized: "앱 버전")
        let osLabel = String(localized: "iOS 버전")
        let modeLabel = String(localized: "연결 모드")

        // "iOS v0.2.7 (123)" — 설정 하단 버전 라벨과 같은 형식 + build 번호. 값이라 비번역.
        return """
        ## \(reproHeader)



        ---
        ### \(envHeader)
        - \(appLabel): iOS v\(marketing) (\(build))
        - \(osLabel): \(os)
        - \(modeLabel): \(mode)
        """
    }

    /// Discussions 새 글 URL — body(+category·title) 프리필 best-effort.
    ///
    /// GitHub Discussions 는 `?category=<slug>&title=&body=` 프리필을 «대체로» 지원하지만,
    /// GitHub 모바일 앱 핸드오프·카테고리 picker 에서 body 가 누락될 수 있어 «불안정» 하다.
    /// 그래서 호출부가 진단 블록을 클립보드에도 복사하고 토스트로 안내한다(폴백). category 는
    /// Discussions 기본 카테고리 «Q&A»(slug `q-a`) 로 — 막힘/질문/버그는 결국 도움 요청이라
    /// 안전한 기본값. 슬러그가 안 맞아도 클립보드 폴백이 흐름을 잇는다.
    ///
    /// 특수문자/오래된 OS 버전 문자열도 URLComponents 가 percent-encoding 으로 안전 처리한다.
    static func discussionURL(connectionType: EndpointEntry.EndpointType?) -> URL {
        guard var comps = URLComponents(string: discussionsNew) else { return CommunityLinks.discussions }
        comps.queryItems = [
            URLQueryItem(name: "category", value: "q-a"),
            URLQueryItem(name: "title", value: String(localized: "버그 제보")),
            URLQueryItem(name: "body", value: block(connectionType: connectionType)),
        ]
        return comps.url ?? CommunityLinks.discussions
    }
}

/// SFSafariViewController 래퍼 — 외부 링크를 앱 «안» 시트로 띄운다. 시스템 Safari 쿠키를
/// 공유하므로 GitHub 로그인 상태가 그대로 이어져 바로 글을 쓸 수 있다.
struct SafariView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

/// 막힘 상태(연결 실패·부팅 에러·페어링 실패·빈 세션 목록) 화면에 다는 작은 보조 «도움받기» 링크.
///
/// 커뮤니티 탭을 SettingsSheet 외부 링크로 강등한 뒤, 정작 도움이 가장 필요한 마찰 지점
/// (첫 연결 실패·에러 화면)에는 도움 어포던스가 없었다 — 신규 사용자가 설정을 뒤지지 않고
/// 그 자리에서 바로 도움 허브로 가게 한다. 탭 복원이 아니라 «같은 허브로 가는» 보완이다.
///
/// 구현은 SettingsSheet 「커뮤니티」 와 «동일» — 기본 목적지는 `CommunityLinks.discussions`
/// 를 `SafariView`(SFSafariViewController, 시스템 Safari 쿠키 공유)로 띄운다. GitHub 로그인
/// 상태가 그대로 이어져 막힌 그 자리에서 바로 질문을 쓸 수 있다. 새 채널/백엔드 0.
///
/// 연결이 끊긴 막힘 상태여도 이 링크는 폰의 «일반 인터넷» 으로 열린다 — 앱 데이터 plane(daemon
/// /Tor)과 독립이라 daemon 이 안 붙은 상태에서도 동작한다.
///
/// 색은 강조색(accent=보라)이 아니라 secondary 텍스트 링크 — accent 과대사용 금지(색 정책).
/// 막힘 상태에서만 호출부가 조건부로 그리므로 정상 연결 화면에는 노출되지 않는다.
///
/// 페어링/host key 처럼 in-app 보안가이드(`GuideContent`)가 더 맞는 에러에서는 `guideCategory`
/// 를 줘 목적지를 가이드(`GuideView`)로 분기한다.
struct StuckHelpLink: View {
    var label: LocalizedStringKey = "막혔나요? 도움받기"
    /// 설정 시 GitHub Discussions(Safari) 대신 이 카테고리의 in-app 가이드로 분기.
    var guideCategory: String? = nil

    @State private var showHelp = false

    var body: some View {
        Button {
            showHelp = true
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "lifepreserver")
                Text(label)
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $showHelp) {
            if let guideCategory {
                GuideView(initialCategoryId: guideCategory)
            } else {
                SafariView(url: CommunityLinks.discussions)
                    .ignoresSafeArea()
            }
        }
    }
}

/// Mac 앱 원격 업데이트 트리거 결과. 단일 alert 가 모든 케이스를 처리하도록 enum 으로.
private enum UpdateTriggerResult {
    case silentStarted        // 사일런트 강제 업데이트 트리거 성공 — 진행 중 (폴링)
    case legacyStarted        // 옛 Mac 앱 — Sparkle 표준 UI 확인 안내
    case completed(String)    // 새 버전(인자)으로 설치 + 재시작 완료
    case alreadyLatest        // 이미 최신 — 업데이트할 게 없음
    case failed(String)       // daemon 이 보고한 업데이트 실패 (인자 = 사유)
    case timedOut             // 결과 확인 제한 시간 초과
    case failure(String)      // 트리거 자체 실패 (네트워크 / 404 / 503 등)

    var title: String {
        switch self {
        case .silentStarted: return String(localized: "Mac 앱을 강제로 업데이트하고 있어요")
        case .legacyStarted: return String(localized: "Mac 앱 업데이트를 시작합니다")
        case .completed: return String(localized: "Mac 앱 업데이트 완료")
        case .alreadyLatest: return String(localized: "이미 최신 버전이에요")
        case .failed, .failure: return String(localized: "Mac 앱 업데이트 실패")
        case .timedOut: return String(localized: "업데이트 확인을 마쳤어요")
        }
    }

    var message: String {
        switch self {
        case .silentStarted:
            // 무클릭 사일런트 — Mac 화면을 볼 필요 없음. 설치 후 자동 재시작하며 잠시
            // SSH 가 끊겼다가 새 버전으로 자동 재연결된다.
            return String(localized: "Mac 화면을 보지 않아도 돼요. 다운로드·설치 후 자동으로 재시작하고, 잠시 뒤 새 버전으로 다시 연결됩니다.")
        case .legacyStarted:
            // 옛 Mac 앱 — Sparkle 표준 UI 가 Mac 화면에 뜬다. 폰만 보고 있으면 "왜 안 되지"
            // 가 될 수 있어 Mac 화면 확인 유도.
            return String(localized: "Mac 화면에서 Sparkle 의 진행 상황을 확인하세요. 업데이트 도중 잠시 연결이 끊겼다가 자동으로 복구됩니다.")
        case .completed(let v):
            return String(localized: "Mac 앱이 v\(v) 으로 업데이트되어 다시 연결됐어요.")
        case .alreadyLatest:
            return String(localized: "Mac 앱이 이미 최신 버전이라 업데이트할 게 없어요.")
        case .failed(let reason):
            return reason.isEmpty
                ? String(localized: "Mac 앱 업데이트 중 문제가 발생했어요. 잠시 후 다시 시도해 주세요.")
                : String(localized: "Mac 앱 업데이트 중 문제가 발생했어요: \(reason)")
        case .timedOut:
            return String(localized: "업데이트가 진행 중이거나 새 버전으로 곧 다시 연결됩니다. 잠시 후 설정에서 Mac 버전을 확인해 주세요.")
        case .failure(let m):
            return m
        }
    }
}
