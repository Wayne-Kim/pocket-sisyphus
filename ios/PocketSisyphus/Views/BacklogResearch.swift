import SwiftUI

/// 리서치 — 렌즈 집합/명칭 헬퍼·렌즈 칩·리서치 행/보고서·요청 시트·주제 폼.
/// 원래 BacklogView.swift 안에 private 으로 있던 것을 동작 그대로(접근 수준만 private→internal) 옮긴 것 — 행동보존 추출. 색·문자열·레이아웃 그대로.
// MARK: - 리서치

/// 수집 «전문가 관점» 렌즈가 노출하는 집합 — v1(po_collect_lens_v1)에선 전방위·디자인·디버깅 3개,
/// v2(po_collect_lens_v2)면 «보안» 추가, v3(po_collect_lens_v3)면 리서치와 «같은» 전문가 11종 전체
/// (qa/pm/marketing/analytics/ops/logic/ux 까지). capability 로 한 단계씩 게이팅하는 이유: 그 렌즈를
/// 모르는 옛 daemon 에 보내면 collectLensHeadmatter 가 빈 문자열을 돌려 parseLens 가 통과시킨 값이
/// 전방위로 조용히 폴백 → «거짓 UI» 가 된다 (리서치 렌즈 v2~v9 게이팅과 동형). 표시명은
/// poResearchLensName 을 그대로 재사용해 리서치와 «같은 명칭·같은 카탈로그 키» 로 통일하고, v3 의 11종
/// 순서도 poResearchLenses 의 canonical 순서를 그대로 쓴다 (중복 정의 금지).
func poCollectLenses(security: Bool, allExperts: Bool) -> [String] {
    if allExperts {
        // readability 는 «리서치 전용» 렌즈 — 수집 머리말(collectLensHeadmatter)은 후속 단계라
        // 수집 픽커에는 넣지 않는다 (넣으면 머리말 없이 default 로 폴백돼 «거짓 UI»). 리서치 11종과 동형.
        return poResearchLenses(
            qa: true, security: true, pm: true, marketing: true, analytics: true, ops: true,
            logic: true, ux: true, readability: false)
    }
    var lenses = ["default", "design", "bug"]
    if security { lenses.append("security") }
    return lenses
}

/// 리서치 «전문가 관점» 렌즈가 노출하는 집합 — id 순서 고정. default(전방위)가 기본/baseline.
/// v1(렌즈 픽커 존재)에선 전방위·디자인·디버깅 3개, v2면 «QA», v3면 «보안», v4면 «기획», v5면
/// «마케팅», v6면 «분석», v7면 «운영», v8면 «로직», v9면 «UX»(사용성), v10이면 «가독성» 까지 한 단계씩
/// 늘어난다. capability 마다 한 단계씩 게이팅하는 이유: 그 렌즈를 모르는 옛 daemon 에 해당 lens 를 보내면
/// parseLens 가 조용히 전방위로 폴백 → «거짓 UI» 가 된다 (수집 designer·scope 게이팅과 동형). daemon
/// 의 lens.ts PO_LENSES 와 동형. UX 는 design(시각)과 «다른» 렌즈 — design 이 토큰·색·간격이라면 UX
/// 는 플로우 마찰·이해·완수(Nielsen 휴리스틱)다. 가독성은 logic(도메인·정합성)과 «다른» 렌즈 — logic 이
/// «규칙이 맞는가·일관적인가»(불변식)면 가독성은 «코드 표면이 읽기 쉬운가»(명명·길이·구조·중첩·주석)다.
func poResearchLenses(
    qa: Bool, security: Bool, pm: Bool, marketing: Bool, analytics: Bool, ops: Bool, logic: Bool,
    ux: Bool, readability: Bool
) -> [String] {
    var lenses = ["default", "design", "bug"]
    if qa { lenses.append("qa") }
    if security { lenses.append("security") }
    if pm { lenses.append("pm") }
    if marketing { lenses.append("marketing") }
    if analytics { lenses.append("analytics") }
    if ops { lenses.append("ops") }
    if logic { lenses.append("logic") }
    if ux { lenses.append("ux") }
    if readability { lenses.append("readability") }
    return lenses
}

