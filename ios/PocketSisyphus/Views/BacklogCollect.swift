import SwiftUI
import UIKit  // UIPasteboard — gh 설치/로그인 한 줄 명령 복사

/// «지금 수집» 흐름 — 레포 선택·조사 프로필 폼·설정·gh/asc 안내·신호 결과 카드.
/// 원래 BacklogView.swift 안에 private 으로 있던 것을 동작 그대로(접근 수준만 private→internal) 옮긴 것 — 행동보존 추출. 색·문자열·레이아웃 그대로.
/// «지금 수집» 2단계 «빠른 수집» 면 — 사용자가 가장 먼저 하려는 «전문가 고르고 → 시키기» 만
/// 노출한다: 전문가 관점(일회성) + 이번 지시(일회성) + 에이전트(일회성) + 수집 시작. 이 레포에
/// 영속되는 조사 설정(조사 방식·주기·스토어 리뷰·피드백 repo·디자인 규칙)은 «이 레포 조사 설정»
/// (CollectRepoSettingsView)으로 내려 디스클로저로 점진 노출한다. 빠른 경로는 daemon capability
/// 가 없어도(옛 daemon) 그대로 동작한다 — 영속 설정 저장은 설정 면이 전담한다.
struct CollectProfileForm: View {
    let repoPath: String
    let supportsSchedule: Bool
    let supportsAsc: Bool
    let supportsFeedbackRepo: Bool
    let supportsDesignBootstrap: Bool
    let supportsCollectLens: Bool
    /// daemon 이 «보안» 수집 렌즈(po_collect_lens_v2)까지 지원하는가 — security 옵션 게이팅.
    let supportsSecurityCollectLens: Bool
    /// daemon 이 수집 전문가 «11종 전체»(po_collect_lens_v3)를 지원하는가 — 11종 노출 게이팅.
    let supportsAllExpertsCollectLens: Bool
    let agents: [AgentInfo]
    let onStart: (String, String?, String?, String?) -> Void
    /// 통합 «만들기» 폼의 «어디서 찾을까» 토글 — 첫 섹션의 BriefSourcePicker 가 바꾼다.
    @Binding var source: BriefSource

    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker
    private var api: ApiClient { ApiClient(auth: auth, conn: conn, tracker: inflight) }

