import SwiftUI

/// 브리프 상세 + 결재 화면 — 디자인 수용 기준 요약·수정 지시 시트 포함.
/// 원래 BacklogView.swift 안에 private 으로 있던 것을 동작 그대로(접근 수준만 private→internal) 옮긴 것 — 행동보존 추출. 색·문자열·레이아웃 그대로.
// MARK: - 상세 + 결재

/// 브리프 상세 — 문제/근거/스코프/스펙 전부 + 하단 결재 버튼. 승인 판단을 30초 안에 할 수
/// 있도록 근거(역추적 가능한 참조)를 본문 위쪽에 둔다.
struct BriefDetailView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker
    /// worktree 시작은 프로 전용 — 새 세션 시트·채팅 BranchSheet 의 게이트와 통일.
    @EnvironmentObject var purchase: PurchaseStore
    @Environment(\.dismiss) private var dismiss
    /// 지금 선택된 메인 탭 — 워크플로우 캔버스 푸시의 탭 바 숨김을 «백로그 탭이 활성일 때만» 걸기 위함.
    /// 딥링크로 다른 탭 전환 시 숨김이 남아 탭 바가 사라진 채 갇히는 누출 방지(MainTabView 주석 참고).
    @Environment(\.activeMainTab) private var activeMainTab
    private var canvasTabBarVisibility: Visibility {
        (activeMainTab ?? .backlog) == .backlog ? .hidden : .visible
    }

    let brief: PoBrief
    /// daemon 이 decide body 의 useWorktree 를 지원하는가 (po_worktree_v1, soft).
    let supportsWorktree: Bool
    /// daemon 이 기각 브리프의 «코드 흔적 정리» 를 지원하는가 (po_cleanup_v1, soft).
    let supportsCleanup: Bool
    /// daemon 이 decide body 의 mode="workflow" 를 지원하는가 (po_workflow_v1, soft).
    /// 옛 daemon 은 mode 를 조용히 버려 세션 모드로 돌므로 선택지를 숨긴다 (거짓 UI 방지).
    let supportsWorkflowMode: Bool
    /// 구현 세션 에이전트 후보 (po_agent_v1) — 비어 있으면 픽커를 숨기고 daemon 기본으로 돈다.
    let agents: [AgentInfo]
    /// 이 브리프 레포에서 수집이 진행 중이면 그 세션 id (아니면 nil). non-nil 이면 shipped 상세의
    /// «지금 수집해 검증하기» 버튼이 «검증 중 — 세션 보기» 로 바뀐다 (수집이 가설 대조를 겸하므로).
    let verifyingSessionId: String?
    /// 워크플로우 캔버스의 노드 세션 열기 — 세션 탭 전환 + 딥링크 (목록과 동일 경로).
    let onOpenSession: (String) -> Void
    /// 결재 완료 콜백 — (갱신된 브리프, approve 면 구현 세션 id).
    let onDecided: (PoBrief, String?) -> Void
    /// 수정 지시 시작 콜백 — 목록이 재로드해 «재종합 중» 배지를 띄운다.
    let onRevised: () -> Void
    /// shipped «지금 수집해 검증하기» 콜백 — (수집 시작 결과). 목록이 진행 배너 + gh 안내를 띄운다.
    let onVerifyCollect: (PoCollectStart) -> Void

    @State private var deciding = false
    @State private var confirmApprove = false
    /// 보류/기각 사유 태그 (po_decide_reason_v1) — 단건 결재 시 1탭 선택(미선택 허용). reject·hold
    /// 양쪽에 적용되고, 결재 호출에 rawValue 로 실린다.
    @State private var decideReason: DecideReason?
    /// 기각 다이얼로그 — supportsCleanup 일 때만 («기각만 / 기각하고 코드 흔적 정리» 선택).
    @State private var confirmReject = false
    /// 기각된 브리프 상세의 «정리 시작» 최종 확인.
    @State private var confirmCleanup = false
    @State private var showRevise = false
    @State private var reviseComment = ""
    @State private var error: String?
    /// 승인 시 구현을 맡길 에이전트 — 픽커 미노출(agents 비음)이면 의미 없음.
    /// 마지막 선택을 @AppStorage 로 기억해, 브리프 상세에 다시 들어오면 그 에이전트가 기본 선택된다
    /// (브리프 전역 «마지막 선택» — 매번 같은 도구로 승인하는 흐름을 한 탭 줄여준다). 기억한 id 가
    /// 현재 후보에 없으면(어댑터 제거 등) onAppear 에서 첫 후보로 보정해 «빈 선택» 을 막는다.
    @AppStorage("po.brief.lastAgentId") private var execAgentId = AgentInfo.claudeCodeFallback.id
    /// 브리프의 레포가 git 작업트리인가 — 최종 확인의 «worktree 에서 시작» 선택지 노출 분기.
    /// 조회 전/실패는 false — 기존 단일 버튼으로 폴백.
    @State private var repoIsGit = false
    /// 프로 게이트 페이월 — 미보유 사용자가 worktree 시작을 탭하면 PaywallView 시트.
    @State private var paywallFeature: ProFeature?
    /// 연결된 워크플로우 run 의 현재 상태 (po_workflow_v1) — 상세 진입 시 1회 조회.
    /// 라이브 추적은 캔버스가 한다 (여기는 «어디까지 갔나» 한 줄).
    @State private var workflowRunStatus: String?
    /// 긴 spec 의 점진적 공개 — 기본 접힘(false), «더 보기» 토글로 펼친다. 브리프마다 새 뷰라
    /// 진입 시 매번 접힌 상태로 시작한다(수용 기준: 기본 접힘).
    @State private var specExpanded = false

    /// 접힘 미리보기로 보여줄 블록 수 — 보통 유저스토리 + 수용 기준 머리 몇 줄이 들어온다.
    private let specCollapsedLimit = 5
    /// spec 이 «길어» 점진적 공개가 필요한가 — 블록 수가 미리보기 상한을 넘을 때만 토글을 노출한다.
    /// 짧은 spec 은 통째로 보여주고 토글을 숨긴다(불필요한 클러터 제거 — #8 미니멀).
    private var specIsLong: Bool { markdownBlocks(brief.spec).count > specCollapsedLimit }

    private var api: ApiClient { ApiClient(auth: auth, conn: conn, tracker: inflight) }
    private var decidable: Bool {
        (brief.status == "proposed" || brief.status == "held") && brief.revisingSessionId == nil
    }
    /// 최종 확인에서 worktree/현재 레포를 고를 수 있는가 — daemon capability + git 레포일 때만.
    private var worktreeChoice: Bool { supportsWorktree && repoIsGit }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(brief.title)
                        .font(.headline)
                    HStack(spacing: 8) {
                        Label("영향 \(brief.impact)", systemImage: "arrow.up.right")
                        Label("노력 \(brief.effort)", systemImage: "hammer")
                        Spacer(minLength: 0)
                        Text(verbatim: (brief.repoPath as NSString).lastPathComponent)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
            }
            // 실행/정리 에이전트 (po_agent_echo_v1) — 이 브리프가 «실제로» 어떤 코드 에이전트로
            // 돌(았)는지. daemon 이 agent 누락 시 조용히 claude_code 로 폴백한 무음 실패를 드러낸다.
            if brief.execAgentId != nil || brief.cleanupAgentId != nil {
                Section {
                    if let exec = brief.execAgentId {
                        LabeledContent {
                            PoAgentChip(agentId: exec, agents: agents)
                        } label: {
                            Text("구현")
                        }
                        // 픽커 선택과 실제 실행 에이전트가 다르면 경고 — 보낸 도구가 daemon 에서
                        // 기본값으로 폴백됐다는 신호 (warning=노랑, 진짜 주의 신호라 정책 허용).
                        // 구현이 도는 동안(running/approved)만 의미 있다 — 출시 후 상태엔 잡음.
                        if !agents.isEmpty, exec != execAgentId,
                            brief.status == "running" || brief.status == "approved" {
                            Label {
                                Text("선택한 도구와 다른 에이전트로 구현 중이에요. 승인할 때 에이전트가 전달되지 않아 기본 도구로 폴백됐을 수 있어요.")
                            } icon: {
                                Image(systemName: "exclamationmark.triangle.fill")
                            }
                            .font(.caption)
                            .foregroundStyle(Theme.warning)
                        }
                    }
                    if let cleanup = brief.cleanupAgentId {
                        LabeledContent {
                            PoAgentChip(agentId: cleanup, agents: agents)
                        } label: {
                            Text("정리")
                        }
                    }
                } header: {
                    Text("에이전트")
                }
            }
            Section("문제") {
                // problem 도 에이전트가 markdown 으로 쓸 수 있어 렌더한다(서식 기호 노출 방지).
                MarkdownText(raw: brief.problem)
                    .textSelection(.enabled)
            }
            Section("근거") {
                ForEach(Array(brief.evidence.enumerated()), id: \.offset) { _, ev in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(verbatim: ev.summary)
                            .font(.callout)
                        Text(verbatim: "\(ev.kind) · \(ev.ref)")
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                    .padding(.vertical, 1)
                }
            }
            // 리서치産 브리프 — 근거의 원문(보고서)을 한 번에 역추적.
            if let researchId = brief.researchId {
                Section {
                    NavigationLink {
                        ResearchReportView(researchId: researchId)
                    } label: {
                        Label("리서치 보고서 보기", systemImage: "doc.text.magnifyingglass")
                    }
                }
            }
            // 결재 사유 — rejected/held 브리프의 decideReason 태그 + decideNote 메모 (po_decide_reason_v2).
            // 내가 결재 때 단 사유를 다시 보여준다. verifyNote 섹션과 같은 Label 패턴 재사용.
            if (brief.status == "rejected" || brief.status == "held"),
               let reasonStr = brief.decideReason, !reasonStr.isEmpty {
                Section("결재 사유") {
                    if let reason = DecideReason(rawValue: reasonStr) {
                        Label {
                            reason.label
                                .font(.callout)
                        } icon: {
                            Image(systemName: "tag.fill")
                                .foregroundStyle(.secondary)
                        }
                    }
                    if let note = brief.decideNote, !note.isEmpty {
                        Text(verbatim: note)
                            .font(.callout)
                            .foregroundStyle(.primary)
                            .textSelection(.enabled)
                    }
                }
            }
            // 출시 후 검증 (§3.5) — 예전엔 여기 List 중간 Section 이었으나 스크롤에 묻혀
            // 쓰기 불편했다. 스크롤 위치와 무관하게 언제든 «지금 수집해 검증하기» 를 누를 수
            // 있도록 하단 플로팅 카드(verifyFloatingBar)로 옮겼다 (.safeAreaInset).
            // 기각 후 «코드 흔적 정리» (po_cleanup_v1) — 기각된 아이디어의 신호원(TODO 주석·
            // 죽은 코드)이 레포에 남으면 다음 수집이 같은 제안을 또 만든다. 그 흔적을 지우는
            // 정리 세션의 진입점 — 기각(rejected) 브리프에서만.
            if supportsCleanup && brief.status == "rejected" {
                Section {
                    if let sid = brief.cleanupSessionId {
                        // 이미 만든 정리 세션 역추적 — onDecided 의 세션 열기 경로를 재사용.
                        Button {
                            dismiss()
                            onDecided(brief, sid)
                        } label: {
                            Label("정리 세션 보기", systemImage: "text.magnifyingglass")
                        }
                        .tint(Theme.accent)
                        .listItemTint(Theme.accent)
                    }
                    Button {
                        confirmCleanup = true
                    } label: {
                        // ternary 의 String 추론 회피 — 분기마다 Label 로 (다국어 정책).
                        if brief.cleanupSessionId == nil {
                            Label("TODO·죽은 코드 정리 시작", systemImage: "paintbrush")
                        } else {
                            Label("다시 정리하기", systemImage: "paintbrush")
                        }
                    }
                    // 기본 틴트가 (iOS 26 시뮬레이터에서) AccentColor 에셋을 안 타고 파랗게
                    // 떠서 명시 — List 행 Label 아이콘은 listItemTint (색 정책: 파랑 금지).
                    .tint(Theme.accent)
                    .listItemTint(Theme.accent)
                    .disabled(deciding)
                } header: {
                    Text("코드 흔적 정리")
                } footer: {
                    Text("기각된 아이디어의 TODO 주석·죽은 코드가 남아 있으면 다음 신호 수집에서 같은 제안이 반복될 수 있어요. 에이전트가 근거를 따라 흔적만 정리해요 — 커밋은 하지 않아 세션에서 검토할 수 있어요.")
                }
            }
            // «워크플로우로 실행» 승인의 진행 상태 (po_workflow_v1) — run 상태 한 줄 +
            // 캔버스 진입점. AI 설계 실패 fallback / 게이트 거부 / run 실패 메모도 여기서.
            if let workflowId = brief.execWorkflowId {
                Section("구현 워크플로우") {
                    if let status = workflowRunStatus {
                        LabeledContent {
                            workflowRunStatusText(status)
                                .foregroundStyle(.primary)
                        } label: {
                            Text("실행 상태")
                        }
                    }
                    if let note = brief.execNote, !note.isEmpty {
                        // daemon 이 남긴 원인 추적 메모 (에이전트/서버 산출 — 번역 대상 아님).
                        Text(verbatim: note)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    NavigationLink {
                        WorkflowRunLoaderView(
                            workflowId: workflowId,
                            runId: brief.execRunId,
                            onOpenSession: onOpenSession
                        )
                        .toolbar(canvasTabBarVisibility, for: .tabBar)
                    } label: {
                        Label("워크플로우 캔버스 열기", systemImage: "point.3.connected.trianglepath.dotted")
                    }
                    // List 행의 Label 아이콘은 listItemTint — 명시 없으면 파랗게 뜬다 (색 정책).
                    .listItemTint(Theme.accent)
                }
            }
            Section("스코프") {
                MarkdownText(raw: brief.scope)
                    .textSelection(.enabled)
            }
            Section("스펙") {
                // 긴 spec 은 기본 접힘 미리보기 + «더 보기» 로 점진적 공개. 짧으면 통째로 + 토글 숨김.
                MarkdownText(
                    raw: brief.spec,
                    limit: (specIsLong && !specExpanded) ? specCollapsedLimit : nil,
                )
                .textSelection(.enabled)
                if specIsLong {
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) { specExpanded.toggle() }
                    } label: {
                        // ternary 의 String 추론 회피 — 분기마다 Label 로(다국어 정책).
                        if specExpanded {
                            Label("접기", systemImage: "chevron.up")
                                .font(.caption.weight(.semibold))
                        } else {
                            Label("더 보기", systemImage: "chevron.down")
                                .font(.caption.weight(.semibold))
                        }
                    }
                    .buttonStyle(.plain)
                    // 인터랙티브 강조라 accent(보라) — 텍스트+아이콘 함께 물들인다(색 정책 허용).
                    .foregroundStyle(Theme.accent)
                    .accessibilityLabel(specExpanded ? Text("스펙 접기") : Text("스펙 더 보기"))
                }
            }
            // 디자인 수용 기준 — spec 자유텍스트에 묻힌 «색 의미·다국어·상태·접근성» 고려를 별도
            // 블록으로 끌어올려, 폰에서 30초 안에 승인하기 «전» 에 디자인 회귀(상태 누락·브랜드
            // 드리프트)를 한눈에 가늠하게 한다. 정밀 점검이 아니라 «스펙이 다뤘는가» 요약 —
            // 못 잡으면 «미명시»(중립)다. 색은 의미 토큰만: 다룸=accent(보라·강조 아이콘),
            // 미명시=secondary(중립). status색(success/danger/warning)을 다룸 표시로 빌려 쓰지
            // 않는다(색 정책: 장식에 status색 차용 금지, 미명시는 경고가 아닌 정보).
            Section {
                ForEach(designCriteria(in: brief.spec)) { c in
                    HStack(spacing: 10) {
                        Image(systemName: c.systemImage)
                            .font(.callout)
                            .foregroundStyle(c.covered ? Theme.accent : Color.secondary)
                            .frame(width: 22)
                        Text(c.label)
                            .font(.callout)
                            .foregroundStyle(.primary)
                        Spacer(minLength: 8)
                        if c.covered {
                            // 다룸 — accent(보라)는 «강조 아이콘» 용도(색 정책 허용). 정적 표시지만
                            // status 신호색이 아니라 브랜드 강조라 의미 혼동이 없다.
                            Label("명시됨", systemImage: "checkmark")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Theme.accent)
                        } else {
                            // 미명시 — 경고가 아니라 정보. 중립(secondary)으로 둬 노랑(warning) 오용을 피한다.
                            Text("미명시")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 1)
                }
            } header: {
                Text("디자인 수용 기준")
            } footer: {
                Text("스펙이 디자인 제약(색 의미·다국어·상태·접근성)을 다뤘는지 요약했어요. «미명시» 는 스펙에 그 기준이 안 보인다는 정보일 뿐이에요 — UI 가 닿지 않는 브리프엔 원래 디자인 기준이 없어요.")
            }
            // 구현 에이전트 선택 (po_agent_v1) — 결재 가능한 브리프에서만. 하단 «승인» 과 짝.
            if decidable && !agents.isEmpty {
                PoAgentSection(agents: agents, selection: $execAgentId) {
                    Text("승인하면 이 에이전트가 구현을 시작해요.")
                }
            }
            // 검증 수집 에이전트 선택 (po_agent_v1) — 출시된(shipped) 브리프에서만. 하단
            // «지금 수집해 검증하기» 와 짝. 결재용 픽커와 같은 «마지막 선택»(execAgentId) 을
            // 공유해 브리프 전역에서 한 도구로 일관되게 (수집도 collect 파이프라 §14.4 agent 게이트 적용).
            if brief.status == "shipped" && !agents.isEmpty {
                PoAgentSection(agents: agents, selection: $execAgentId) {
                    Text("이 에이전트가 신호를 수집해 가설을 대조해요.")
                }
            }
            // 정리 에이전트 선택 (po_agent_v1) — 기각된 브리프의 «코드 흔적 정리» 와 짝.
            // 정리도 agent 게이트 대상(§14.4)이라 같은 «마지막 선택» 을 따른다.
            if supportsCleanup && brief.status == "rejected" && !agents.isEmpty {
                PoAgentSection(agents: agents, selection: $execAgentId) {
                    Text("이 에이전트가 코드 흔적을 정리해요.")
                }
            }
            if let error {
                Section {
                    Text(LocalizedStringKey(error))
                        .font(.caption)
                        .foregroundStyle(Theme.danger)
                }
            }
        }
        .navigationTitle("브리프")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // 수정 지시 — 티켓에 코멘트 달듯 한 줄로 브리프를 다듬는다 (승인 전 개입 통로).
            if decidable {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("수정 지시") { showRevise = true }
                }
            }
        }
        // 수정 지시 — 예전엔 .alert 였지만, alert 은 마이크 버튼 같은 커스텀 뷰를 못 담아 sheet 으로
        // 바꿨다(받아쓰기 부착). 보내기/취소·안내문은 그대로, 입력은 멀티라인 + 마이크.
        .sheet(isPresented: $showRevise) {
            ReviseCommentSheet(comment: $reviseComment, isSending: deciding) {
                Task { await revise() }
            }
        }
        .safeAreaInset(edge: .bottom) {
            // 결재 가능(proposed/held)이면 결재 바, 출시 후(shipped/verified/missed)면 검증
            // 플로팅 카드 — 두 상태는 상호 배타적이라 같은 하단 자리를 나눠 쓴다.
            if decidable {
                decisionBar
            } else if ["shipped", "verified", "missed"].contains(brief.status) {
                verifyFloatingBar
            }
        }
        .confirmationDialog(
            // ternary 의 String 추론 회피 — Text 로 갈라 각각 LocalizedStringKey 추출 (다국어 정책).
            worktreeChoice
                ? Text("승인하면 에이전트가 바로 구현을 시작해요. worktree 는 별도 작업 폴더라 동시에 도는 다른 세션과 충돌하지 않아요.")
                : Text("승인하면 에이전트가 바로 구현을 시작해요."),
            isPresented: $confirmApprove,
            titleVisibility: .visible,
        ) {
            if worktreeChoice {
                Button("새 worktree 에서 구현 시작") {
                    // worktree 는 프로 전용 — 게이트 단일화: 판정은 항상 purchase.isUnlocked(.worktree).
                    if !purchase.isUnlocked(.worktree) {
                        paywallFeature = .worktree
                        return
                    }
                    Task { await decide("approve", useWorktree: true) }
                }
                Button("현재 레포에서 구현 시작") {
                    Task { await decide("approve", useWorktree: false) }
                }
            } else {
                Button("승인하고 구현 시작") {
                    Task { await decide("approve") }
                }
            }
            // «워크플로우로 실행» (po_workflow_v1) — 설계 에이전트가 브리프 맞춤
            // 스펙→구현→자가검증→머지 승인 게이트 DAG 를 만들어 실행한다. 워크플로우는
            // 프로 전용이라 탭과 같은 게이트 (비-프로는 세션 모드만).
            if supportsWorkflowMode {
                Button("워크플로우로 구현 (자가검증 + 머지 승인)") {
                    if !purchase.isUnlocked(.workflow) {
                        paywallFeature = .workflow
                        return
                    }
                    Task { await decide("approve", mode: "workflow") }
                }
            }
        }
        // 기각 다이얼로그 (po_cleanup_v1) — 기각만 할지, 흔적 정리 세션까지 돌릴지.
        // 흔적(TODO 주석·죽은 코드)이 남으면 다음 수집에서 같은 제안이 반복되기 때문.
        .confirmationDialog(
            Text("기각하면 이 제안은 종결돼요. 이 아이디어가 남긴 TODO 주석·죽은 코드를 에이전트가 함께 정리하게 할 수 있어요 — 흔적이 남으면 다음 수집에서 같은 제안이 반복될 수 있어요."),
            isPresented: $confirmReject,
            titleVisibility: .visible,
        ) {
            Button("기각하고 코드 흔적 정리", role: .destructive) {
                Task { await rejectAndCleanup() }
            }
            Button("기각만", role: .destructive) {
                Task { await decide("reject", reason: decideReason?.rawValue) }
            }
        }
        // 기각된 브리프 상세의 «정리 시작» 최종 확인 — 무엇이 일어나는지 한 번 더.
        .confirmationDialog(
            Text("에이전트가 이 아이디어와 관련된 TODO 주석·죽은 코드를 찾아 지워요. 변경은 커밋하지 않아요 — 세션에서 검토할 수 있어요."),
            isPresented: $confirmCleanup,
            titleVisibility: .visible,
        ) {
            Button("정리 시작") {
                Task { await cleanup() }
            }
        }
        // 프로 전용(worktree)을 미보유 사용자가 시도했을 때의 업셀 페이월.
        .proPaywall(item: $paywallFeature)
        .task {
            // worktree 선택지 노출 판단 — 결재 가능한 브리프에서만 조회 (실패는 조용히 폴백).
            guard supportsWorktree, decidable else { return }
            repoIsGit = (try? await api.repoGitInfo(repoPath: brief.repoPath))?.isRepo ?? false
        }
        .task {
            // 연결된 워크플로우 run 의 현재 상태 — 실패는 조용히 (행 자체를 숨긴다).
            guard let runId = brief.execRunId else { return }
            workflowRunStatus = try? await api.workflowRunState(runId: runId).run.status
        }
        .onAppear {
            // 기억한 에이전트(@AppStorage)가 현재 후보에 없으면(어댑터 제거·후보 변경) 첫 후보로
            // 보정 — 인라인 Picker 가 어느 태그와도 안 맞아 «빈 선택» 으로 뜨고, 그 stale id 가
            // 승인 요청에 실려 가는 걸 막는다.
            if !agents.isEmpty, !agents.contains(where: { $0.id == execAgentId }) {
                execAgentId = agents.first!.id
            }
        }
    }

    /// 하단 결재 바 — 사유 태그(항상 제시) + 기각(빨강=danger)/보류(중립)/승인(기본 틴트=accent).
    private var decisionBar: some View {
        VStack(spacing: Theme.Spacing.l) {
            // 보류/기각 사유 태그 (po_decide_reason_v1) — 1탭 선택(미선택 허용). approve 엔 무관.
            DecideReasonPicker(selected: $decideReason)
            HStack(spacing: 10) {
                Button(role: .destructive) {
                    // po_cleanup_v1 — 기각 시 «흔적 정리까지» 선택지를 다이얼로그로. 미지원
                    // daemon 은 기존처럼 즉시 기각 (soft).
                    if supportsCleanup {
                        confirmReject = true
                    } else {
                        Task { await decide("reject", reason: decideReason?.rawValue) }
                    }
                } label: {
                    Text("기각").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)

                if brief.status == "proposed" {
                    Button {
                        Task { await decide("hold", reason: decideReason?.rawValue) }
                    } label: {
                        Text("보류").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(.primary)
                }

                Button {
                    confirmApprove = true
                } label: {
                    Text("승인").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                // 기본 prominent 의 파랑 회피 — 명시 accent (PaywallView 관례, 색 정책: 파랑 금지).
                .tint(Theme.accent)
            }
        }
        .disabled(deciding)
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.bar)
    }

    /// 출시 후 검증 플로팅 카드 — shipped 는 «지금 수집해 검증하기» 실행 버튼, verified/missed
    /// 는 판정 + 근거. List 중간 Section 이던 걸 하단에 띄워 스크롤 위치와 무관하게 언제든
    /// 누를 수 있게 했다.
    private var verifyFloatingBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch brief.status {
            case "verified":
                Label("검증됨 — 가설이 해소됐어요", systemImage: "checkmark.seal")
                    .font(.callout)
                    .foregroundStyle(Theme.success)
            case "missed":
                Label("빗나감 — 신호가 해소되지 않았어요", systemImage: "xmark.seal")
                    .font(.callout)
                    .foregroundStyle(Theme.danger)
            default:
                // 이 레포에서 수집이 돌고 있으면 곧 가설을 대조한다 → «검증 중» 으로 알린다 (중복 실행 혼동 방지).
                if verifyingSessionId != nil {
                    Label("검증 중 — 신호를 수집해 가설을 대조하고 있어요", systemImage: "antenna.radiowaves.left.and.right")
                        .font(.callout)
                        .foregroundStyle(Theme.info)
                } else {
                    Label("출시됨 — 다음 신호 수집이 가설을 대조해요", systemImage: "clock")
                        .font(.callout)
                        .foregroundStyle(Theme.info)
                }
            }
            if let note = brief.verifyNote, !note.isEmpty {
                Text(verbatim: note)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            if brief.status == "shipped" {
                if let sid = verifyingSessionId {
                    // 이미 검증 수집이 도는 중 — 또 누르지 않도록 버튼 대신 «검증 중 · 세션 보기» 진입점.
                    Button {
                        dismiss()
                        onOpenSession(sid)
                    } label: {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("검증 중 · 세션 보기")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.bordered)
                } else {
                    // «이어서 쓰는 법» 의 실행 버튼 — 다음 수집을 기다리지 않고 지금 같은 레포
                    // 수집을 돌려 가설 대조를 시작한다.
                    Button {
                        Task { await startVerifyCollect() }
                    } label: {
                        Label("지금 수집해 검증하기", systemImage: "antenna.radiowaves.left.and.right")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    // 기본 prominent 의 파랑 회피 — 명시 accent (위 info(파랑) 상태 라벨과도 구분, 색 정책: 파랑 금지).
                    .tint(Theme.accent)
                    .disabled(deciding)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(.separator, lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.15), radius: 8, y: 2)
        .padding(.horizontal)
        .padding(.bottom, 8)
    }

    private func decide(_ action: String, useWorktree: Bool? = nil, mode: String? = nil, reason: String? = nil) async {
        guard !deciding else { return }
        deciding = true
        defer { deciding = false }
        // 에이전트는 approve 에만 의미 있고, 픽커가 노출됐을 때만 보낸다 (옛 daemon 은 무시).
        let agent = (action == "approve" && !agents.isEmpty) ? execAgentId : nil
        do {
            let result = try await api.decidePoBrief(
                id: brief.id, action: action, useWorktree: useWorktree, agent: agent, mode: mode,
                reason: reason)
            dismiss()
            // 워크플로우 모드의 execSessionId 는 «설계 세션» — 그대로 열어 설계를 관전한다.
            onDecided(result.brief, result.execSessionId)
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// 기각된 브리프의 «코드 흔적 정리» 세션 spawn — 성공하면 세션 탭으로 (onDecided 경로 재사용).
    private func cleanup() async {
        guard !deciding else { return }
        deciding = true
        defer { deciding = false }
        // 에이전트 픽커가 노출됐다면 정리 세션도 같은 선택을 따른다 (승인·기각정리와 같은 규칙).
        let agent = agents.isEmpty ? nil : execAgentId
        do {
            let result = try await api.cleanupPoBrief(id: brief.id, agent: agent)
            dismiss()
            onDecided(result.brief, result.cleanupSessionId)
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// «기각하고 코드 흔적 정리» — 기각 결재 후 곧장 정리 세션 spawn. 기각은 됐는데 정리
    /// spawn 이 실패하면 목록만 갱신하고 에러를 남긴다 (정리는 기각 브리프 상세에서 재시도).
    private func rejectAndCleanup() async {
        guard !deciding else { return }
        deciding = true
        defer { deciding = false }
        // 에이전트 픽커가 노출됐다면 정리 세션도 같은 선택을 따른다 (승인과 같은 규칙).
        let agent = agents.isEmpty ? nil : execAgentId
        do {
            let rejected = try await api.decidePoBrief(id: brief.id, action: "reject", reason: decideReason?.rawValue)
            do {
                let result = try await api.cleanupPoBrief(id: brief.id, agent: agent)
                dismiss()
                onDecided(result.brief, result.cleanupSessionId)
            } catch {
                onDecided(rejected.brief, nil)
                self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    private func revise() async {
        let comment = reviseComment.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !comment.isEmpty, !deciding else { return }
        deciding = true
        defer { deciding = false }
        // sheet 은 alert 과 달리 자동으로 닫히지 않으니 명시로 닫는다 — 성공이면 상세까지 dismiss,
        // 실패면 sheet 만 닫아 뒤의 상세에서 오류 Section 이 보이게.
        showRevise = false
        do {
            _ = try await api.revisePoBrief(id: brief.id, comment: comment)
            reviseComment = ""
            dismiss()
            onRevised()
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// shipped — 검증을 기다리지 않고 지금 같은 레포 수집을 돌린다. 수집 파이프가
    /// shipped 브리프 가설 대조(verified/missed)를 함께 수행한다.
    private func startVerifyCollect() async {
        guard !deciding else { return }
        deciding = true
        defer { deciding = false }
        do {
            // 검증 수집도 에이전트 선택을 따른다 (collect 파이프라 §14.4 의 agent 게이트 적용).
            // 픽커가 노출됐을 때만 보낸다 — 옛 daemon/미지원은 nil 로 두어 claude_code 기본.
            let agent = agents.isEmpty ? nil : execAgentId
            let started = try await api.startPoCollection(
                repoPath: brief.repoPath, instruction: nil, agent: agent)
            dismiss()
            onVerifyCollect(started)
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }
}

// MARK: - 디자인 수용 기준 (브리프 spec 휴리스틱 요약)

/// 브리프 상세의 «디자인 수용 기준» 한 축 — 색 의미·다국어·상태·접근성 중 하나가 spec 에서
/// 다뤄졌는지. covered=스펙 본문이 그 기준을 언급함 / false=미명시(정보일 뿐, 경고 아님).
struct DesignCriterion: Identifiable {
    /// ForEach 식별자 — 라벨(번역 키)이 아니라 안정적인 영문 축 키.
    let id: String
    /// 화면 표시명 — LocalizedStringKey 라 호출부 string literal 이 카탈로그 자동 추출 경로를 탄다.
    let label: LocalizedStringKey
    let systemImage: String
    let covered: Bool
}

/// spec 자유텍스트(markdown)에서 디자인 4축(색 의미·다국어·상태·접근성)이 «다뤄졌는지» 를
/// 키워드로 가볍게 판정한다. PO 수집/리서치 프롬프트가 spec 수용 기준에 「디자인 제약」 을
/// 반영하도록 지시하지만(prompt.ts), 그 결과는 구조화 필드가 아니라 자유 markdown 이라 휴리스틱
/// 으로 읽는다 — 덕에 spec 구조화 선행(브리프 #1) 없이도 독립 동작한다(브리프 의존성 해소).
/// 정밀 점검이 아니라 «승인 전 한눈 요약» 이 목적이라, 못 잡으면 «미명시»(중립)로 떨어진다.
/// 한국어 키워드는 lowercased 영향이 없고 영문 키워드만 소문자 매칭된다.
func designCriteria(in spec: String) -> [DesignCriterion] {
    let s = spec.lowercased()
    func mentions(_ needles: [String]) -> Bool { needles.contains { s.contains($0) } }
    return [
        DesignCriterion(
            id: "color", label: "색 의미", systemImage: "paintpalette",
            covered: mentions([
                "색상", "색 의미", "색의 의미", "의미 토큰", "디자인 토큰", "design token",
                "컬러", "color", "팔레트", "palette", "accent", "purple", "보라색", "틴트", "tint",
            ])),
        DesignCriterion(
            id: "i18n", label: "다국어", systemImage: "globe",
            covered: mentions([
                "i18n", "l10n", "로케일", "locale", "번역", "translat", "다국어", "localiz",
                "localis", "xcstrings", "카탈로그", "catalog", "현지화", "지원 언어", "언어 집합",
            ])),
        DesignCriterion(
            id: "state", label: "상태", systemImage: "square.stack",
            covered: mentions([
                "상태", "빈 ", "빈/", "empty", "오류", "에러", "error", "로딩", "loading",
                "비활성", "disabled", "포커스", "focus", "엣지", "edge case", "placeholder",
            ])),
        DesignCriterion(
            id: "a11y", label: "접근성", systemImage: "accessibility",
            covered: mentions([
                "접근성", "accessibility", "a11y", "voiceover", "보이스오버", "스크린 리더",
                "screen reader", "대비", "contrast",
            ])),
    ]
}

/// 브리프 «수정 지시» 입력 시트 — 예전 .alert 을 대체한다(alert 은 마이크 버튼을 못 담는다).
/// 멀티라인 입력 + 받아쓰기 마이크. 보내기/취소·안내문은 기존 alert 과 동일 문자열을 재사용한다.
struct ReviseCommentSheet: View {
    @Binding var comment: String
    /// 전송 중 — 보내기 버튼 비활성(중복 전송 방지).
    let isSending: Bool
    let onSend: () -> Void
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

    private var canSend: Bool {
        !comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VoiceInputField("예: 스코프를 절반으로 줄여줘", text: $comment, lineLimit: 1...4, focus: $focused)
                } footer: {
                    Text("티켓에 코멘트 달듯 한 줄로 — 에이전트가 브리프를 다듬어 갱신해요.")
                }
            }
            .navigationTitle("수정 지시")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("보내기") { onSend() }
                        .disabled(!canSend)
                }
            }
            .voiceDictationChrome()
            .onAppear { focused = true }
        }
        .presentationDetents([.medium])
    }
}

/// 워크플로우 run 상태 라벨 — 캔버스(workflowStatusText)와 같은 표기. 각 분기가 Text
/// literal 이라 LocalizedStringKey 자동 추출 경로를 탄다 (다국어 정책).
func workflowRunStatusText(_ status: String) -> Text {
    switch status {
    case "running": return Text("실행 중")
    case "done": return Text("완료")
    case "failed": return Text("실패")
    case "cancelled": return Text("취소됨")
    default: return Text("대기 중")
    }
}