/// 렌즈 id → 표시 이름 (LocalizedStringKey 라 10개 로케일 자동 번역). 픽커·보고서 칩이 공유한다.
/// "디자인" 은 수집의 «전문가 관점» 픽커와 같은 의미·같은 카탈로그 키를 쓴다 (중복 정의 금지). "bug" id 는
/// 옛 row 호환을 위해 유지하되 표시는 «디버깅» (daemon lens.ts 와 같은 약속).
func poResearchLensName(_ lens: String) -> LocalizedStringKey {
    switch lens {
    case "design": return "디자인"
    case "bug": return "디버깅"
    case "qa": return "QA"
    case "security": return "보안"
    case "pm": return "기획"
    case "marketing": return "마케팅"
    case "analytics": return "분석"
    case "ops": return "운영"
    case "logic": return "로직"
    case "ux": return "UX"
    case "readability": return "가독성"
    default: return "전방위"
    }
}

/// 근거(evidence) 종류 키 → 사용자 친화 표시명. daemon byEvidence 의 kind(github_issue·repo_todo·
/// code_comment·git_log·doc·asc_review 등)를 성적표 분해 행 라벨로 매핑한다. 매핑 밖 키(미래 daemon·
/// 깨진 행)는 원문 그대로 — 비번역 식별자 정책. GitHub·Git·TODO 같은 식별자는 모든 로케일에서 동일 원문.
func poEvidenceKindName(_ kind: String) -> LocalizedStringKey {
    switch kind {
    case "github_issue": return "GitHub 이슈"
    case "repo_todo": return "코드 TODO"
    case "code_comment": return "코드 주석"
    case "git_log": return "Git 기록"
    case "doc": return "문서"
    case "asc_review": return "스토어 리뷰"
    case "crash": return "크래시"
    case "feedback": return "사용자 피드백"
    case "bug": return "버그 리포트"
    case "code": return "코드"
    case "design_token_drift": return "디자인 토큰 이탈"
    case "design_color_misuse": return "색 오용"
    case "design_a11y": return "디자인 접근성"
    case "design_contrast": return "디자인 대비"
    case "design_pattern": return "디자인 패턴"
    case "design_i18n": return "디자인 다국어"
    default: return LocalizedStringKey(kind)
    }
}

/// 보고서 머리/리서치 행에 «어느 관점으로 조사했는지» 를 드러내는 칩 — 색 정책상 status/pro 색을
/// 빌리지 않고 중립(.secondary)으로 둔다. 전방위(default)/nil(옛 daemon)이면 호출부가 안 그린다.
struct ResearchLensChip: View {
    let lens: String

    var body: some View {
        Label { Text(poResearchLensName(lens)) } icon: { Image(systemName: "eyeglasses") }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("전문가 관점"))
            .accessibilityValue(Text(poResearchLensName(lens)))
    }
}