    @State private var agentId = AgentInfo.claudeCodeFallback.id
    /// 전문가 관점 — "default" 전방위 / "design" UI 디자인 부채 발굴 / "bug" 디버깅·신뢰성 신호 우선 /
    /// "security" 인증·키 취급·노출면·자격증명·위협모델 신호 우선(po_collect_lens_v2). 리서치 픽커와
    /// «같은 명칭·같은 카탈로그 키»(전문가 관점)를 써 사용자가 하나의 전문가 개념으로 인지한다. 이번
    /// 수집에만 적용되는 일회성 선택이라 프로필에 저장하지 않는다 (에이전트 픽커와 동형 — 주기 수집의
    /// 고정 렌즈는 «이 레포 조사 설정» 에서 따로 정한다).
    @State private var lens = "default"
    @State private var instruction = ""
    @State private var starting = false
    /// 주기 수집(po_schedule_v1) — «이 레포 조사 설정» 과 «같은 프로필»(po profile)을 읽고/쓴다
    /// (단일 원천, 두 자리가 같은 값을 본다). 빠른 수집 그 자리에서 바로 켜 «손으로 매번 다시
    /// 수집» 부담을 없애 검증 루프·성적표를 살리는 게 목적이다. supportsSchedule 일 때만 노출.
    @State private var profileLoaded = false
    @State private var loadedProfile: PoProfile?
    @State private var scheduleEnabled = false
    @State private var savedSchedule: String?
    @State private var scheduleTime = Calendar.current.date(
        bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()

    var body: some View {
        List {
            BriefSourcePicker(source: $source)
            if supportsCollectLens {
                Section {
                    // 기본 컨트롤 — 색 안 정함 → AccentColor(보라) 자동. 콘텐츠에 .tint() 안 건다.
                    // «보안» 도 다른 렌즈와 같은 시각 위계(중립 칩 + accent 선택 체크) — 경고/위험색 안 씀.
                    Picker(selection: $lens) {
                        ForEach(
                            poCollectLenses(
                                security: supportsSecurityCollectLens,
                                allExperts: supportsAllExpertsCollectLens), id: \.self
                        ) { id in
                            Text(poResearchLensName(id)).tag(id)
                        }
                    } label: {
                        Text("전문가 관점")
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    .accessibilityLabel(Text("전문가 관점"))
                } header: {
                    Text("전문가 관점")
                } footer: {
                    if supportsAllExpertsCollectLens {
                        Text("수집을 맡길 전문가를 골라요. 고른 전문가가 그 관점으로 신호를 모아 «직접» 브리프를 써요 — 예를 들어 «보안» 은 노출·악용 위험을, «디자인» 은 디자인 부채(접근성·대비·토큰 드리프트)를, «디버깅» 은 크래시·재현 버그·회귀를 우선 봐요. 이번 수집에만 적용돼요.")
                    } else if supportsSecurityCollectLens {
                        Text("수집을 맡길 전문가 관점을 골라요. «디자인» 은 코드 기능 대신 이 레포 UI 의 디자인 부채(접근성·대비·토큰 드리프트·패턴 불일치)를, «디버깅» 은 크래시·실패 로그·재현 버그·회귀 같은 신뢰성 신호를, «보안» 은 인증·키 취급·네트워크 노출면·자격증명 흐름·위협모델 대비 같은 보안 신호를 우선 모아 증거와 함께 브리프로 올려요. 이번 수집에만 적용돼요.")
                    } else {
                        Text("수집을 맡길 전문가 관점을 골라요. «디자인» 은 코드 기능 대신 이 레포 UI 의 디자인 부채(접근성·대비·토큰 드리프트·패턴 불일치)를, «디버깅» 은 크래시·실패 로그·재현 버그·회귀 같은 신뢰성 신호를 우선 모아 증거와 함께 브리프로 올려요. 이번 수집에만 적용돼요.")
                    }
                }
            }
            Section {
                // 긴 자연어 지시라 키보드 마찰이 큰 자리 — 받아쓰기(온디바이스 Whisper) 마이크를 붙인다.
                VoiceInputField(
                    "예: 온보딩 개선 아이디어 위주로 / 다크모드 지원을 브리프로 정리해줘",
                    text: $instruction,
                    lineLimit: 2...5,
                )
            } header: {
                Text("이번 지시 (선택)")
            } footer: {
                Text("이번 수집에만 적용돼요. 조사 방식보다 우선해요.")
            }
            if !agents.isEmpty {
                PoAgentSection(agents: agents, selection: $agentId) {
                    // 주기 수집(매일 자동)은 daemon 이 기본 에이전트로 돌므로 범위를 명시한다.
                    Text("이번 수집에만 적용돼요.")
                }
            }
            // 매일 자동 수집 — «이 레포 조사 설정» 에도 있는 같은 토글을 «빠른 수집» 자리로 끌어올린
            // 것(같은 프로필을 읽고/쓰는 단일 원천). 첫 수집 그 자리에서 바로 켤 수 있어, 손으로 매번
            // 다시 수집하는 부담 없이 검증 루프·성적표가 살아난다. footer 가 «가벼운 안내» 를 겸한다.
            if supportsSchedule {
                Section {
                    Toggle("매일 자동 수집", isOn: $scheduleEnabled)
                    if scheduleEnabled {
                        DatePicker(
                            "시각",
                            selection: $scheduleTime,
                            displayedComponents: .hourAndMinute,
                        )
                    }
                } header: {
                    Text("주기 수집")
                } footer: {
                    Text("자는 동안 에이전트가 신호를 모아 두면 아침에 폰에서 결재만 하면 돼요 (Mac 시간대 기준). 같은 레포를 다시 수집하면 지난 제안이 «검증됨/빗나감» 으로 채점돼 성적표가 채워져요.")
                }
            }
            // 영속 «이 레포 조사 설정» 은 디스클로저로 내려 점진 노출 — 처음엔 접힘. 진입 컨트롤은
            // accent(보라) gear 아이콘. repoPath String 목적지(navigationDestination)와 겹치지 않게
            // 값이 아닌 «클로저형» NavigationLink 로 push 한다.
            Section {
                NavigationLink {
                    CollectRepoSettingsView(
                        repoPath: repoPath, supportsSchedule: supportsSchedule,
                        supportsAsc: supportsAsc, supportsFeedbackRepo: supportsFeedbackRepo,
                        supportsDesignBootstrap: supportsDesignBootstrap,
                        supportsCollectLens: supportsCollectLens,
                        supportsSecurityCollectLens: supportsSecurityCollectLens,
                        supportsAllExpertsCollectLens: supportsAllExpertsCollectLens)
                } label: {
                    Label {
                        Text("이 레포 조사 설정")
                    } icon: {
                        Image(systemName: "gearshape")
                            .foregroundStyle(Theme.accent)
                    }
                }
                .accessibilityLabel(Text("이 레포 조사 설정 열기"))
            } footer: {
                Text("조사 방식·주기·스토어 리뷰·피드백 repo·디자인 규칙을 정해요. 프로젝트에 저장돼 매 수집에 재사용돼요.")
            }
            Section {
                Button {
                    start()
                } label: {
                    if starting {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Text("수집 시작").frame(maxWidth: .infinity)
                    }
                }
                .disabled(starting)
            }
        }
        .navigationTitle(Text(verbatim: (repoPath as NSString).lastPathComponent))
        .navigationBarTitleDisplayMode(.inline)
        // 이번 지시 입력란의 마이크 받아쓰기 공통 크롬.
        .voiceDictationChrome()
        // 주기 수집은 «이 레포 조사 설정» 과 같은 프로필을 읽고/쓴다 — 진입 시 현재 값을 채우고,
        // 토글/시각이 바뀌면 그때그때 저장한다 (설정 면의 saveSideSettingsIfChanged 와 동형).
        .task { await loadProfileForSchedule() }
        .onChange(of: scheduleEnabled) { _ in Task { await saveScheduleIfChanged() } }
        .onChange(of: scheduleTime) { _ in Task { await saveScheduleIfChanged() } }
    }

    /// 주기 수집 현재 값 로드 — 같은 po profile 을 읽어 토글/시각을 채운다 (단일 원천).
    /// supportsSchedule 아니면 건너뛴다. 한 번만 로드 (profileLoaded 가드).
    private func loadProfileForSchedule() async {
        guard supportsSchedule, !profileLoaded else { return }
        if let p = try? await api.getPoProfile(repoPath: repoPath) {
            loadedProfile = p
            savedSchedule = p.schedule
            if let cron = p.schedule, let t = Self.timeFromCron(cron) {
                scheduleEnabled = true
                scheduleTime = t
            }
        }
        profileLoaded = true
    }

    /// 토글/시각 → 5필드 cron 식 ("분 시 * * *"). 꺼짐이면 nil.
    private var scheduleCron: String? {
        guard scheduleEnabled else { return nil }
        let c = Calendar.current.dateComponents([.hour, .minute], from: scheduleTime)
        return "\(c.minute ?? 0) \(c.hour ?? 9) * * *"
    }

    /// «매일 HH:mm»("m h * * *") cron → 오늘 그 시각 Date. 다른 형태는 nil.
    private static func timeFromCron(_ cron: String) -> Date? {
        let parts = cron.split(separator: " ")
        guard parts.count == 5, parts[2] == "*", parts[3] == "*", parts[4] == "*",
            let minute = Int(parts[0]), let hour = Int(parts[1])
        else { return nil }
        return Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: Date())
    }

    /// schedule 만 바뀌었을 때 PUT — 나머지 프로필 필드(조사 방식·스토어 리뷰·피드백 repo·주기
    /// 렌즈)는 로드한 값 그대로 보존해 «빠른 자리 토글» 이 다른 설정을 덮어쓰지 않게 한다.
    private func saveScheduleIfChanged() async {
        guard profileLoaded, let p = loadedProfile else { return }
        let cron = scheduleCron
        guard cron != savedSchedule else { return }
        if (try? await api.setPoProfile(
            repoPath: repoPath, directive: p.directive, schedule: cron,
            ascAppId: p.ascAppId, githubFeedbackRepo: p.githubFeedbackRepo, lens: p.lens)) != nil
        {
            savedSchedule = cron
        }
    }

    private func start() {
        starting = true
        let inst = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        // 전문가 관점은 daemon 이 지원할 때(supportsCollectLens) «design»/«bug» 선택만 보낸다 —
        // 기본(전방위)/미지원이면 nil 로 필드를 생략해 옛 daemon 동작과 같다 (전방위 수집). route 는
        // 회차 lens 를 항상 explicit 로 다뤄 수동 수집이 픽커가 보여주는 대로 돈다(거짓 UI 방지).
        let chosenLens = (supportsCollectLens && lens != "default") ? lens : nil
        onStart(repoPath, inst.isEmpty ? nil : inst, agents.isEmpty ? nil : agentId, chosenLens)
    }
}

/// «이 레포 조사 설정» — 빠른 수집에서 디스클로저로 내려온 영속 면. 이 레포의 «조사 방식»(프로필),
/// 주기 수집, 스토어 리뷰, GitHub 피드백 repo, 디자인 규칙(디자인 directive 부트스트랩)을 정한다.
/// 모두 프로젝트 자산으로 저장돼 매 수집에 재사용된다 — 1회성 의도(이번 지시·관점·에이전트)와 분리된다.
/// 주기 수집(«매일 아침 수집» 프리셋)도 여기서 켠다 — daemon 이 매일 그 시각에 같은 수집을 자동으로
/// 돈다 (po_schedule_v1 daemon 에서만 노출).
struct CollectRepoSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker

    let repoPath: String
    let supportsSchedule: Bool
    let supportsAsc: Bool
    let supportsFeedbackRepo: Bool
    let supportsDesignBootstrap: Bool
    /// daemon 이 수집 «전문가 관점» 렌즈(po_collect_lens_v1)를 지원하는가 — 주기 수집의 고정 렌즈
    /// 픽커 노출 분기. 미지원이면 픽커를 숨기고 전방위로 동작한다.
    let supportsCollectLens: Bool
    /// daemon 이 «보안» 수집 렌즈(po_collect_lens_v2)까지 지원하는가 — 주기 수집 렌즈 픽커의 security
    /// 옵션 게이팅. 미지원이면 security 를 빼서 거짓 UI 방지(저장돼 있어도 daemon 이 전방위로 폴백).
    let supportsSecurityCollectLens: Bool
    /// daemon 이 수집 전문가 «11종 전체»(po_collect_lens_v3)를 지원하는가 — 주기 수집 픽커 11종 게이팅.
    let supportsAllExpertsCollectLens: Bool

    @State private var profile = ""
    @State private var profileLoaded = false
    /// 프로필 로드 실패 — 느린/끊긴 연결에서 «죽은 화면» 대신 오류 + 재시도 경로를 띄운다.
    @State private var loadFailed = false
    @State private var savedProfile = ""
    @State private var savedSchedule: String?
    @State private var scheduleEnabled = false
    /// 주기 수집 «전문가 관점» 렌즈 (po_collect_lens_v1) — 주기 수집(scheduler)이 매일 어느 초점으로
    /// 신호를 모을지 «고정»해 두는 영속 설정. 수동 수집의 일회성 렌즈(빠른 수집 폼)와 분리된다 —
    /// 회차 선택이 이 값보다 우선(instruction↔directive 와 동형). 프로필에 저장돼 매 주기 수집에 재사용.
    @State private var lens = "default"
    @State private var savedLens = "default"
    /// 주기 수집 시각 — 기본 09:00 («매일 아침 수집» 프리셋). 시각만 의미 (날짜 무시).
    @State private var scheduleTime = Calendar.current.date(
        bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()
    /// 스토어 리뷰 신호 — 켜면 수집 시 이 앱의 최근 App Store 리뷰를 함께 읽는다.
    @State private var savedAscAppId: String?
    @State private var ascEnabled = false
    @State private var ascAppId = ""
    /// Mac 에 ASC API 키가 등록돼 있는가 — 미등록이면 footer 로 Mac 설정 안내.
    @State private var ascKeyConfigured = true
    /// GitHub «피드백 repo» (owner/name) — 사용자 피드백이 모이는 공개 repo. 비면 로컬 origin.
    @State private var savedFeedbackRepo: String?
    @State private var feedbackRepo = ""
    // 디자인 부트스트랩 (po_design_bootstrap_v1) — 에이전트가 디자인 SSOT 를 스캔해 directive 초안을
    // 만들고, 사람이 여기서 검토·승인해야 design_directive(강신호)가 된다. designDirective = 승인된
    // 선언, designDraft = 검토 대기 초안(편집 가능), generatingSession = non-nil 이면 «생성 중».
    @State private var designDirective: String?
    @State private var designDraft: String?
    @State private var designDraftEdit = ""
    @State private var designGeneratingSession: String?
    @State private var designBusy = false

    private var api: ApiClient { ApiClient(auth: auth, conn: conn, tracker: inflight) }

    var body: some View {
        List {
            // 수집이 무엇을 하는지 한 줄로 — 첫 사용자가 «조사 방식» 자유서술 앞에서 멘탈 모델을
            // 잡게 한다. 장식 안내라 status/pro 색을 빌리지 않고 중립 secondary.
            Section {
                HStack(alignment: .top, spacing: Theme.Spacing.m) {
                    Image(systemName: "tray.and.arrow.down")
                        .foregroundStyle(.secondary)
                    Text("수집은 이 레포의 코드·이슈·스토어 리뷰를 훑어 백로그 후보를 제안해요. 무엇을 어떻게 살필지 아래에서 정해 두면 매 수집에 재사용돼요.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
            if loadFailed {
                loadFailedSection
            } else if !profileLoaded {
                loadingSection
            } else {
                formSections
            }
        }
        .navigationTitle("이 레포 조사 설정")
        .navigationBarTitleDisplayMode(.inline)
        // 조사 방식 입력란의 마이크 받아쓰기 공통 크롬.
        .voiceDictationChrome()
        .task { await loadProfile() }
        // 초안 «생성 중» 이면 끝날 때까지 폴링 — generatingSession 이 바뀌면(시작/완료) 재실행/취소.
        // 화면을 떠나면 .task(id:) 가 자동 취소한다.
        .task(id: designGeneratingSession) { await pollDesignIfGenerating() }
        // 주기 수집/스토어 리뷰 토글 변경은 즉시 저장 — «수집 시작» 없이도 켜고 닫을 수 있다.
        .onChange(of: scheduleEnabled) { _ in Task { await saveSideSettingsIfChanged() } }
        .onChange(of: scheduleTime) { _ in Task { await saveSideSettingsIfChanged() } }
        .onChange(of: ascEnabled) { _ in Task { await saveSideSettingsIfChanged() } }
        // 주기 수집 렌즈는 인라인 픽커라 선택 즉시 저장한다 (토글과 동형).
        .onChange(of: lens) { _ in Task { await saveSideSettingsIfChanged() } }
        // 앱 ID 는 타이핑 중 저장하지 않고 입력 종료(키보드 내림/시작)에 맡긴다.
        .onSubmit { Task { await saveSideSettingsIfChanged() } }
        // 조사 방식 텍스트 편집은 빠른 수집 start() 가 더는 저장하지 않으므로, 설정 면을 떠날 때 flush.
        .onDisappear { Task { await saveSideSettingsIfChanged() } }
    }

    // MARK: - 폼 본문 / 로딩·실패 상태

    /// 저장된 조사 설정을 로드 — 처음이면 빈 채로 시작. 실패하면(느린/끊긴 연결) loadFailed 로 올려
    /// 오류 + 재시도 경로를 띄운다. 재시도 버튼이 다시 이 함수를 호출한다.
    private func loadProfile() async {
        loadFailed = false
        do {
            let loaded = try await api.getPoProfile(repoPath: repoPath)
            savedProfile = loaded.directive
            savedSchedule = loaded.schedule
            profile = savedProfile
            if let cron = savedSchedule, let time = Self.timeFromCron(cron) {
                scheduleEnabled = true
                scheduleTime = time
            }
            savedAscAppId = loaded.ascAppId
            if let saved = savedAscAppId, !saved.isEmpty {
                ascEnabled = true
                ascAppId = saved
            }
            ascKeyConfigured = loaded.ascKeyConfigured ?? true
            savedFeedbackRepo = loaded.githubFeedbackRepo
            feedbackRepo = savedFeedbackRepo ?? ""
            // 주기 수집 렌즈 — 옛 daemon 응답엔 키가 없어 nil → "default" (전방위).
            savedLens = loaded.lens ?? "default"
            lens = savedLens
            applyDesignState(loaded)
            profileLoaded = true
        } catch {
            loadFailed = true
        }
    }

    /// 프로필 로드 중 — 입력이 비활성인 «이유» 를 드러내는 폼 수준 스켈레톤. 자리 표시자 박스는
    /// VoiceOver 가 읽지 않게 숨기고, progress 행이 로딩 상태를 안내한다.
    @ViewBuilder private var loadingSection: some View {
        Section {
            VStack(alignment: .leading, spacing: Theme.Spacing.l) {
                ForEach([220, 280, 180], id: \.self) { width in
                    RoundedRectangle(cornerRadius: Theme.Radius.xs)
                        .fill(Color.secondary.opacity(0.15))
                        .frame(width: CGFloat(width), height: 13)
                }
            }
            .padding(.vertical, Theme.Spacing.xs)
            .accessibilityHidden(true)
            HStack(spacing: Theme.Spacing.m) {
                ProgressView().controlSize(.small)
                Text("조사 설정을 불러오는 중…")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(Text("조사 설정을 불러오는 중"))
        } header: {
            Text("조사 방식")
        }
    }

    /// 프로필 로드 실패 — 빈/오류 상태. placeholder 아이콘 + 오류 문구 + 재시도 버튼.
    @ViewBuilder private var loadFailedSection: some View {
        Section {
            VStack(spacing: Theme.Spacing.l) {
                Image(systemName: "wifi.exclamationmark")
                    .font(.system(size: Theme.IconSize.l))
                    .foregroundStyle(.secondary)
                Text("조사 설정을 불러오지 못했어요")
                    .font(.headline)
                Text("Mac 연결을 확인하고 다시 시도하세요.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button {
                    Task { await loadProfile() }
                } label: {
                    Label("다시 시도", systemImage: "arrow.clockwise")
                }
                .accessibilityLabel(Text("조사 설정 다시 불러오기"))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Spacing.xxl)
        }
    }

    /// 로드 완료 후의 실제 설정 폼 — 조사 방식·주기 수집·스토어 리뷰·피드백 repo·디자인.
    @ViewBuilder private var formSections: some View {
        Section {
            VoiceInputField(
                "예: 사용자 이슈·크래시 신호 위주로, UI 제안은 제외",
                text: $profile,
                lineLimit: 3...8,
            )
        } header: {
            Text("조사 방식")
        } footer: {
            Text("프로젝트에 저장돼 매 수집에 재사용돼요. 무엇을 어떻게 조사할지 적어두세요.")
        }
        if supportsSchedule {
            Section {
                Toggle("매일 자동 수집", isOn: $scheduleEnabled)
                if scheduleEnabled {
                    DatePicker(
                        "시각",
                        selection: $scheduleTime,
                        displayedComponents: .hourAndMinute,
                    )
                }
            } header: {
                Text("주기 수집")
            } footer: {
                Text("켜 두면 매일 이 시각에 에이전트가 신호를 수집해 새 브리프를 올려요 (Mac 시간대 기준). 결과는 알림으로 와요.")
            }
        }
        if supportsCollectLens {
            Section {
                // 기본 컨트롤 — 색 안 정함 → AccentColor(보라) 자동. 콘텐츠에 .tint() 안 건다.
                // «보안» 도 다른 렌즈와 같은 시각 위계(중립 칩 + accent 선택 체크) — 경고/위험색 안 씀.
                Picker(selection: $lens) {
                    ForEach(
                        poCollectLenses(
                            security: supportsSecurityCollectLens,
                            allExperts: supportsAllExpertsCollectLens), id: \.self
                    ) { id in
                        Text(poResearchLensName(id)).tag(id)
                    }
                } label: {
                    Text("전문가 관점")
                }
                .pickerStyle(.inline)
                .labelsHidden()
                .accessibilityLabel(Text("전문가 관점"))
            } header: {
                Text("전문가 관점")
            } footer: {
                if supportsAllExpertsCollectLens {
                    Text("주기 수집이 매일 어느 전문가의 관점으로 신호를 모아 브리프를 쓸지 정해요. 프로젝트에 저장돼요 — 수동 수집은 시작할 때 따로 고른 전문가가 우선해요.")
                } else if supportsSecurityCollectLens {
                    Text("주기 수집이 매일 어느 관점으로 신호를 모을지 정해요. «디자인» 은 UI 디자인 부채를, «디버깅» 은 크래시·신뢰성 신호를, «보안» 은 인증·키 취급·노출면·자격증명 흐름·위협모델 대비 신호를 우선 모아요. 프로젝트에 저장돼요 — 수동 수집은 시작할 때 따로 고른 관점이 우선해요.")
                } else {
                    Text("주기 수집이 매일 어느 관점으로 신호를 모을지 정해요. «디자인» 은 UI 디자인 부채를, «디버깅» 은 크래시·신뢰성 신호를 우선 모아요. 프로젝트에 저장돼요 — 수동 수집은 시작할 때 따로 고른 관점이 우선해요.")
                }
            }
        }
        if supportsAsc {
            Section {
                Toggle("App Store 리뷰 포함", isOn: $ascEnabled)
                if ascEnabled {
                    TextField("앱 ID 또는 번들 ID", text: $ascAppId)
                        .font(.callout.monospaced())
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
            } header: {
                Text("스토어 리뷰")
            } footer: {
                if ascEnabled && !ascKeyConfigured {
                    Text("Mac 설정 → App Store 탭에서 ASC API 키를 먼저 등록하세요. 키가 없으면 리뷰 없이 수집돼요.")
                } else {
                    Text("켜 두면 수집할 때 이 앱의 최근 App Store 리뷰를 함께 읽어 사용자 불만·요청을 브리프 근거로 가져와요.")
                }
            }
        }
        if supportsFeedbackRepo {
            Section {
                TextField("owner/name (예: Wayne-Kim/pocket-sisyphus)", text: $feedbackRepo)
                    .font(.callout.monospaced())
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                if let warn = feedbackRepoFormatWarning {
                    // 형식 오류 inline 검증 — warning(노랑)이 맞는 자리 (진짜 «설정 필요»).
                    Label(warn, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(Theme.warning)
                }
            } header: {
                Text("GitHub 피드백 repo")
            } footer: {
                Text("비워 두면 이 레포의 GitHub origin 을 읽어요. 사용자 이슈·Discussions 가 다른 공개 repo 에 모인다면 그 repo 를 owner/name 으로 적으세요 — 다음 수집부터 거기서 피드백을 읽어요. (코드·커밋 신호는 늘 이 레포 기준이에요.)")
            }
        }
        if supportsDesignBootstrap {
            designSection
        }
    }

    // MARK: - 디자인 부트스트랩 (po_design_bootstrap_v1)

    /// 「디자인」 섹션 — design_directive 가 NULL 이면 수집/리서치/워크플로우가 매번 디자인 규칙을
    /// 새로 탐색하는 «약한 신호» 로 떨어진다. 손으로 규칙을 쓰는 건 채택 장벽이라, 에이전트가 레포
    /// 디자인 SSOT 를 읽어 초안을 제안하고 사람이 «승인 한 번» 으로 «선언된 강신호» 를 켠다.
    @ViewBuilder private var designSection: some View {
        Section {
            if designGeneratingSession != nil {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("디자인 규칙을 읽는 중…")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            } else if designDraft != nil {
                Text("검토 대기 초안")
                    .font(.callout.weight(.semibold))
                // 초안 본문은 에이전트 산출(레포 고유 규칙)이라 번역 대상 아님 — verbatim 편집.
                TextEditor(text: $designDraftEdit)
                    .font(.caption.monospaced())
                    .frame(minHeight: 170)
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .background(Color.secondary.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .disabled(designBusy)
                HStack {
                    Button {
                        Task { await approveDesign() }
                    } label: {
                        Label("승인하고 켜기", systemImage: "checkmark.circle")
                    }
                    .disabled(
                        designBusy
                            || designDraftEdit.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Spacer()
                    // 버리기는 해제 동작 — 강조색 아닌 중립(primary). 선언(design_directive)은 안 건드림.
                    Button(role: .destructive) {
                        Task { await discardDesignDraft() }
                    } label: {
                        Text("버리기")
                    }
                    .tint(.primary)
                    .disabled(designBusy)
                }
            } else if let declared = designDirective {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.seal.fill")
                        .foregroundStyle(Theme.success)
                    Text("디자인 규칙이 선언됐어요")
                        .font(.callout.weight(.semibold))
                }
                Text(verbatim: declared)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(6)
                Button {
                    Task { await generateDesignDraft() }
                } label: {
                    if designBusy {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("초안 다시 만들기", systemImage: "arrow.clockwise")
                    }
                }
                .disabled(designBusy)
            } else {
                Button {
                    Task { await generateDesignDraft() }
                } label: {
                    if designBusy {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Label("디자인 초안 만들기", systemImage: "wand.and.stars")
                            .frame(maxWidth: .infinity)
                    }
                }
                .disabled(designBusy)
            }
        } header: {
            Text("디자인")
        } footer: {
            designFooter
        }
    }

    @ViewBuilder private var designFooter: some View {
        if designGeneratingSession != nil {
            Text("에이전트가 이 레포의 색·간격·금지 패턴·지원 언어를 읽어 초안을 만들고 있어요. 세션 탭에서 과정을 볼 수 있어요.")
        } else if designDraft != nil {
            Text("에이전트가 만든 초안이에요. 검토하고 필요하면 고친 뒤 «승인» 하면, 이후 수집·리서치·워크플로우가 이 규칙을 강한 신호로 따라요. 승인 전엔 적용되지 않아요.")
        } else if designDirective != nil {
            Text("승인된 디자인 규칙을 강한 신호로 쓰고 있어요. 규칙이 바뀌었으면 초안을 다시 만들어 갱신하세요.")
        } else {
            Text("손으로 규칙을 쓰지 않아도 돼요 — 에이전트가 이 레포의 디자인 토큰·i18n 카탈로그·디자인 문서를 읽어 규칙 초안을 제안해요. 승인하면 수집·리서치가 따르는 «강한 신호» 가 켜져요 (승인 전엔 적용 안 됨).")
        }
    }

    /// 로드/폴링 결과를 디자인 상태에 반영 — 새 초안이 오면 편집 버퍼도 초기화.
    private func applyDesignState(_ p: PoProfile) {
        designDirective = p.designDirective
        designGeneratingSession = p.designDirectiveDraftSessionId
        if p.designDirectiveDraft != designDraft {
            designDraft = p.designDirectiveDraft
            designDraftEdit = p.designDirectiveDraft ?? ""
        }
    }

    /// «생성 중» 이면 끝날 때까지 ~2s 폴링 — 초안이 도착하면 화면이 검토 UI 로 전환된다.
    private func pollDesignIfGenerating() async {
        guard designGeneratingSession != nil else { return }
        while !Task.isCancelled, designGeneratingSession != nil {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if Task.isCancelled { return }
            guard let loaded = try? await api.getPoProfile(repoPath: repoPath, label: nil) else {
                continue
            }
            applyDesignState(loaded)
        }
    }

    private func generateDesignDraft() async {
        designBusy = true
        defer { designBusy = false }
        // 시작 시 generatingSession 이 채워지면 .task(id:) 가 폴링을 건다.
        if let sid = try? await api.startPoDesignBootstrap(repoPath: repoPath) {
            designDraft = nil
            designGeneratingSession = sid
        }
    }

    private func approveDesign() async {
        let edited = designDraftEdit.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !edited.isEmpty else { return }
        designBusy = true
        defer { designBusy = false }
        if (try? await api.approvePoDesignDirective(repoPath: repoPath, directive: edited)) != nil {
            designDirective = edited
            designDraft = nil
            designDraftEdit = ""
        }
    }

    private func discardDesignDraft() async {
        designBusy = true
        defer { designBusy = false }
        if (try? await api.discardPoDesignDraft(repoPath: repoPath)) != nil {
            designDraft = nil
            designDraftEdit = ""
        }
    }

    /// 현재 토글/입력 → 저장할 ascAppId (꺼짐 또는 빈 입력이면 nil).
    private var ascValue: String? {
        guard ascEnabled else { return nil }
        let trimmed = ascAppId.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// 현재 입력 → 저장할 피드백 repo (빈 입력이면 nil = 로컬 origin).
    private var feedbackRepoValue: String? {
        let trimmed = feedbackRepo.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// owner/name 형식인가 — 슬래시 정확히 하나, 각 세그먼트는 GitHub 허용 문자만. daemon
    /// parseFeedbackRepo 와 같은 규칙 (저장 전 inline 검증으로 400 왕복을 줄인다).
    private var feedbackRepoFormatValid: Bool {
        guard let v = feedbackRepoValue else { return true }  // 빈 값 = 유효(로컬 origin)
        return v.range(of: "^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$", options: .regularExpression) != nil
    }

    /// 형식 오류 안내 문구 (유효하거나 비었으면 nil → 표시 안 함).
    private var feedbackRepoFormatWarning: LocalizedStringKey? {
        feedbackRepoFormatValid ? nil : "owner/name 형식으로 적어주세요 (예: Wayne-Kim/pocket-sisyphus)"
    }

    /// 현재 토글/시각 → 5필드 cron 식 ("분 시 * * *"). 꺼짐이면 nil.
    private var scheduleCron: String? {
        guard scheduleEnabled else { return nil }
        let c = Calendar.current.dateComponents([.hour, .minute], from: scheduleTime)
        return "\(c.minute ?? 0) \(c.hour ?? 9) * * *"
    }

    /// «매일 HH:mm» 형태("m h * * *")의 cron 식 → 오늘 그 시각 Date. 다른 형태는 nil
    /// (수동으로 더 복잡한 식을 넣었다면 토글 UI 로는 표현 못 함 — 끔으로 보이게 둔다).
    private static func timeFromCron(_ cron: String) -> Date? {
        let parts = cron.split(separator: " ")
        guard parts.count == 5, parts[2] == "*", parts[3] == "*", parts[4] == "*",
              let minute = Int(parts[0]), let hour = Int(parts[1]) else { return nil }
        return Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: Date())
    }

    /// 토글/시각/앱 ID/피드백 repo/조사 방식 텍스트가 저장값과 다르면 PUT — 조사 방식 텍스트도
    /// 함께 저장된다(빠른 수집 start() 가 더는 프로필을 저장하지 않으므로 이 면이 전담). 피드백 repo
    /// 형식이 잘못됐으면 저장하지 않는다 (inline 경고만 — 400 왕복 방지).
    private func saveSideSettingsIfChanged() async {
        guard profileLoaded else { return }
        let cron = scheduleCron
        let asc = ascValue
        let fb = feedbackRepoValue
        let trimmed = profile.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cron != savedSchedule || asc != savedAscAppId || fb != savedFeedbackRepo
            || trimmed != savedProfile || lens != savedLens else { return }
        guard feedbackRepoFormatValid else { return }
        if (try? await api.setPoProfile(
            repoPath: repoPath, directive: trimmed, schedule: cron, ascAppId: asc,
            githubFeedbackRepo: fb, lens: lens)) != nil {
            savedSchedule = cron
            savedAscAppId = asc
            savedFeedbackRepo = fb
            savedProfile = trimmed
            savedLens = lens
        }
    }
}

// MARK: - gh 안내 (po_gh_check_v1)

/// 수집 직후 «GitHub 신호 없이 수집됨» 안내 (po_gh_check_v1). welcome.md 가 모든 사용자
/// 피드백을 GitHub Discussions 로 모으므로, gh 가 없으면 «가장 풍부한 사용자 목소리» 가 PO
/// 루프에 안 들어온다 — 사용자가 모른 채 «제안이 영 별로» 라고 오해하지 않게 표면화한다.
/// 경고가 «아니라» 안내 톤 — 중립/secondary 색(warning 노랑 금지), 명령은 코드라 Text(verbatim:).
/// gh 가 정상이면 호출처가 이 뷰를 아예 안 띄운다 (정상 케이스 잡음 금지).
struct CollectGhNoticeRow: View {
    let gh: GhCollectCheck
    /// 어느 프로젝트의 수집이었는지 — repoPath 의 디렉토리명. «전체» 필터에서 모호함을 없앤다.
    let repoName: String?
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                // info.circle — 안내 톤. warning 삼각형 아님. 색도 중립 secondary.
                Image(systemName: "info.circle")
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Text("GitHub 신호 없이 수집됐어요")
                        .font(.callout.weight(.semibold))
                    // 어느 프로젝트의 수집이었는지 — 레포명은 식별자라 verbatim(번역 대상 아님).
                    // folder 아이콘은 프로젝트 picker(Label("프로젝트", "folder"))와 같은 관례.
                    if let repoName {
                        HStack(spacing: 4) {
                            Image(systemName: "folder")
                            Text(verbatim: repoName)
                        }
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    }
                    // ternary 가 아니라 분기된 Text — 각 한국어 리터럴이 카탈로그 추출 경로를 탄다.
                    // 세 갈래: ① 피드백 repo 접근 불가(설치·인증은 정상) ② 미인증 ③ 미설치.
                    Group {
                        if gh.feedbackRepoUnreadable {
                            // 거짓 «설정 필요» 가 아니라 «접근 불가» 안내 — gh 자체는 정상.
                            Text("설정한 GitHub 피드백 repo 를 못 읽었어요. private repo 라면 권한 있는 계정으로 로그인했는지, repo 이름(owner/name)이 맞는지 확인하세요.")
                        } else if gh.installedButUnauthed {
                            Text("이 Mac 의 GitHub CLI(gh)가 로그인돼 있지 않아 이슈·Discussions 를 못 읽었어요. Mac 터미널에서 아래를 실행하면 다음 수집부터 더 좋은 브리프를 받아요.")
                        } else {
                            Text("이 Mac 에 GitHub CLI(gh)가 없어 이슈·Discussions 를 못 읽었어요. Mac 터미널에서 아래를 실행하면 다음 수집부터 더 좋은 브리프를 받아요.")
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Button {
                    onDismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("안내 닫기"))
            }
            // 명령 — 접근 불가(gh 정상)면 그 repo 를 직접 확인하는 명령, 미설치면 설치 + 로그인,
            // 설치됐는데 미인증이면 로그인만 (엣지 구분 안내). repo 명령은 식별자라 verbatim.
            if gh.feedbackRepoUnreadable {
                if let repo = gh.feedbackRepo {
                    CopyableCommandRow(command: "gh repo view \(repo)")
                }
            } else {
                if !gh.installed {
                    CopyableCommandRow(command: "brew install gh")
                }
                CopyableCommandRow(command: "gh auth login")
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - asc 안내 (po_asc_check_v1)

/// 수집 직후 «App Store 신호 없이 수집됨» 안내 (po_asc_check_v1). 리뷰(po_asc_v1)·크래시
/// (po_crash_v1)는 같은 ASC 키를 공유하므로, 키가 «저장 후» 만료·폐기되면 둘 다 0이 되는데
/// executor 가 섹션을 조용히 생략해 사용자가 모른다 — gh 와 똑같이 표면화한다. gh 와 달리 수정은
/// 터미널 명령이 아니라 Mac 앱 설정(App Store 탭)이라 복사 명령 없이 안내 문구만 둔다.
/// 경고가 «아니라» 안내 톤 — 중립/secondary 색(warning 노랑 금지). 정상/꺼짐이면 호출처가 안 띄움.
struct CollectAscNoticeRow: View {
    let asc: AscCollectCheck
    /// 어느 프로젝트의 수집이었는지 — repoPath 의 디렉토리명. «전체» 필터에서 모호함을 없앤다.
    let repoName: String?
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            // info.circle — 안내 톤. warning 삼각형 아님. 색도 중립 secondary.
            Image(systemName: "info.circle")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text("App Store 신호 없이 수집됐어요")
                    .font(.callout.weight(.semibold))
                // 어느 프로젝트의 수집이었는지 — 레포명은 식별자라 verbatim(번역 대상 아님).
                // folder 아이콘은 프로젝트 picker(Label("프로젝트", "folder"))와 같은 관례.
                if let repoName {
                    HStack(spacing: 4) {
                        Image(systemName: "folder")
                        Text(verbatim: repoName)
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
                // ternary 가 아니라 분기된 Text — 각 한국어 리터럴이 카탈로그 추출 경로를 탄다.
                // 두 갈래: ① 키 미설정(등록 유도) ② 키 만료·폐기·권한(키 재확인 유도).
                Group {
                    if asc.keyMissing {
                        Text("Mac 에 App Store Connect API 키가 없어 리뷰·크래시 신호를 못 읽었어요. Mac 앱 설정의 App Store 탭에서 키를 등록하면 다음 수집부터 더 좋은 브리프를 받아요.")
                    } else {
                        Text("App Store Connect API 키가 만료·폐기됐거나 권한이 부족해 리뷰·크래시 신호를 못 읽었어요. Mac 앱 설정의 App Store 탭에서 키를 다시 확인하세요.")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Button {
                onDismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("안내 닫기"))
        }
        .padding(.vertical, 4)
    }
}

// MARK: - 수집 결과 카드 (po_signal_status_v1)

/// 수집 «1회» 가 끝난 뒤, 켠 App Store 신호(스토어 리뷰 + 크래시)가 실제로 반영됐는지(used N)·
/// 정상 빈(empty)·키/네트워크로 빠졌는지(실패)를 신호원별로 보여 준다. asc-check 의 «수집 직전
/// 프로브» 안내(CollectAscNoticeRow)와 달리 이건 실행 결과라 used·app id·네트워크까지 구분한다.
/// 색 정책: «실패/설정 필요» 만 warning(노랑), 정상(used/empty)은 중립 .secondary — status 색을
/// 장식으로 빌려쓰지 않는다. 신호 안 켰으면 호출처가 아예 안 띄운다(잡음 금지).
struct CollectSignalsCard: View {
    let signals: CollectSignals
    /// 어느 프로젝트의 수집이었는지 — repoPath 의 디렉토리명. «전체» 필터에서 모호함을 없앤다.
    let repoName: String?
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            // 실패가 하나라도 있으면 warning 삼각형(노랑), 아니면 중립 체크(.secondary).
            Image(systemName: signals.hasFailure ? "exclamationmark.triangle" : "checkmark.circle")
                .foregroundStyle(signals.hasFailure ? Theme.warning : Color.secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text("수집 결과 · App Store 신호")
                    .font(.callout.weight(.semibold))
                // 레포명은 식별자라 verbatim(번역 대상 아님) — folder 아이콘은 프로젝트 picker 관례.
                if let repoName {
                    HStack(spacing: 4) {
                        Image(systemName: "folder")
                        Text(verbatim: repoName)
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
                // 신호원별 한 줄 — 둘은 독립(한쪽만 실패할 수 있다). off/unknown 은 «안 켬» 이라 생략.
                SignalSourceLine(label: storeLabel, source: signals.store)
                SignalSourceLine(label: crashLabel, source: signals.crash)
            }
            Spacer(minLength: 0)
            Button {
                onDismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("안내 닫기"))
        }
        .padding(.vertical, 4)
    }

    private var storeLabel: LocalizedStringKey { "스토어 리뷰" }
    private var crashLabel: LocalizedStringKey { "크래시" }
}

/// 한 신호원의 결과 한 줄. used(N)/empty 는 중립(.secondary), 실패 4종은 warning(노랑) 텍스트.
/// off/unknown(안 켬/모름)은 빈 뷰 — 카드에서 행 자체가 안 보인다 (거짓 경고 금지).
struct SignalSourceLine: View {
    let label: LocalizedStringKey
    let source: SignalSourceState

    var body: some View {
        switch source.state {
        case .off, .unknown:
            EmptyView()
        default:
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(label)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                detail
                    .font(.caption)
                    .foregroundStyle(source.isFailure ? Theme.warning : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(accessibilityText)
        }
    }

    /// 상태별 사용자 문구 — ternary 가 아니라 분기된 Text 로 각 한국어 리터럴이 카탈로그 추출 경로를 탄다.
    private var detail: Text {
        switch source.state {
        case .used:
            // 보간 \(count) 자동 추출 (%lld). used 면 count 는 항상 채워진다.
            return Text("\(source.count ?? 0)건 반영됨")
        case .empty:
            return Text("새 데이터 없음")
        case .keyMissing:
            return Text("키 미설정 — Mac 설정에서 등록 필요")
        case .auth:
            return Text("키 만료·권한 오류 — Mac 설정에서 키 확인")
        case .appId:
            return Text("앱 ID 오류 — Mac 설정에서 앱 ID 확인")
        case .network:
            return Text("네트워크 오류 — 다음 수집에서 다시 시도")
        case .off, .unknown:
            return Text(verbatim: "")
        }
    }

    /// VoiceOver 용 — «신호원 + 상태» 를 한 문장으로. 실패는 «설정 필요» 뉘앙스가 detail 에 이미 담긴다.
    private var accessibilityText: Text {
        Text(label) + Text(verbatim: ", ") + detail
    }
}

struct CopyableCommandRow: View {
    let command: String
    @State private var copied = false

    var body: some View {
        HStack(spacing: 8) {
            Text(verbatim: command)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                copy()
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.caption)
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
    }

    private func copy() {
        UIPasteboard.general.string = command
        withAnimation { copied = true }
        Task {
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            withAnimation { copied = false }
        }
    }
}