/// 리서치 한 행 — 주제 + 상태(조사 중/완료/실패) + 만든 브리프 수.
/// showRepo: 브리프 행과 같은 규칙 — 전체 모드에서만 레포 배지.
struct ResearchRow: View {
    let research: PoResearch
    var showRepo = true

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 8) {
                Text(verbatim: research.topic)
                    .font(.callout.weight(.medium))
                    .lineLimit(2)
                Spacer(minLength: 0)
                statusView
            }
            HStack(spacing: 8) {
                Label("브리프 \(research.briefCount)", systemImage: "list.clipboard")
                // 전방위(기본)/옛 daemon(nil)은 칩 숨김 — 비-baseline 렌즈만 «어느 관점» 을 드러낸다.
                if let lens = research.lens, lens != "default" {
                    ResearchLensChip(lens: lens)
                }
                Spacer(minLength: 0)
                if showRepo {
                    Text(verbatim: (research.repoPath as NSString).lastPathComponent)
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var statusView: some View {
        switch research.status {
        case "running":
            HStack(spacing: 5) {
                ProgressView().controlSize(.mini)
                Text("조사 중").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
        case "failed":
            Text("실패")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(Capsule().fill(Theme.danger.opacity(0.15)))
                .foregroundStyle(Theme.danger)
        default:
            Image(systemName: "doc.text")
                .font(.caption)
                .foregroundStyle(Theme.pro)
        }
    }
}

/// 리서치 보고서 — 조사 주제 + markdown 본문. id 만으로 fetch 하므로 백로그 리서치 섹션과
/// 브리프 상세(researchId 역추적) 양쪽에서 재사용된다.
struct ResearchReportView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker

    let researchId: String

    @State private var research: PoResearch?
    @State private var error: String?

    private var api: ApiClient { ApiClient(auth: auth, conn: conn, tracker: inflight) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let research {
                    Text(verbatim: research.topic)
                        .font(.headline)
                    // 어느 «전문가 관점» 으로 조사했는지를 보고서 머리에 드러낸다 (전방위/옛 daemon 은 숨김).
                    if let lens = research.lens, lens != "default" {
                        ResearchLensChip(lens: lens)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                    // 보고서는 에이전트 산출 markdown — 사용자 데이터라 번역 대상 아님.
                    // 브리프 본문(problem/scope/spec)과 동일하게 MarkdownText 로 렌더해
                    // 제목/불릿/체크박스/코드블록을 서식으로 보여준다(기호 노출 방지).
                    MarkdownText(raw: research.report ?? "")
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else if let error {
                    Text(LocalizedStringKey(error))
                        .font(.caption)
                        .foregroundStyle(Theme.danger)
                } else {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("불러오는 중…").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .padding()
        }
        .navigationTitle("리서치 보고서")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do {
                research = try await api.getPoResearch(id: researchId)
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
        }
    }
}

/// 리서치 주제 입력 — 무엇을 조사할지 + 어느 «전문가 관점» 에 맡길지 사용자가 결정하는 자리.
struct ResearchTopicForm: View {
    let repoPath: String
    let agents: [AgentInfo]
    /// daemon 이 «전문가 관점» 렌즈(po_research_lens_v1)를 지원하는가 — 미지원이면 픽커를 숨기고
    /// 전방위로 동작한다 (수집 «전문가 관점»(designer) 게이팅 패턴 재사용).
    let supportsLens: Bool
    /// daemon 이 «QA» 렌즈(po_research_lens_v2)까지 지원하는가 — 미지원이면 qa 옵션을 빼서 v1
    /// 옛 daemon 에 qa 를 보냈다 전방위로 폴백되는 «거짓 UI» 를 막는다.
    let supportsQaLens: Bool
    /// daemon 이 «보안» 렌즈(po_research_lens_v3)까지 지원하는가 — 미지원이면 security 옵션을 빼서
    /// security 를 모르는 옛 daemon 에 보냈다 전방위로 폴백되는 «거짓 UI» 를 막는다.
    let supportsSecurityLens: Bool
    /// daemon 이 «기획» 렌즈(po_research_lens_v4)까지 지원하는가 — 미지원이면 pm 옵션을 빼서 거짓 UI 방지.
    let supportsPmLens: Bool
    /// daemon 이 «마케팅» 렌즈(po_research_lens_v5)까지 지원하는가 — 미지원이면 marketing 옵션을 빼서 거짓 UI 방지.
    let supportsMarketingLens: Bool
    /// daemon 이 «분석» 렌즈(po_research_lens_v6)까지 지원하는가 — 미지원이면 analytics 옵션을 빼서 거짓 UI 방지.
    let supportsAnalyticsLens: Bool
    /// daemon 이 «운영» 렌즈(po_research_lens_v7)까지 지원하는가 — 미지원이면 ops 옵션을 빼서 거짓 UI 방지.
    let supportsOpsLens: Bool
    /// daemon 이 «로직» 렌즈(po_research_lens_v8)까지 지원하는가 — 미지원이면 logic 옵션을 빼서 거짓 UI 방지.
    let supportsLogicLens: Bool
    /// daemon 이 «UX»(사용성) 렌즈(po_research_lens_v9)까지 지원하는가 — 미지원이면 ux 옵션을 빼서 거짓 UI 방지.
    let supportsUxLens: Bool
    /// daemon 이 «가독성» 렌즈(po_research_lens_v10)까지 지원하는가 — 미지원이면 readability 옵션을 빼서
    /// readability 를 모르는 옛 daemon 에 보냈다 전방위로 폴백되는 «거짓 UI» 를 막는다.
    let supportsReadabilityLens: Bool
    /// daemon 이 조사 범위 선택(po_research_scope_v1)을 지원하는가 — 범위 피커 노출 분기.
    let supportsScope: Bool
    /// daemon 이 UX 렌즈 «화면 포함»(po_research_ux_screens_v1)을 지원하는가 — ux 렌즈 선택 시에만 토글 노출.
    let supportsUxScreens: Bool
    /// (repoPath, topic, agent?, lens?, scope?, screens?) — agent/lens/scope/screens 는 미노출/기본 시 nil.
    let onStart: (String, String, String?, String?, String?, Bool?) -> Void
    /// 통합 «만들기» 폼의 «어디서 찾을까» 토글 — 첫 섹션의 BriefSourcePicker 가 바꾼다.
    @Binding var source: BriefSource

    @State private var topic = ""
    @State private var agentId = AgentInfo.claudeCodeFallback.id
    /// 전문가 관점 — "default"/"design"/"bug"/"qa"/"security"/"pm"/"marketing"/"analytics"/"ops"/"logic"/"ux"/"readability". 이번 리서치에만 적용 (에이전트 픽커와 동형).
    @State private var lens = "default"
    /// 조사 범위 (po_research_scope_v1) — "web_repo" 웹+레포(기본) / "repo_only" 레포만(빠름·가벼움).
    /// 색을 새로 칠하지 않는 기본 컨트롤 — AccentColor(보라)가 자동으로 잡는다.
    @State private var scope = "web_repo"
    /// UX 렌즈 «화면 포함» (po_research_ux_screens_v1) — 켜면 렌더된 화면을 캡처해 그 화면으로
    /// 휴리스틱을 판정한다(화면 못 얻으면 코드+웹으로 graceful fallback). ux 렌즈일 때만 노출되며,
    /// 화면이 평가 품질을 올리므로 기본 ON. 색을 새로 칠하지 않는 기본 컨트롤 — AccentColor(보라)가 자동으로 잡는다.
    @State private var includeScreens = true

    /// 이번 화면에 노출할 렌즈 집합 — daemon 의 렌즈 지원 단계에 따라 3~12개. (id 순서 고정.)
    private var lenses: [String] {
        poResearchLenses(
            qa: supportsQaLens, security: supportsSecurityLens,
            pm: supportsPmLens, marketing: supportsMarketingLens,
            analytics: supportsAnalyticsLens, ops: supportsOpsLens,
            logic: supportsLogicLens, ux: supportsUxLens,
            readability: supportsReadabilityLens)
    }
    /// 렌즈 픽커는 daemon 지원 + 렌즈 2개 이상일 때만 노출 (1개뿐이면 숨김 — 거짓 UI 방지).
    private var showLensPicker: Bool { supportsLens && lenses.count > 1 }

    var body: some View {
        List {
            BriefSourcePicker(source: $source)
            Section {
                VoiceInputField(
                    "예: 화이트보드 협업 기능을 넣을까? 경쟁 제품과 수요를 조사해줘",
                    text: $topic,
                    lineLimit: 3...8,
                )
            } header: {
                Text("조사 주제")
            } footer: {
                Text("에이전트가 웹과 레포를 조사해 보고서와 백로그 제안을 만들어요. 수 분 걸려요 — 진행은 리서치 섹션에서 볼 수 있어요.")
            }
            if showLensPicker {
                Section {
                    // 기본 컨트롤 — 색 안 정함 → AccentColor(보라) 자동. 콘텐츠에 .tint() 안 건다.
                    Picker(selection: $lens) {
                        ForEach(lenses, id: \.self) { id in
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
                    Text("조사를 맡길 전문가 관점을 골라요. 그 렌즈에 맞는 근거(디자인=토큰·접근성·대비, 디버깅=재현·로그·회귀, QA=테스트·수용 기준·커버리지, 보안=인증·키 취급·노출면·위협모델, 기획=요구·우선순위·로드맵·트레이드오프, 마케팅=메시징·포지셔닝·채널, 분석=지표·퍼널·인사이트, 운영=배포·신뢰성·비용, 로직=정합성·불변식·중복·단순화, UX=사용성·플로우 마찰·휴리스틱, 가독성=명명·길이·구조·중첩·주석)를 우선 모아 보고서와 브리프를 만들어요. 이번 리서치에만 적용돼요.")
                }
            }
            // 조사 범위 — 옛 daemon(capability 미지원)에선 숨기고 기존 동작(웹+레포) 유지.
            if supportsScope {
                Section {
                    // 기본 컨트롤 — 색 안 정함 → AccentColor(보라) 자동. 콘텐츠에 .tint() 안 건다.
                    Picker(selection: $scope) {
                        Text("웹+레포").tag("web_repo")
                        Text("레포만").tag("repo_only")
                    } label: {
                        Text("조사 범위")
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    .accessibilityLabel(Text("조사 범위"))
                } header: {
                    Text("조사 범위")
                } footer: {
                    Text("«레포만» 은 웹 검색 없이 이 레포만 빠르게 조사해요 — 싸고 빠르지만 시장·경쟁 근거는 빠져요. 보고서·브리프는 레포 근거로만 작성돼요.")
                }
            }
            // UX 렌즈 «화면 포함» — ux 렌즈 + daemon 지원(po_research_ux_screens_v1)일 때만 노출.
            // 켜면 렌더된 화면을 캡처해 그 화면으로 휴리스틱을 판정한다(화면 못 얻으면 코드+웹 graceful
            // fallback). 토글은 색을 새로 칠하지 않는 «기본 컨트롤» — AccentColor(보라)가 자동으로 잡는다
            // (.tint() 안 건다, status 색 차용 안 한다). 라벨/설명은 카탈로그로 10개 로케일 번역된다.
            if supportsUxScreens && lens == "ux" {
                Section {
                    Toggle(isOn: $includeScreens) {
                        Text("화면 포함")
                    }
                    .accessibilityLabel(Text("화면 포함"))
                } footer: {
                    Text("켜면 시뮬레이터·실기기 화면을 캡처해 그 화면으로 사용성(휴리스틱)을 판정해요 — 코드·텍스트만 볼 때보다 더 많은 문제를 잡아요. 화면을 못 얻으면(UI 없음·캡처 불가) 코드·웹으로 평가하고 그 한계를 보고서에 적어요.")
                }
            }
            if !agents.isEmpty {
                PoAgentSection(agents: agents, selection: $agentId)
            }
            Section {
                Button {
                    let t = topic.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !t.isEmpty else { return }
                    // 전방위(default)/미지원이면 lens=nil 로 보내 옛 동작 유지 (designer 게이팅과 동형).
                    let chosenLens = (showLensPicker && lens != "default") ? lens : nil
                    // scope 는 daemon 이 지원하고 «레포만» 을 골랐을 때만 보낸다 — 기본/미지원은 nil
                    // (필드 생략 → daemon 기본 웹+레포, 옛 daemon 호환).
                    let chosenScope = (supportsScope && scope == "repo_only") ? "repo_only" : nil
                    // screens 는 daemon 지원 + ux 렌즈 + 토글 ON 일 때만 true — 그 외/미지원은 nil
                    // (필드 생략 → daemon 기본 코드+웹, 옛 daemon 호환).
                    let chosenScreens: Bool? =
                        (supportsUxScreens && lens == "ux" && includeScreens) ? true : nil
                    onStart(
                        repoPath, t, agents.isEmpty ? nil : agentId, chosenLens, chosenScope,
                        chosenScreens)
                } label: {
                    Text("리서치 시작").frame(maxWidth: .infinity)
                }
                .disabled(topic.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .navigationTitle(Text(verbatim: (repoPath as NSString).lastPathComponent))
        .navigationBarTitleDisplayMode(.inline)
        .voiceDictationChrome()
    }
}
