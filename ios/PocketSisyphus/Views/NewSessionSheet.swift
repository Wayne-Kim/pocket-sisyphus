import SwiftUI

/// 새 세션 생성 시트 — 에이전트 선택·레포 경로·워크트리·재개 후보·로컬 LLM/도구 설정까지
/// 한 화면에서 구성한다. 원래 SessionsView.swift 안에 private 으로 있던 것을 동작 그대로
/// (접근 수준만 private→internal) 옮긴 것 — 행동보존 추출. 내부 로직/레이아웃/문자열 변경 없음.

struct NewSessionSheet: View {
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker
    /// 활성 로컬 LLM 세션이 이미 있는지. true 면 로컬 LLM 을 고른 새 세션 생성을 막는다
    /// (메모리 보호 — 동시 1개). daemon 도 409 로 거절하지만 여기서 먼저 친절히 안내.
    let localLlmActive: Bool
    /// (repoPath, title, resumeFrom, skipPermissions, agentId). 호출자가 받아 daemon 에
    /// 그대로 전달. agentId 는 picker 에서 사용자가 고른 코드 에이전트 (기본 claude_code).
    /// 반환: 실패 시 사용자에게 보여줄 에러 메시지, 성공이면 nil — 시트가 이걸로 alert/닫기를
    /// 분기한다 (로컬 LLM 동시 1개 초과 등 daemon 거절을 화면에 명확히 안내하기 위함).
    let onCreate: (String, String?, String?, Bool, String) async -> String?

    @EnvironmentObject var hiddenItems: HiddenItemsStore
    /// 프로(주황) 전용 — Terminal·로컬 LLM 에이전트, worktree 생성 게이트. 미보유 시 차단 + 페이월.
    @EnvironmentObject var purchase: PurchaseStore
    /// 프로 게이트 페이월 — non-nil 이면 `.proPaywall(item:)` 가 PaywallView 시트를 띄운다.
    @State private var paywallFeature: ProFeature?
    @State private var showHiddenSheet = false
    /// 파일 탐색기(DirectoryPickerSheet)로 작업 폴더를 고르는 시트.
    @State private var showDirPicker = false

    @State private var repoPath = ""
    @State private var title = ""
    // 이 세션에서 사용할 코드 에이전트 CLI. daemon 의 GET /api/agents 응답으로 동적
    // 노출. multi_agent_v1 미지원 옛 daemon 은 404 → claudeCodeFallback 1개로 흡수.
    @State private var agents: [AgentInfo] = [AgentInfo.claudeCodeFallback]
    @State private var selectedAgentId: String = AgentInfo.claudeCodeFallback.id
    /// 로컬 LLM 세부 상태(바이너리·선택/추천 모델·다운로드 진행·하드웨어). nil = 아직 미조회/실패.
    /// 단일 boolean 환원 대신 이 세부를 읽어 「무엇이 준비됐고 무엇이 빠졌는지」 를 표면화한다.
    @State private var llmStatus: LocalLlmStatus?
    /// 모델 카탈로그(+downloaded 플래그) — 폰에서 받을 모델 선택지.
    @State private var llmModels: [LocalLlmCatalogModel] = []
    @State private var llmRecommendedId: String?
    @State private var llmSelectedId: String?
    /// 상태/카탈로그 조회 실패 사유(섹션에 재시도 버튼과 함께 표시).
    @State private var llmLoadError: String?
    /// 다운로드/선택 액션 실패 사유 — 디스크 부족·실패 등을 섹션 안에 인라인으로 명확히 표시.
    @State private var llmError: String?
    /// 선택(select) in-flight 모델 — 그 행에 스피너를 띄운다.
    @State private var llmBusyModelId: String?
    /// 다운로드 진행 폴링 태스크 — 활성 다운로드 동안 ~1.5s 로 status 를 당겨 진행률을 갱신한다.
    @State private var llmPollTask: Task<Void, Never>?
    @Environment(\.scenePhase) private var scenePhase
    /// 미설치 CLI 의 «Mac 에 설치» 진행 스냅샷 (daemon 폴링 결과). nil 이면 아직 시작 안 함.
    @State private var installProgress: AgentInstallProgress?
    /// 진행 중인 설치 폴링 task — 어댑터 전환/시트 종료 시 취소.
    @State private var installTask: Task<Void, Never>?

    // MARK: - OpenCode 「내 로컬 서버 사용」 외부 엔드포인트 (opencode_external_v1)
    //
    // opencode 선택 + daemon 이 capability 지원 시에만 노출. 사용자가 이미 자기 Mac 에서 돌리는
    // OpenAI 호환 로컬 서버(Ollama/LM Studio/vLLM 등)를 baseURL+모델로 지정하면 daemon 이 번들
    // llama-server 를 건너뛰고 그대로 백엔드로 쓴다. 저장 전 /v1/models 헬스체크로 «막다른 길»
    // (연결했더니 서버가 없거나 모델명이 틀림)을 사전 차단한다.
    /// daemon 에서 마지막으로 읽어온 저장 설정 — draft 와 비교해 «변경됨(저장 필요)» 을 판단한다.
    @State private var opencodeLoaded: OpencodeExternalConfig?
    /// 편집용 draft — 토글/baseURL/모델 입력이 직접 바인딩된다.
    @State private var opencodeEnabledDraft = false
    @State private var opencodeBaseUrlDraft = ""
    @State private var opencodeModelDraft = ""
    /// 마지막 헬스체크 결과 — 도달성/모델 존재를 success/warning 으로 표면화. nil = 미확인.
    @State private var opencodeProbe: OpencodeExternalProbe?
    /// verify/save in-flight — 버튼 스피너 + 중복 클릭 방지.
    @State private var opencodeBusy = false
    /// 조회/저장/확인 실패 사유 — 섹션 안에 인라인으로 표시.
    @State private var opencodeError: String?
    // 도구 자동 승인 토글 — 기본 ON. 끄면 daemon 이 매 도구 호출마다 사용자에게 묻는다 (응답 멈춤).
    @State private var skipPermissions: Bool = true
    @State private var creating = false
    /// 생성 실패 사유 — non-nil 이면 alert 로 보여 준다 (로컬 LLM 동시 1개 초과 등).
    @State private var createError: String?
    @State private var recents: [RecentProject] = []
    @State private var loadingRecents = false
    @State private var loadError: String?
    @State private var manualMode = false
    @State private var filter = ""
    /// 파일시스템 디렉터리 자동완성 — 현재 경로 prefix 의 하위 디렉터리들 (daemon `/api/fs/list-dir`).
    /// recents 추측만으로는 한 번도 작업 안 한 폴더가 추천에 안 떠 전체를 타이핑해야 했다.
    /// fsDirsPrefix 는 fsDirs 가 어느 prefix 에 대한 결과인지 — race/stale 가드.
    @State private var fsDirs: [String] = []
    @State private var fsDirsPrefix: String = ""
    // 이어가기 — 데스크탑 Claude Code 세션 선택
    @State private var resumeCandidates: [DesktopSession] = []
    @State private var loadingResume = false
    @State private var resumeError: String?
    @State private var selectedResumeId: String? = nil
    // 레포 경로 / 이어받기 목록 펼치기 — 5개 초과면 첫 5개만 노출 + 더 보기 버튼.
    @State private var recentsExpanded = false
    @State private var resumeExpanded = false
    // worktree — 선택한 레포가 git 저장소이면, 채팅방에 들어가지 않고 여기서 바로 새 브랜치
    // worktree 를 만들어 그 안에서 세션을 시작할 수 있다. repoIsGit==true 일 때만 섹션 노출.
    @State private var repoIsGit = false
    @State private var repoBranch: String? = nil
    @State private var worktreeMode = false
    @State private var worktreeBranch = ""
    @Environment(\.dismiss) private var dismiss

    /// 숨김 처리된 경로를 먼저 제외한 «보이는» 레포 목록. 필터/더 보기 계산은 모두 이걸 기준.
    private var visibleRecentsBase: [RecentProject] {
        recents.filter { !hiddenItems.isRecentHidden($0.path) }
    }

    private var filteredRecents: [RecentProject] {
        let q = filter.trimmingCharacters(in: .whitespaces).lowercased()
        let base = visibleRecentsBase
        if q.isEmpty { return base }
        return base.filter { $0.path.lowercased().contains(q) }
    }

    /// 화면에 실제로 그릴 레포 목록. 필터가 비어 있고 6개 이상이면 5개로 자르고
    /// 나머지는 "더 보기" 버튼으로 노출. 필터가 켜져 있으면 결과를 전부 보여 준다
    /// (사용자가 명시적으로 좁힌 결과니까 또 자르면 혼란만 가중).
    private var visibleRecents: [RecentProject] {
        if filter.isEmpty && filteredRecents.count > 5 && !recentsExpanded {
            return Array(filteredRecents.prefix(5))
        }
        return filteredRecents
    }

    /// 숨김 항목을 제외한 이어받기 후보. 더 보기 / 자동 선택 처리도 이걸 기준으로 한다.
    private var resumeCandidatesVisible: [DesktopSession] {
        resumeCandidates.filter { !hiddenItems.isResumeHidden($0.sessionId) }
    }

    /// 이어 받기 후보도 같은 패턴. 별도 필터는 없으므로 단순 prefix.
    private var visibleResumeCandidates: [DesktopSession] {
        let base = resumeCandidatesVisible
        if base.count > 5 && !resumeExpanded {
            return Array(base.prefix(5))
        }
        return base
    }

    /// 단순 셸(zsh) 어댑터인지. shell 에는 "도구 자동 승인" / "데스크탑 이어받기" 가
    /// 의미 없어 두 섹션을 숨긴다. 새 단순-셸 어댑터가 늘면 이 분기를 daemon 의
    /// capability flag (예: `hide_bypass_permissions`, `hide_resume`) 로 일반화.
    private var agentIsPlainShell: Bool {
        selectedAgentId == "shell"
    }

    /// 로컬 LLM 어댑터(daemon `local_llm`, Qwen Code) 선택 여부. 준비 게이팅은 로컬 추론 군
    /// (local_llm+opencode)으로 일반화됐고, 이 플래그는 qwen 을 «요구하는» 분기(런타임 설치에
    /// qwen 행 노출, generic CLI 게이트에서 제외)에만 남는다 — opencode 는 qwen 불필요.
    private var agentIsLocalLlm: Bool {
        selectedAgentId == "local_llm"
    }

    /// 로컬 추론 백엔드를 공유하는 군(local_llm·opencode) 선택 여부 — 동시 1개 제약 + 준비
    /// 상태 카드/게이트(localLlmSection·localLlmReady·localLlmNeedsSetup)에 쓴다.
    private var agentIsLocalInference: Bool {
        selectedAgentId == "local_llm" || selectedAgentId == "opencode"
    }

    /// OpenCode 어댑터 선택 여부 — local_llm 과 같은 llama-server 백엔드+GGUF 를 공유하되 qwen 은
    /// 불필요(OpenCode 가 자체 CLI). 준비 판정에서 qwen 을 빼는 분기 + 「내 로컬 서버 사용」 외부
    /// 엔드포인트 섹션 게이팅에 쓴다.
    private var agentIsOpenCode: Bool {
        selectedAgentId == "opencode"
    }

    /// OpenCode CLI 가 Mac 에 설치돼 있는지 — 준비 카드의 「OpenCode CLI」 체크 행에 쓴다(설치
    /// 게이팅·설치 버튼은 generic CLI 경로 selectedAgentNeedsCliInstall/cliInstallFooter 가 전담).
    /// 옛 daemon 은 installed 를 안 보내 isInstalled==true → 「준비됨」 으로 본다(회귀 방지).
    private var opencodeCliInstalled: Bool {
        agents.first(where: { $0.id == "opencode" })?.isInstalled ?? true
    }

    /// daemon 이 OpenCode 외부 엔드포인트 모드를 지원하는지(opencode 어댑터의 `opencode_external_v1`
    /// capability). 옛 daemon 은 이 플래그가 없어 false → 섹션을 숨기고 라우트도 없으니 막다른 길 0.
    private var opencodeSupportsExternal: Bool {
        agents.first(where: { $0.id == "opencode" })?.capabilities.contains("opencode_external_v1") ?? false
    }

    /// draft 가 저장된 설정과 달라 «저장» 이 필요한 상태. 미조회면 false(저장 버튼 비활성).
    private var opencodeDirty: Bool {
        guard let loaded = opencodeLoaded else { return false }
        return loaded.enabled != opencodeEnabledDraft
            || loaded.baseUrl != opencodeBaseUrlDraft
            || loaded.modelId != opencodeModelDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// «저장된» 외부 엔드포인트 모드가 켜져 있는지 — daemon 이 번들 llama-server 의 ensureServer 를
    /// 건너뛰고 사용자 서버를 백엔드로 쓰므로, 이때 opencode 는 번들 런타임/모델 준비 게이트를
    /// 받지 않는다. draft 가 아니라 저장값을 본다(실제 spawn 이 쓰는 진실과 일치).
    private var opencodeExternalActive: Bool {
        agentIsOpenCode && (opencodeLoaded?.enabled ?? false)
    }

    /// daemon 이 런타임 구성요소(llama-server/qwen)를 폰에서 한 탭으로 Mac 에 설치하는 라우트를
    /// 지원하는지(local_llm 어댑터의 `install_runtime_v1` capability). 옛 daemon 은 이 플래그가
    /// 없어 false → 폰은 기존 「Mac 에서 설치」 verbatim 안내로 폴백(회귀 없음).
    private var localLlmSupportsRuntimeInstall: Bool {
        agents.first(where: { $0.id == "local_llm" })?.capabilities.contains("install_runtime_v1") ?? false
    }

    /// 로컬 추론 에이전트를 골랐지만 이미 활성 로컬 추론 세션(local_llm/opencode)이 있어 생성이
    /// 막힌 상태. 「만들기」 버튼을 비활성화하고 도구 섹션에 안내를 띄운다.
    private var localLlmBlocked: Bool {
        agentIsLocalInference && localLlmActive
    }

    /// 로컬 추론(local_llm·opencode)을 골랐고 추론 서버 런타임이 빠진 상태 — 폰을 떠나지 않고
    /// 「로컬 LLM 모델」 카드에서 Mac 에 설치할 수 있다. local_llm 은 llama-server + qwen 둘 다,
    /// opencode 는 qwen 불필요라 llama-server 만 본다. status 미조회/실패 시엔 잘못된 경고를
    /// 띄우지 않도록 false(기존 「조회 전 안내 안 함」 동작 유지).
    private var localLlmNeedsSetup: Bool {
        guard agentIsLocalInference, !opencodeExternalActive, let st = llmStatus else { return false }
        return agentIsOpenCode ? !st.binaries.llamaServer : !st.binariesReady
    }

    /// 추론 서버·모델이 준비돼 로컬 추론 세션을 만들 수 있는 상태. 비-로컬추론 에이전트는 항상
    /// true(이 게이트와 무관). opencode 는 qwen 불필요(llama-server + 모델만), local_llm 은 qwen
    /// 까지 필요(binariesReady). opencode CLI 설치는 generic CLI 게이트(selectedAgentNeedsCliInstall)
    /// 가 따로 막는다. status 미조회/실패면 false(준비 확인 전 생성 차단 — 막다른 길 대신 섹션이
    /// 무엇이 빠졌는지 보여 준다).
    private var localLlmReady: Bool {
        guard agentIsLocalInference else { return true }
        // 외부 엔드포인트 모드면 번들 런타임/모델과 무관 — 사용자 서버가 백엔드라 항상 준비됨.
        if opencodeExternalActive { return true }
        guard let st = llmStatus else { return false }
        let binariesOK = agentIsOpenCode ? st.binaries.llamaServer : st.binariesReady
        return binariesOK && st.modelPresent
    }

    /// 로컬 추론을 골랐지만 아직 추론 서버/모델이 준비되지 않아 「만들기」 를 막아야 하는 상태.
    private var localLlmCreateBlocked: Bool {
        agentIsLocalInference && !localLlmReady
    }

    /// 추론 서버는 있는데 선택 모델만 아직 안 받은 상태 — 런타임 설치 안내가 아니라 모델 다운로드만
    /// 유도하는 푸터를 띄우는 데 쓴다. status 미조회/실패면 false.
    private var localLlmModelMissing: Bool {
        guard agentIsLocalInference, !opencodeExternalActive, let st = llmStatus else { return false }
        let binariesOK = agentIsOpenCode ? st.binaries.llamaServer : st.binariesReady
        return binariesOK && !st.modelPresent
    }

    /// 선택된 agent (local_llm 제외) 의 CLI 가 Mac 에 설치돼 있지 않은 상태. 옛 daemon 은
    /// installed 를 안 보내 isInstalled==true → 게이팅 안 함 (기존 동작). local_llm 은 위
    /// localLlmNeedsSetup(qwen+llama-server) 가 전담하므로 여기서 제외한다. 이 게이팅이
    /// 미설치 CLI 로 세션을 만들어 첫 메시지에서 빈 화면(silent failure)을 밟는 걸 막는다.
    private var selectedAgentNeedsCliInstall: Bool {
        guard !agentIsLocalLlm else { return false }
        guard let a = agents.first(where: { $0.id == selectedAgentId }) else { return false }
        return !a.isInstalled
    }

    /// 선택된 에이전트가 프로 전용이면 그 ProFeature(shell→.terminal / local_llm→.localLLM), 아니면 nil.
    private var selectedAgentProFeature: ProFeature? {
        ProFeature.forAgent(selectedAgentId)
    }

    /// Terminal(shell)·Local LLM(local_llm) 은 프로 전용 — 미보유 사용자는 이 에이전트로 세션을
    /// 만들 수 없다(만들기 비활성 + 푸터 안내). 무료 단계(iapEnabled=false)엔 isUnlocked=true 라 통과.
    private var proAgentBlocked: Bool {
        guard let f = selectedAgentProFeature else { return false }
        return !purchase.isUnlocked(f)
    }

    /// worktree 생성은 프로 전용 — 미보유 사용자가 토글을 켜려 하면 페이월로 보낸다(채팅
    /// BranchSheet 의 worktree 게이트와 통일). 토글 자체를 막으므로 worktreeMode 가 «프로 없이»
    /// true 가 되는 경로가 없다 — 단, createTapped 에서도 방어적으로 한 번 더 막는다.
    private var worktreeProBlocked: Bool {
        !purchase.isUnlocked(.worktree)
    }

    /// 선택된 미설치 agent 의 설치 명령/URL (daemon 동봉, 코드성 문자열). 없으면 nil.
    private var selectedAgentInstallHint: String? {
        agents.first(where: { $0.id == selectedAgentId })?.installHint
    }

    /// 선택된 미설치 agent 의 installHint 가 «실행 가능한 명령» 인지 (URL 이 아님). true 면
    /// 「Mac 에 설치」 버튼으로 자동 설치, false (agy 의 URL) 면 링크 안내로 폴백.
    private var selectedAgentInstallHintIsCommand: Bool {
        agents.first(where: { $0.id == selectedAgentId })?.installHintIsCommand ?? false
    }

    /// 도구 옵션 표시 색 — Terminal(shell)·Local LLM(local_llm)·OpenCode(opencode) 같은 «고급
    /// 도구» 는 주황(Theme.pro)으로 구분한다 (앱의 «주황=프로/고급» 약속색). 일반 코드 에이전트는 기본색.
    private func agentOptionColor(_ id: String) -> Color {
        (id == "shell" || id == "local_llm" || id == "opencode") ? Theme.pro : .primary
    }

    /// 옵션 행에 「설정 필요」 마커를 붙일지 — local_llm 은 런타임(qwen+llama-server)·선택 모델,
    /// opencode 는 llama-server·선택 모델·OpenCode CLI(qwen 불필요), 그 외 agent 는 CLI 바이너리
    /// 미설치(daemon installed=false) 기준. 로컬 추론은 status 가 로드된 뒤에만 판단해(미조회 중
    /// false-positive 깜빡임 방지) 마커를 붙인다.
    private func agentNeedsSetupMarker(_ a: AgentInfo) -> Bool {
        if a.id == "local_llm" {
            return llmStatus.map { !($0.binariesReady && $0.modelPresent) } ?? false
        } else if a.id == "opencode" {
            let runtimeMissing = llmStatus.map { !($0.binaries.llamaServer && $0.modelPresent) } ?? false
            return runtimeMissing || !a.isInstalled
        } else {
            return !a.isInstalled
        }
    }

    /// 도구 선택 inline picker 의 한 옵션 행. shell/local_llm/opencode 는 주황, 준비 안 된
    /// 어댑터는 「설정 필요」 마커를 붙인다.
    @ViewBuilder
    private func agentOptionRow(_ a: AgentInfo) -> some View {
        let needsSetup = agentNeedsSetupMarker(a)
        HStack(spacing: 8) {
            Image(systemName: AgentKind.from(id: a.id).systemImage)
                .foregroundStyle(agentOptionColor(a.id))
            Text(a.displayName)
                .foregroundStyle(agentOptionColor(a.id))
            if needsSetup {
                Text("설정 필요")
                    .font(.caption2)
                    .foregroundStyle(Theme.warning)
            }
            // 프로 전용 에이전트(Terminal·로컬 LLM) — 미보유면 «프로» 마커로 결제 필요를 표시.
            if let f = ProFeature.forAgent(a.id), !purchase.isUnlocked(f) {
                Text("프로")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Theme.pro)
            }
        }
    }

    /// 도구 섹션 푸터 — 우선순위: Mac 런타임 미설치 안내 > 동시 1개 제약 > 일반 설명.
    @ViewBuilder
    private var toolFooter: some View {
        if proAgentBlocked {
            VStack(alignment: .leading, spacing: 4) {
                Text("Terminal·로컬 LLM 은 프로 전용이에요. 프로 구독 또는 평생 이용권으로 잠금을 해제하세요.")
                Button("프로 보기") { paywallFeature = selectedAgentProFeature }
                    .font(.caption2.weight(.semibold))
            }
            .font(.caption2)
            .foregroundStyle(Theme.pro)
        } else if localLlmNeedsSetup {
            if localLlmSupportsRuntimeInstall {
                // 막다른 길 제거 — 아래 「로컬 LLM 모델」 카드에서 폰으로 바로 설치 가능.
                if agentIsOpenCode {
                    // opencode 는 qwen 불필요 — 추론 서버만 런타임 설치. OpenCode CLI 는 아래
                    // generic CLI 설치(cliInstallFooter)가 전담한다.
                    Text("로컬 추론을 실행하려면 추론 서버(llama.cpp)가 필요해요. 아래 「로컬 LLM 모델」 에서 폰으로 바로 설치할 수 있어요.")
                        .font(.caption2)
                        .foregroundStyle(Theme.warning)
                } else {
                    Text("로컬 LLM 을 실행하려면 추론 서버(llama.cpp)와 에이전트 CLI(Qwen Code)가 필요해요. 아래 「로컬 LLM 모델」 에서 폰으로 바로 설치할 수 있어요.")
                        .font(.caption2)
                        .foregroundStyle(Theme.warning)
                }
            } else {
                if agentIsOpenCode {
                    Text("로컬 추론을 실행하려면 Mac 앱에서 추가 설정이 필요해요. Mac 앱 → 설정 → 로컬 LLM 탭에서 추론 서버(llama.cpp)를 설치하세요.")
                        .font(.caption2)
                        .foregroundStyle(Theme.warning)
                } else {
                    Text("로컬 LLM 을 실행하려면 Mac 앱에서 추가 설정이 필요해요. Mac 앱 → 설정 → 로컬 LLM 탭에서 추론 서버(llama.cpp)와 에이전트 CLI(Qwen Code)를 설치하세요.")
                        .font(.caption2)
                        .foregroundStyle(Theme.warning)
                }
            }
        } else if selectedAgentNeedsCliInstall {
            cliInstallFooter
        } else if localLlmModelMissing {
            // 추론 서버·CLI 는 있고 모델만 없음 — 막다른 길 대신 아래 카드에서 모델만 받게 유도.
            Text("선택한 모델이 아직 다운로드되지 않았어요. 아래 「로컬 LLM 모델」 에서 모델을 받아 주세요.")
                .font(.caption2)
                .foregroundStyle(Theme.warning)
        } else if localLlmBlocked {
            Text("로컬 추론 세션은 메모리를 많이 차지해 한 번에 하나만 만들 수 있어요. 기존 로컬 추론 세션을 먼저 종료하세요.")
                .font(.caption2)
                .foregroundStyle(Theme.warning)
        } else {
            Text("이 세션에서 사용할 CLI 도구입니다. daemon 에 등록된 어댑터가 모두 노출됩니다.")
                .font(.caption2)
        }
    }

    // MARK: - 로컬 추론 준비 상태 + 모델 관리 섹션
    //
    // 로컬 추론(local_llm·opencode) 선택 시 노출. 단일 boolean 환원 대신 daemon `/api/local-llm/status`
    // 세부(바이너리·선택 모델·다운로드 진행)를 상태 카드로 표면화하고, 카탈로그를 받아 폰에서
    // 다운로드 시작/취소·모델 선택을 직접 처리한다. 두 어댑터는 같은 llama-server 백엔드+GGUF 를
    // 공유한다 — opencode 는 qwen 불필요라 그 행을 OpenCode CLI 로 바꾸고 런타임 설치에서 qwen 을
    // 건너뛴다. 「Mac 에서 설치」 안내는 추론 서버 바이너리가 빠진 경우만 유지(Mac 권한 영역).
    // 색: 상태=success/warning, 다운로드 진행은 기본 accent(주황 pro·노랑 warning 오용 금지).

    @ViewBuilder
    private var localLlmSection: some View {
        // 외부 엔드포인트 모드(opencode)면 번들 런타임 준비/설치 카드는 무의미 — 숨긴다.
        if agentIsLocalInference && !opencodeExternalActive {
            Section {
                if let st = llmStatus {
                    llmStatusCard(st)
                    // 런타임 설치가 필요한 추론 서버 바이너리 — opencode 는 llama-server 만, local_llm
                    // 은 llama-server+qwen. (opencode CLI 는 generic CLI 설치가 전담.)
                    let runtimeMissing = agentIsOpenCode ? !st.binaries.llamaServer : !st.binariesReady
                    if runtimeMissing {
                        if localLlmSupportsRuntimeInstall {
                            // 막다른 길 제거 — 폰을 떠나지 않고 빠진 구성요소만 Mac 에 바로 설치.
                            llmRuntimeInstall(st)
                        } else if agentIsOpenCode {
                            // 옛 daemon — 설치 라우트 없음. opencode 는 추론 서버만 안내(qwen 불필요).
                            Text("추론 서버(llama.cpp)는 Mac 에서 설치해야 해요. Mac 앱 → 설정 → 로컬 LLM 탭에서 설치하세요.")
                                .font(.caption2)
                                .foregroundStyle(Theme.warning)
                                .fixedSize(horizontal: false, vertical: true)
                        } else {
                            // 옛 daemon — 설치 라우트 없음. 기존 안내로 폴백(회귀 없음).
                            Text("추론 서버(llama.cpp)와 에이전트 CLI(Qwen Code)는 Mac 에서 설치해야 해요. Mac 앱 → 설정 → 로컬 LLM 탭에서 설치하세요.")
                                .font(.caption2)
                                .foregroundStyle(Theme.warning)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    ForEach(llmModels) { m in
                        llmModelRow(m, status: st)
                    }
                } else if let llmLoadError {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("로컬 LLM 상태를 불러오지 못했어요.")
                            .font(.caption)
                        Text(llmLoadError)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                        Button("다시 시도") { Task { await loadLocalLlm() } }
                            .font(.caption)
                    }
                } else {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("로컬 LLM 상태 확인 중…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if let llmError {
                    Text(llmError)
                        .font(.caption2)
                        .foregroundStyle(Theme.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } header: {
                Text("로컬 LLM 모델")
            } footer: {
                if agentIsOpenCode {
                    Text("폰에서 모델을 받아 두면 Mac 앞으로 가지 않고 바로 로컬 추론 세션을 시작할 수 있어요. OpenCode 는 같은 모델을 공유해요. 추론 서버·OpenCode CLI 설치는 Mac 에서만 가능해요.")
                        .font(.caption2)
                } else {
                    Text("폰에서 모델을 받아 두면 Mac 앞으로 가지 않고 바로 로컬 LLM 세션을 시작할 수 있어요. 추론 서버·에이전트 CLI 설치는 Mac 에서만 가능해요.")
                        .font(.caption2)
                }
            }
        }
    }

    // MARK: - OpenCode 「내 로컬 서버 사용」 외부 엔드포인트 섹션
    //
    // opencode 선택 + daemon capability(opencode_external_v1) 일 때만 노출. 켜면 사용자가 이미
    // 돌리는 OpenAI 호환 로컬 서버(Ollama 등)를 그대로 백엔드로 쓴다 — 번들 모델 중복 다운로드
    // 없이 «내 모델 그대로». 저장 전 /v1/models 헬스체크로 도달성·모델 존재를 검증해 막다른 길을
    // 사전 차단한다. 색: 「고급 도구」 약속색 주황(Theme.pro) 헤더, 확인 결과 success/warning.

    @ViewBuilder
    private var opencodeSection: some View {
        if agentIsOpenCode && opencodeSupportsExternal {
            Section {
                Toggle(isOn: $opencodeEnabledDraft) {
                    Label("내 로컬 서버 사용", systemImage: "server.rack")
                        .foregroundStyle(Theme.pro)
                }
                .tint(Theme.pro)
                .onChange(of: opencodeEnabledDraft) { _ in opencodeProbe = nil }

                if opencodeEnabledDraft {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("서버 주소")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        // baseURL·모델 id 는 코드성 식별자라 번역/자동대문자/자동수정 대상 아님.
                        TextField("http://localhost:11434/v1", text: $opencodeBaseUrlDraft)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .font(.callout.monospaced())
                            .onChange(of: opencodeBaseUrlDraft) { _ in opencodeProbe = nil }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("모델 이름")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        TextField("qwen2.5-coder", text: $opencodeModelDraft)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.callout.monospaced())
                            .onChange(of: opencodeModelDraft) { _ in opencodeProbe = nil }
                    }

                    // 확인(/v1/models 헬스체크) + 저장. 확인은 입력값으로 바로, 저장은 변경 있을 때만.
                    HStack(spacing: 12) {
                        Button {
                            Task { await verifyOpencode() }
                        } label: {
                            if opencodeBusy {
                                ProgressView()
                            } else {
                                Label("연결 확인", systemImage: "antenna.radiowaves.left.and.right")
                                    .font(.caption.weight(.semibold))
                            }
                        }
                        .disabled(opencodeBusy || opencodeBaseUrlDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                        Spacer()
                        Button("저장") { Task { await saveOpencode() } }
                            .font(.caption.weight(.semibold))
                            .disabled(opencodeBusy || !opencodeDirty)
                    }

                    if let probe = opencodeProbe {
                        opencodeProbeResult(probe)
                    }
                } else if opencodeDirty {
                    // 끄기만 한 상태도 저장이 필요 — 명시 버튼으로.
                    HStack {
                        Spacer()
                        Button("저장") { Task { await saveOpencode() } }
                            .font(.caption.weight(.semibold))
                            .disabled(opencodeBusy)
                    }
                }

                if let opencodeError {
                    Text(opencodeError)
                        .font(.caption2)
                        .foregroundStyle(Theme.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } header: {
                Text("로컬 서버")
            } footer: {
                if opencodeEnabledDraft {
                    Text("이미 Mac 에서 돌리고 있는 OpenAI 호환 로컬 서버(Ollama·LM Studio·vLLM 등)를 그대로 씁니다. 번들 모델을 새로 받지 않고 내가 고른 모델로 OpenCode 를 실행해요. 저장 전 「연결 확인」 으로 서버가 떠 있고 모델 이름이 맞는지 점검하세요.")
                        .font(.caption2)
                } else {
                    Text("켜면 번들 추론 서버 대신 내가 직접 돌리는 OpenAI 호환 로컬 서버를 OpenCode 백엔드로 씁니다. 꺼져 있으면 번들 llama.cpp 를 사용해요.")
                        .font(.caption2)
                }
            }
        }
    }

    /// 헬스체크 결과 표시 — 정상이면 success(초록), 도달 불가/모델 없음 등은 warning(노랑, 진짜
    /// 「설정 필요」 경고라 warning 이 맞다 — 주황 pro 와 혼동 금지). 서버가 보고한 모델 목록도
    /// 곁들여 사용자가 올바른 이름을 고를 수 있게 한다.
    @ViewBuilder
    private func opencodeProbeResult(_ probe: OpencodeExternalProbe) -> some View {
        let ok = probe.error == nil
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(ok ? Theme.success : Theme.warning)
                Text(opencodeProbeMessage(probe))
                    .font(.caption)
                    .foregroundStyle(ok ? Theme.success : Theme.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // 서버가 모델을 보고했고 설정 모델이 그 안에 없을 때 — 어떤 이름을 써야 하는지 노출.
            if !probe.models.isEmpty && !probe.modelPresent {
                Text("사용 가능한 모델: \(probe.models.prefix(8).joined(separator: ", "))")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// 헬스체크 결과를 사람이 읽는 한 줄로. error 코드별 안내(막다른 길의 «왜» 를 설명).
    private func opencodeProbeMessage(_ probe: OpencodeExternalProbe) -> LocalizedStringKey {
        switch probe.error {
        case nil: return "연결됨 · 모델 확인됨"
        case "unreachable": return "서버에 연결할 수 없어요. 주소가 맞고 서버가 켜져 있는지 확인하세요."
        case "http_error": return "서버가 오류를 돌려줬어요. 주소(특히 /v1 경로)를 확인하세요."
        case "bad_response": return "응답을 이해할 수 없어요. OpenAI 호환 서버가 맞는지 확인하세요."
        case "no_models": return "서버는 떠 있지만 제공하는 모델이 없어요. 서버에서 모델을 먼저 로드하세요."
        case "model_not_found": return "서버에 그 모델이 없어요. 아래 목록에서 정확한 이름을 골라 입력하세요."
        default: return "연결을 확인하지 못했어요."
        }
    }

    /// 준비 상태 카드 — 하드웨어 + 「추론 서버 / 에이전트 CLI / 선택 모델」 체크리스트.
    @ViewBuilder
    private func llmStatusCard(_ st: LocalLlmStatus) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // "Apple M4 Pro · 64 GB" — 칩/용량은 번역 대상 아님.
            let ram = Int((Double(st.hardware.totalRamBytes) / 1_073_741_824).rounded())
            let chip = st.hardware.chipBrand ?? "Mac"
            HStack(spacing: 8) {
                Image(systemName: "memorychip")
                    .foregroundStyle(.secondary)
                Text(verbatim: "\(chip) · \(ram) GB")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer()
            }
            llmCheckRow(ok: st.binaries.llamaServer, label: "추론 서버 (llama.cpp)")
            // opencode 는 qwen 불필요 — 그 행을 OpenCode CLI 행으로 대체(설치는 generic CLI 경로).
            // local_llm 은 기존대로 Qwen Code 행.
            if agentIsOpenCode {
                llmCheckRow(ok: opencodeCliInstalled, label: "OpenCode CLI")
            } else {
                llmCheckRow(ok: st.binaries.qwen, label: "에이전트 CLI (Qwen Code)")
            }
            llmCheckRow(ok: st.modelPresent, label: "선택 모델 다운로드")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 체크리스트 한 줄 — 준비됨(초록 success) / 필요(노랑 warning). 「필요」 는 진짜 미설치
    /// 경고라 warning(노랑)이 맞다(주황 pro 와 혼동 금지).
    @ViewBuilder
    private func llmCheckRow(ok: Bool, label: LocalizedStringKey) -> some View {
        HStack(spacing: 8) {
            Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .foregroundStyle(ok ? Theme.success : Theme.warning)
            Text(label)
                .font(.caption)
            Spacer()
            (ok ? Text("준비됨") : Text("필요"))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(ok ? Theme.success : Theme.warning)
        }
    }

    /// 런타임 구성요소(추론 서버/CLI) 설치 — 빠진 것만 「Mac 에 설치」 버튼을 보이고, 누르면
    /// daemon 이 설치하는 동안 진행/로그/완료/실패를 그 자리에 표시한다(8ffc54d2 CLI 설치와 동일
    /// UX). 색: 안내=secondary, 버튼=기본 accent(주황 pro 오용 금지).
    @ViewBuilder
    private func llmRuntimeInstall(_ st: LocalLlmStatus) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if agentIsOpenCode {
                // opencode 는 추론 서버만 런타임 설치(qwen 불필요). OpenCode CLI 는 아래 generic
                // CLI 설치(cliInstallFooter)가 전담.
                Text("추론 서버를 폰을 떠나지 않고 Mac 에 바로 설치할 수 있어요.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("추론 서버·에이전트 CLI 를 폰을 떠나지 않고 Mac 에 바로 설치할 수 있어요.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !st.binaries.llamaServer {
                llmComponentInstallRow(component: "llama-server", label: "추론 서버 (llama.cpp)")
            }
            // qwen 은 local_llm 전용 — opencode 는 건너뛴다(자체 OpenCode CLI 사용).
            if !agentIsOpenCode && !st.binaries.qwen {
                llmComponentInstallRow(component: "qwen", label: "에이전트 CLI (Qwen Code)")
            }
        }
        .font(.caption2)
    }

    /// 구성요소 한 줄 — 설치 전엔 라벨 + 「Mac 에 설치」, 설치 중/후엔 진행 상태(스피너·로그·완료/실패).
    /// 진행 스냅샷의 adapterId(`local_llm/<component>`)가 이 행과 일치할 때만 진행 UI 를 그린다 —
    /// 한 번에 한 구성요소만 설치되므로 다른 행 버튼은 그 동안 비활성.
    @ViewBuilder
    private func llmComponentInstallRow(component: String, label: LocalizedStringKey) -> some View {
        let targetId = "local_llm/\(component)"
        let active = installProgress.map { $0.adapterId == targetId } ?? false
        VStack(alignment: .leading, spacing: 6) {
            if active, let p = installProgress, p.isInstalling || p.isError || p.isDone {
                HStack(spacing: 6) {
                    Text(label).font(.caption.weight(.medium))
                    Spacer()
                }
                installProgressView(p)
                // brew 미설치 Mac — 막다른 길로 되돌아가지 않게 명확히 안내.
                if p.isError && component == "llama-server" {
                    brewMissingFallback
                }
            } else {
                HStack(spacing: 8) {
                    Text(label).font(.caption)
                    Spacer()
                    Button {
                        startComponentInstall(component)
                    } label: {
                        Label("Mac 에 설치", systemImage: "arrow.down.circle")
                            .font(.caption2.weight(.semibold))
                    }
                    // 한 번에 하나만 — 다른 구성요소 설치 중엔 비활성(daemon 도 409 busy).
                    .disabled(installProgress?.isInstalling ?? false)
                }
            }
        }
    }

    /// llama.cpp 설치 실패 시 Homebrew 부재 폴백 안내 — brew.sh 링크로 막힘을 푼다.
    private var brewMissingFallback: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Homebrew 가 없으면 llama.cpp 를 설치할 수 없어요. brew.sh 에서 Homebrew 를 설치한 뒤 다시 시도하세요.")
                .font(.caption2)
                .foregroundStyle(Theme.warning)
                .fixedSize(horizontal: false, vertical: true)
            Link(destination: URL(string: "https://brew.sh")!) {
                Label("brew.sh 열기", systemImage: "safari")
                    .font(.caption2.weight(.semibold))
            }
        }
    }

    /// 카탈로그 모델 한 행 — 뱃지(추천/선택됨/받음) + 용량 + 권장 RAM, 그리고 다운로드 진행 또는
    /// 다운로드/선택 액션.
    @ViewBuilder
    private func llmModelRow(_ m: LocalLlmCatalogModel, status st: LocalLlmStatus) -> some View {
        let recRam = Int((Double(m.recommendedRamBytes) / 1_073_741_824).rounded())
        let tight = st.hardware.totalRamBytes < m.recommendedRamBytes
        let downloadingThis = st.download.modelId == m.id && st.download.active
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(verbatim: m.displayName)
                    .font(.subheadline.weight(.semibold))
                if m.id == llmRecommendedId { llmBadge("추천", Theme.success) }
                if m.id == llmSelectedId { llmBadge("선택됨", Theme.accent) }
                if m.downloaded { llmBadge("받음", .secondary) }
                Spacer()
                Text(verbatim: llmSizeGB(m.fileSizeBytes))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Text(verbatim: m.description)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                Text(verbatim: "≥ \(recRam) GB RAM · ~\(Int(m.estDecodeTokSec)) tok/s")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(tight ? Theme.warning : .secondary)
                if tight {
                    Text("이 Mac 메모리엔 빠듯할 수 있어요")
                        .font(.caption2)
                        .foregroundStyle(Theme.warning)
                }
                Spacer()
                // 도구호출 적합성 — 의미 토큰 준수: «분석 전용»은 진짜 경고라 warning(노랑),
                // 도구호출 가능은 정상값이라 중립(secondary). pro(주황)·success(초록) 빌려쓰지 않음.
                if m.isToolCallCapable {
                    Label("도구호출", systemImage: "wrench.and.screwdriver")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                } else {
                    Label("분석 전용", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(Theme.warning)
                }
            }
            if downloadingThis {
                llmDownloadProgress(st.download)
            } else {
                llmModelActions(m, status: st)
            }
        }
        .padding(.vertical, 4)
    }

    private func llmBadge(_ text: LocalizedStringKey, _ color: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.18))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }

    /// 진행률 + 취소. 진행 막대는 기본 틴트(accent) — status 색을 진행 표시에 빌려쓰지 않는다.
    @ViewBuilder
    private func llmDownloadProgress(_ d: LocalLlmDownloadProgress) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if d.state == "verifying" {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("검증 중…").font(.caption2)
                }
            } else {
                ProgressView(value: min(1, max(0, d.percent / 100)))
                Text(verbatim: llmProgressText(d))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Button(role: .destructive) {
                Task { await cancelLlmDownload() }
            } label: {
                Label("취소", systemImage: "xmark.circle")
            }
            .font(.caption2)
            .controlSize(.small)
        }
    }

    @ViewBuilder
    private func llmModelActions(_ m: LocalLlmCatalogModel, status st: LocalLlmStatus) -> some View {
        HStack(spacing: 12) {
            if m.downloaded {
                if m.id != llmSelectedId {
                    Button {
                        Task { await selectLlmModel(m.id) }
                    } label: {
                        Label("선택", systemImage: "checkmark.circle")
                    }
                    .font(.caption)
                    // 분석 전용(도구호출 불가) 모델은 에이전트 백엔드로 못 쓴다 — 선택 비활성.
                    .disabled(llmBusyModelId != nil || !m.isToolCallCapable)
                }
            } else {
                Button {
                    Task { await startLlmDownload(m.id) }
                } label: {
                    Label("다운로드", systemImage: "arrow.down.circle")
                }
                .font(.caption)
                .disabled(st.download.active || llmBusyModelId != nil)
            }
            Spacer()
            if llmBusyModelId == m.id {
                ProgressView().controlSize(.small)
            }
        }
    }

    // MARK: 로컬 LLM 표시 헬퍼 (번역 대상 아님 — 숫자/단위)

    private func llmSizeGB(_ bytes: Int64) -> String {
        String(format: "%.1f GB", Double(bytes) / 1_000_000_000)
    }

    private func llmProgressText(_ d: LocalLlmDownloadProgress) -> String {
        let pct = Int(d.percent.rounded())
        if d.bytesPerSec > 0 {
            let mbps = String(format: "%.0f", d.bytesPerSec / 1_000_000)
            return "\(pct)% · \(mbps) MB/s"
        }
        return "\(pct)%"
    }

    /// 미설치 CLI 푸터 — installHint 가 명령이면 「Mac 에 설치」 버튼(폰을 안 떠나고 설치),
    /// URL(agy)이면 기존 안내 + 링크. 설치가 시작되면 진행/로그/완료/실패를 그 자리에 표시한다.
    @ViewBuilder
    private var cliInstallFooter: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let p = installProgress, p.isInstalling || p.isError || p.isDone {
                // 진행/완료/실패 — 진행이 시작된 뒤엔 상태 UI 가 안내문을 대체.
                installProgressView(p)
            } else if selectedAgentInstallHintIsCommand {
                // 자동 설치 가능 — Mac 책상으로 돌아가지 않고 폰에서 바로 설치.
                Text("이 코드 에이전트 CLI 가 Mac 에 아직 설치돼 있지 않아요. 폰을 떠나지 않고 Mac 에서 바로 설치할 수 있어요.")
                    .foregroundStyle(Theme.warning)
                Button {
                    startInstall()
                } label: {
                    Label("Mac 에 설치", systemImage: "arrow.down.circle")
                        .font(.caption2.weight(.semibold))
                }
                if let hint = selectedAgentInstallHint {
                    Text(verbatim: hint)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            } else {
                // URL hint (agy) 또는 hint 없음 — 자동 설치 불가, 기존 안내 + 링크.
                Text("이 코드 에이전트 CLI 가 Mac 에 설치돼 있지 않아요. Mac 앱이 실행 중인 데스크탑에서 설치한 뒤 다시 시도하세요.")
                    .foregroundStyle(Theme.warning)
                if let hint = selectedAgentInstallHint {
                    if let url = URL(string: hint) {
                        Link(destination: url) {
                            Label("설치 가이드 열기", systemImage: "safari")
                                .font(.caption2.weight(.semibold))
                        }
                    } else {
                        Text(verbatim: hint)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
            }
        }
        .font(.caption2)
    }

    /// 설치 진행 표시 — 스피너+상태, 누적 로그(말미), 실패 시 원문 명령 복사 폴백 + 재시도.
    @ViewBuilder
    private func installProgressView(_ p: AgentInstallProgress) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                if p.isInstalling {
                    ProgressView()
                    Text("Mac 에 설치하는 중…")
                        .foregroundStyle(.secondary)
                } else if p.isDone {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Theme.success)
                    Text("설치 완료")
                        .foregroundStyle(Theme.success)
                } else {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Theme.danger)
                    Text("설치 실패")
                        .foregroundStyle(Theme.danger)
                }
            }
            .font(.caption2)
            // 누적 stdout/stderr — 모노스페이스, 스크롤. 로그는 코드성이라 verbatim.
            if !p.log.isEmpty {
                ScrollView {
                    Text(verbatim: p.log)
                        .font(.system(.caption2, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 120)
            }
            if p.isError {
                // 막다른 길이 아니라 폴백 — 원문 명령을 Mac 터미널에서 직접 실행하도록 안내.
                Text("자동 설치에 실패했어요. 아래 명령을 Mac 터미널에서 직접 실행한 뒤 다시 시도하세요.")
                    .font(.caption2)
                    .foregroundStyle(Theme.danger)
                // brew 자체가 없어 실패한 경우만 (daemon homebrew_missing) — 정확한 Homebrew 설치
                // 안내로 분기. 빌드 오류 등 다른 실패엔 띄우지 않아 오해를 막는다.
                if p.isHomebrewMissing {
                    Text("Homebrew 가 없으면 llama.cpp 를 설치할 수 없어요. Mac 에서 brew.sh 의 Homebrew 를 설치한 뒤 다시 시도하세요.")
                        .font(.caption2)
                        .foregroundStyle(Theme.danger)
                }
                // npm/node 자체가 없어 실패한 경우 (daemon node_missing) — 정확한 Node.js 설치 안내로
                // 분기. npm 설치 명령은 Node.js 가 깔려 있어야 동작하는데 그 전제가 안내에 빠져 있었다.
                if p.isNodeMissing {
                    Text("Node.js(npm) 가 없으면 이 CLI 를 설치할 수 없어요. Mac 에서 nodejs.org 의 Node.js 를 설치한 뒤 다시 시도하세요.")
                        .font(.caption2)
                        .foregroundStyle(Theme.danger)
                }
                if let cmd = p.command ?? selectedAgentInstallHint {
                    Text(verbatim: cmd)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                Button {
                    retryInstall(for: p)
                } label: {
                    Label("다시 설치", systemImage: "arrow.clockwise")
                        .font(.caption2.weight(.semibold))
                }
            }
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                // 제목을 최상단으로. 시트가 열리는 순간 사용자가 가장 먼저 입력하는 필드 →
                // 레포/이어받기 목록을 한참 스크롤할 필요 없음. 빈칸이면 "제목 없음" 으로 저장.
                Section {
                    VoiceInputField("이 세션의 이름 (선택)", text: $title)
                } header: {
                    Text("제목")
                } footer: {
                    Text("비워두면 제목 없는 세션이 됩니다.")
                        .font(.caption2)
                }

                Section {
                    // inline 스타일 — 각 옵션을 행으로 그려야 텍스트 색(주황)이 안정적으로
                    // 적용된다 (.menu 는 시스템 UIMenu 라 항목 색을 무시함).
                    Picker(selection: $selectedAgentId) {
                        ForEach(agents) { a in
                            agentOptionRow(a).tag(a.id)
                        }
                    } label: {
                        Text("CLI 도구")
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    .accessibilityLabel(Text("CLI 도구"))
                    // 선택 체크 표시는 환경 tint 색을 따른다 → accent(보라)로 명시.
                    // 행 텍스트색(agentOptionColor: 주황/기본)은 foregroundStyle 로 따로 칠해져 영향 없음.
                    .tint(Theme.accent)
                } header: {
                    Text("도구")
                } footer: {
                    toolFooter
                }

                // 로컬 LLM 선택 시 — 준비 상태(바이너리·선택 모델) 표면화 + 카탈로그 다운로드/선택.
                // 막다른 길(한 줄 안내) 대신 폰에서 해결 가능한 것은 폰에서 처리하게 한다.
                localLlmSection

                // OpenCode 선택 시 — 「내 로컬 서버 사용」 외부 엔드포인트 설정(Ollama 등).
                opencodeSection

                if !agentIsPlainShell {
                    Section {
                        Toggle(isOn: $skipPermissions) {
                            // 프로 전용 기능이 아니므로 일반색(.primary)으로 — 주황은 «프로» 약속색이라
                            // 여기 쓰지 않는다. 켜짐/꺼짐 안내는 아래 footer 가 명확히 설명한다.
                            Label("도구 자동 승인", systemImage: "lock.open.fill")
                                .foregroundStyle(.primary)
                        }
                    } header: {
                        Text("권한")
                    } footer: {
                        if skipPermissions {
                            Text("켜져 있어요. bash / Write / Edit 같은 파일·셸 도구가 매번 묻지 않고 곧바로 실행됩니다. 신뢰하는 레포에서만 사용하세요.")
                                .font(.caption2)
                        } else {
                            Text("꺼져 있어요. 도구를 쓸 때마다 에이전트가 텍스트로 승인을 요청해, 응답이 잠시 멈출 수 있습니다.")
                                .font(.caption2)
                        }
                    }
                }

                Section {
                    // 파일 탐색기로 폴더 선택 — 텍스트로 전체 경로를 타이핑하지 않아도 된다.
                    Button {
                        showDirPicker = true
                    } label: {
                        Label("폴더 탐색해서 선택", systemImage: "folder")
                    }
                    if !repoPath.isEmpty {
                        Text(verbatim: repoPath)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                    if manualMode {
                        TextField("/Users/…/repo 경로 직접 입력", text: $repoPath)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                        // 경로 자동완성 도우미 — 현재 입력 prefix 기준으로 recents 에서
                        // 다음에 올 수 있는 디렉터리 segment 들을 칩으로 노출. 칩을 탭하면
                        // 현재 입력 끝에 이어붙고, 더 깊은 경로가 있으면 "/" 까지 자동 추가해
                        // 다음 단계 추천이 즉시 보이게 한다. TextField 는 그대로라서
                        // 신규 경로 입력은 막지 않는다.
                        if !pathSuggestions.isEmpty || !repoPath.isEmpty {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    if !repoPath.isEmpty {
                                        Button {
                                            popPathSegment()
                                        } label: {
                                            Label("한 단계 위로", systemImage: "arrow.uturn.left")
                                                .font(.caption2)
                                        }
                                        .buttonStyle(.bordered)
                                        .controlSize(.mini)
                                    }
                                    ForEach(pathSuggestions, id: \.self) { seg in
                                        Button {
                                            appendPathSegment(seg)
                                        } label: {
                                            Text(seg)
                                                .font(.caption2.monospaced())
                                        }
                                        .buttonStyle(.bordered)
                                        .controlSize(.mini)
                                    }
                                }
                                .padding(.vertical, 2)
                            }
                        }
                        Button("최근 사용 프로젝트에서 고르기") {
                            manualMode = false
                            repoPath = ""
                        }
                        .font(.caption)
                    } else {
                        if loadingRecents {
                            HStack {
                                ProgressView()
                                Text("Mac에서 최근 프로젝트 불러오는 중…")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        } else if let loadError {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("최근 목록을 못 가져왔습니다.")
                                    .font(.caption)
                                Text(loadError)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                                Button("다시 시도") { Task { await loadRecents() } }
                                    .font(.caption)
                            }
                        } else if recents.isEmpty {
                            Text("최근 사용 기록이 없습니다. 아래 ‘직접 입력’으로 경로를 적어 주세요.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            if recents.count > 6 {
                                TextField("필터", text: $filter)
                                    .autocorrectionDisabled()
                                    .textInputAutocapitalization(.never)
                            }
                            ForEach(visibleRecents) { p in
                                Button {
                                    repoPath = p.path
                                } label: {
                                    RecentRow(
                                        project: p,
                                        selected: p.path == repoPath,
                                        onHide: {
                                            // 현재 선택이 숨김 대상이면 입력 비움.
                                            if repoPath == p.path { repoPath = "" }
                                            hiddenItems.hideRecent(p.path)
                                        }
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                            // 5개 초과 + 필터 없는 상태에서만 펼치기. 필터가 켜져 있으면
                            // visibleRecents 가 이미 전체 결과를 반환하므로 이 버튼은 숨김.
                            if filter.isEmpty && filteredRecents.count > 5 {
                                Button {
                                    withAnimation { recentsExpanded.toggle() }
                                } label: {
                                    HStack(spacing: 6) {
                                        Image(systemName: recentsExpanded ? "chevron.up" : "chevron.down")
                                        Text(recentsExpanded
                                             ? "접기"
                                             : "더 보기 (\(filteredRecents.count - 5)개)")
                                    }
                                    .font(.caption)
                                    .foregroundStyle(.tint)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        Button {
                            manualMode = true
                            repoPath = ""
                        } label: {
                            Label("경로 직접 입력", systemImage: "keyboard")
                                .font(.caption)
                        }
                        // 흰색 라벨 + 약간 회색 배경. borderedProminent 는 틴트색 위에
                        // 자동으로 대비되는 (여기선 흰) 전경색을 깔아 준다.
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.neutralFill)
                        .controlSize(.small)
                    }
                } header: {
                    HStack(spacing: 6) {
                        Text("레포 경로")
                        if !hiddenItems.hiddenRecentPaths.isEmpty || !hiddenItems.hiddenResumes.isEmpty {
                            Spacer()
                            Button {
                                showHiddenSheet = true
                            } label: {
                                Text("숨김 \(hiddenItems.hiddenRecentPaths.count + hiddenItems.hiddenResumes.count)개")
                                    .font(.caption2)
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel(Text("숨김 항목 관리"))
                        }
                    }
                } footer: {
                    Text("Mac에서 최근에 코드 에이전트로 작업한 프로젝트들입니다. 골라서 바로 이어 작업할 수 있어요. 자주 안 쓰는 항목은 행 오른쪽 \(Image(systemName: "eye.slash")) 로 숨길 수 있어요.")
                        .font(.caption2)
                }

                // 선택한 레포가 git 저장소일 때만 — 채팅방을 거치지 않고 새 worktree 를 바로 만든다.
                if repoIsGit {
                    worktreeSection
                }

                // 경로가 비어 있어도 "이어 받기" 섹션 자체는 항상 표시한다.
                // 빈 상태에서는 "경로를 먼저 고르세요" 안내를 보여 줘서
                // 사용자가 어디서 이어받기 후보를 보게 되는지 한눈에 알 수 있게 한다.
                // shell 어댑터는 이어받기 개념 자체가 없어 섹션을 숨긴다.
                // worktree 모드면 새 브랜치+새 폴더라 데스크탑 이어받기와 결합 불가 — 섹션을 숨긴다.
                if !agentIsPlainShell && !worktreeMode {
                    resumeSection
                }
            }
            .navigationTitle("새 세션")
            .navigationBarTitleDisplayMode(.inline)
            .voiceDictationChrome()
            // (scoped .tint 제거됨 — AccentColor 에셋이 전역 액센트라 기본 컨트롤이 자동 보라. 취소
            // 버튼은 위에서 per-element `.tint(Color.primary)` 로 중립. agent 뱃지색은 명시 색 유지.)
            // iOS 16.4 deployment target 이라 1-arg 시그니처를 유지한다.
            // (2-arg 시그니처는 iOS 17+ 전용 — deprecation warning 은 무시.)
            .onChange(of: repoPath) { newPath in
                // 경로가 바뀌면 이어 받기 후보를 새로 불러온다.
                // trim 으로 사용자가 실수로 끝 공백/개행을 붙인 경우도 자동 보정한다.
                let trimmed = newPath.trimmingCharacters(in: .whitespacesAndNewlines)
                selectedResumeId = nil
                resumeCandidates = []
                resumeError = nil
                // 새 경로로 바꾸면 이어받기 펼치기 상태도 초기화 — 옛 경로에서 펼쳐 둔
                // 게 새 경로에 끌려와 깜빡이는 듯 보이는 걸 막는다.
                resumeExpanded = false
                // 레포가 바뀌면 worktree 상태도 초기화하고 git 여부를 다시 조회한다.
                // (옛 레포의 «git 임» 판정이 새 레포로 끌려와 잘못된 섹션이 뜨는 걸 막는다.)
                repoIsGit = false
                repoBranch = nil
                worktreeMode = false
                worktreeBranch = ""
                if !trimmed.isEmpty {
                    Task { await loadResumeCandidates(for: trimmed) }
                    Task { await loadGitInfo(for: trimmed) }
                }
                // 경로 prefix(마지막 "/"까지)의 실제 하위 폴더를 daemon 에서 조회해 자동완성
                // 후보(②)를 채운다. prefix 가 직전 조회와 같으면 loadFsDirs 내부에서 재조회를
                // 건너뛰어, 한 segment 안에서 타이핑할 때 키마다 네트워크 호출이 터지지 않게 한다.
                let fsPrefix = splitPathPrefix().prefix
                Task { await loadFsDirs(forPrefix: fsPrefix) }
            }
            .onChange(of: selectedAgentId) { _ in
                // CLI 도구가 바뀌면 이어받기 후보 source 자체가 달라진다 (claude 의 jsonl
                // vs agy 의 history.jsonl). 현 repoPath 로 새 라우트를 다시 조회.
                // shell 로 바꾸면 후보 자체가 무의미 — 빈 상태로 reset 만 하고 fetch 안 함.
                let trimmed = repoPath.trimmingCharacters(in: .whitespacesAndNewlines)
                selectedResumeId = nil
                resumeCandidates = []
                resumeError = nil
                resumeExpanded = false
                // 어댑터가 바뀌면 이전 어댑터의 설치 진행 표시를 끈다 (A 의 「설치 완료」 가 B 에
                // 잘못 보이지 않게). 진행 중이던 폴링 task 도 취소.
                installTask?.cancel()
                installTask = nil
                installProgress = nil
                if !trimmed.isEmpty && !agentIsPlainShell {
                    Task { await loadResumeCandidates(for: trimmed) }
                }
                // opencode 로 바꾸면 「내 로컬 서버 사용」 저장 설정을 채운다(아직 미조회면).
                if agentIsOpenCode && opencodeLoaded == nil {
                    Task { await loadOpencode() }
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    // 취소 같은 «해제» 버튼은 강조색이 아니라 primary(중립) — 설정 닫기와 동일 규칙.
                    // 확정 액션(만들기)만 강조색을 쓴다.
                    Button("취소") { dismiss() }
                        .tint(Color.primary)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("만들기") {
                        Task { await createTapped() }
                    }
                    .disabled(creating || repoPath.trimmingCharacters(in: .whitespaces).isEmpty || localLlmBlocked || localLlmCreateBlocked || selectedAgentNeedsCliInstall || proAgentBlocked || (worktreeMode && !isValidGitName(worktreeBranch)))
                }
            }
            .task {
                await loadRecents()
                await loadAgents()
                await loadLocalLlm()
                await loadOpencode()
                await recoverInstallStateIfNeeded()
            }
            // 폴링 태스크 정리 — 시트가 닫히면 진행 폴링을 멈춘다(로컬 LLM 다운로드 + CLI 설치).
            // 설치/다운로드 자체는 daemon 이 계속 진행하며, 다시 열면 status 폴링이 복구한다.
            .onDisappear {
                llmPollTask?.cancel()
                llmPollTask = nil
                installTask?.cancel()
                installTask = nil
            }
            // 포그라운드 재진입 시 로컬 LLM 상태를 다시 당겨 진행을 복구한다(서버가 진행을 들고
            // 있어, 백그라운드에서 끊겼다 돌아와도 다운로드 진행/완료가 그대로 이어진다).
            .onChange(of: scenePhase) { phase in
                if phase == .active && agentIsLocalInference {
                    Task { await loadLocalLlm() }
                }
            }
            .sheet(isPresented: $showHiddenSheet) {
                HiddenItemsSheet()
                    .environmentObject(hiddenItems)
            }
            // 폴더 탐색기로 작업 폴더 선택 — 고르면 경로를 채우고 직접 입력 모드로 둬 미세조정 가능.
            .sheet(isPresented: $showDirPicker) {
                DirectoryPickerSheet(title: "작업 폴더 선택") { path in
                    let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
                    return try? await api.listDirBase(path)
                } onPick: { picked in
                    repoPath = picked
                    manualMode = true
                }
            }
            // 프로 전용(Terminal·로컬 LLM·worktree)을 미보유 사용자가 시도했을 때의 업셀 페이월.
            .proPaywall(item: $paywallFeature)
            // 생성 실패 안내 — daemon 거절(로컬 LLM 동시 1개 초과 등)이나 통신 실패를 명확히.
            // 옛 동작은 실패해도 조용히 시트만 닫혀 「세션이 안 생기는데 안내가 없는」 문제였다.
            .alert(
                "세션을 만들지 못했어요",
                isPresented: Binding(
                    get: { createError != nil },
                    set: { if !$0 { createError = nil } }
                )
            ) {
                Button("확인", role: .cancel) {}
            } message: {
                Text(createError ?? "")
            }
        }
    }

    // MARK: - Path autocomplete helper

    /// 현재 repoPath 끝의 "/" 위치를 기준으로 (prefix, currentToken) 으로 쪼갠다.
    /// 예) "/Users/soloway/Pro" → prefix="/Users/soloway/", token="Pro"
    /// 예) "/Users/soloway/"   → prefix="/Users/soloway/", token=""
    /// 예) "myrepo"            → prefix="",                 token="myrepo"
    private func splitPathPrefix() -> (prefix: String, token: String) {
        let s = repoPath
        if let lastSlash = s.lastIndex(of: "/") {
            let prefix = String(s[...lastSlash])  // 마지막 "/" 까지 포함
            let token = String(s[s.index(after: lastSlash)...])
            return (prefix, token)
        }
        return ("", s)
    }

    /// recents 의 경로들에서 현재 prefix 다음에 올 수 있는 디렉터리 segment 후보를 모은다.
    /// token (마지막 "/" 이후 이미 입력된 부분) 으로 prefix 매칭 필터까지 한다.
    private var pathSuggestions: [String] {
        let (prefix, token) = splitPathPrefix()
        let tokenLower = token.lowercased()
        var next: Set<String> = []
        // ① recents 파생 — 과거 작업한 경로의 다음 segment.
        for p in recents.map(\.path) {
            guard p.hasPrefix(prefix) else { continue }
            let rest = p.dropFirst(prefix.count)
            if rest.isEmpty { continue }
            let seg: String
            if let slash = rest.firstIndex(of: "/") {
                seg = String(rest[..<slash])
            } else {
                seg = String(rest)
            }
            if seg.isEmpty { continue }
            // token 으로 시작하는 segment 만 — 이미 입력 중인 부분과 충돌하지 않게.
            if !tokenLower.isEmpty && !seg.lowercased().hasPrefix(tokenLower) { continue }
            next.insert(seg)
        }
        // ② 파일시스템 디렉터리 — 현재 prefix 의 실제 하위 폴더 (daemon 조회 결과). fsDirsPrefix
        //    가 지금 prefix 와 일치할 때만 (조회 중 prefix 가 바뀐 stale 결과는 무시).
        if prefix == fsDirsPrefix {
            for seg in fsDirs {
                if !tokenLower.isEmpty && !seg.lowercased().hasPrefix(tokenLower) { continue }
                next.insert(seg)
            }
        }
        return next.sorted()
    }

    /// 칩 탭 — 현재 token 을 seg 전체로 교체. seg 너머 더 깊은 경로가 있으면 "/" 까지 자동
    /// 추가해서 다음 단계 추천이 곧바로 채워지게 한다.
    private func appendPathSegment(_ seg: String) {
        let (prefix, _) = splitPathPrefix()
        let newPath = prefix + seg
        // 디렉터리면 "/" 까지 자동 추가해 다음 단계 추천이 곧장 뜨게 한다. recents 에 더 깊은
        // 경로가 있거나, fs 조회 결과(fsDirs, 모두 디렉터리)에 이 seg 가 있으면 디렉터리로 본다.
        let isDir = recents.contains { $0.path.hasPrefix(newPath + "/") }
            || (prefix == fsDirsPrefix && fsDirs.contains(seg))
        repoPath = isDir ? (newPath + "/") : newPath
    }

    /// "한 단계 위로" — 끝의 "/" 와 그 직전 segment 를 한 번에 제거.
    /// 예) "/Users/soloway/Projects/" → "/Users/soloway/"
    /// 예) "/Users/soloway/Pro"       → "/Users/soloway/"
    private func popPathSegment() {
        var p = repoPath
        if p.hasSuffix("/") { p.removeLast() }
        if let lastSlash = p.lastIndex(of: "/") {
            p = String(p[...lastSlash])
        } else {
            p = ""
        }
        repoPath = p
    }

    @MainActor
    private func loadRecents() async {
        loadingRecents = true
        loadError = nil
        defer { loadingRecents = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            recents = try await api.recentProjects()
            // 시트가 처음 열려서 아직 경로가 비어 있다면, 가장 최근에 작업한
            // 프로젝트를 자동 선택해서 "이어 받기" 후보 로딩을 즉시 트리거한다.
            // 사용자가 + 누르자마자 후보가 보이도록 하기 위함이고,
            // 원치 않으면 다른 항목을 탭하거나 "경로 직접 입력"으로 바꾸면 된다.
            // 숨김 처리된 경로는 건너뛰고, 모두 숨김이면 그대로 비워 둔다.
            if repoPath.isEmpty,
               let first = recents.first(where: { !hiddenItems.isRecentHidden($0.path) }) {
                repoPath = first.path
            }
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// daemon `GET /api/agents` 를 호출해 동적 picker 를 채운다. multi_agent_v1 미지원
    /// 옛 daemon (404) / 통신 실패는 모두 fallback [claude_code] 1개로 흡수해 사용자
    /// 인지 0. (옛 daemon 은 어차피 claude_code 만 spawn 했으므로 행동 변화 없음.)
    @MainActor
    private func loadAgents() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            let list = try await api.listAgents(label: nil)
            if !list.isEmpty {
                agents = list
                // 선택된 id 가 목록에 없으면 첫 항목으로 reset (예: 옛 default 가 제거된 경우).
                if !list.contains(where: { $0.id == selectedAgentId }) {
                    selectedAgentId = list.first!.id
                }
            }
        } catch {
            // 옛 daemon — fallback 그대로. 사용자에겐 에러 안 띄움 (어차피 claude_code 만
            // 보여주는 게 옛 동작과 동일).
        }
    }

    /// 로컬 추론 백엔드(local_llm·opencode 공유)를 제공하는 어댑터가 목록에 있을 때만 세부 상태 +
    /// 카탈로그를 조회한다. 다운로드가 진행 중이면 폴링을 시작해 진행률을 갱신한다. 조회 실패는
    /// llmLoadError 로 섹션에 표시(재시도 버튼). 상태/카탈로그 라우트는 두 어댑터가 공유한다.
    @MainActor
    private func loadLocalLlm() async {
        guard agents.contains(where: { $0.id == "local_llm" || $0.id == "opencode" }) else { return }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        llmLoadError = nil
        do {
            async let statusTask = api.localLlmStatus(label: nil)
            async let catalogTask = api.localLlmModels(label: nil)
            let status = try await statusTask
            let catalog = try await catalogTask
            llmStatus = status
            llmModels = catalog.catalog
            llmRecommendedId = catalog.recommendedModelId
            llmSelectedId = catalog.selectedModelId
            startLlmPollIfNeeded()
        } catch {
            if !ApiError.isCancellation(error) {
                llmLoadError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
        }
    }

    /// opencode 가 목록에 있고 외부 엔드포인트 모드를 지원할 때만 저장 설정을 조회해 draft 를 채운다.
    /// 옛 daemon(라우트 404)·실패는 조용히 흡수(섹션 자체가 capability 로 숨겨져 도달 드묾).
    @MainActor
    private func loadOpencode() async {
        guard opencodeSupportsExternal else { return }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            let cfg = try await api.opencodeExternal(label: nil)
            opencodeLoaded = cfg
            opencodeEnabledDraft = cfg.enabled
            opencodeBaseUrlDraft = cfg.baseUrl
            opencodeModelDraft = cfg.modelId
            opencodeProbe = nil
            opencodeError = nil
        } catch {
            if !ApiError.isCancellation(error) {
                opencodeError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
        }
    }

    /// 입력값(baseURL+모델)으로 /v1/models 헬스체크 — 저장과 무관하게 «막다른 길» 을 미리 잡는다.
    @MainActor
    private func verifyOpencode() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        opencodeBusy = true
        opencodeError = nil
        defer { opencodeBusy = false }
        do {
            opencodeProbe = try await api.verifyOpencodeExternal(
                baseUrl: opencodeBaseUrlDraft.trimmingCharacters(in: .whitespacesAndNewlines),
                modelId: opencodeModelDraft.trimmingCharacters(in: .whitespacesAndNewlines),
            )
        } catch {
            if !ApiError.isCancellation(error) {
                opencodeError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
        }
    }

    /// draft 를 daemon 에 저장(PUT). 켤 때는 daemon 이 baseURL/모델을 엄격 검증 — 400 은 ApiError
    /// 가 사유로 변환해 표시한다. 저장 성공 시 응답(정규화된 최종 설정)으로 loaded/draft 를 갱신.
    @MainActor
    private func saveOpencode() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        opencodeBusy = true
        opencodeError = nil
        defer { opencodeBusy = false }
        let draft = OpencodeExternalConfig(
            enabled: opencodeEnabledDraft,
            baseUrl: opencodeBaseUrlDraft.trimmingCharacters(in: .whitespacesAndNewlines),
            modelId: opencodeModelDraft.trimmingCharacters(in: .whitespacesAndNewlines),
        )
        do {
            let saved = try await api.setOpencodeExternal(draft)
            opencodeLoaded = saved
            opencodeEnabledDraft = saved.enabled
            opencodeBaseUrlDraft = saved.baseUrl
            opencodeModelDraft = saved.modelId
        } catch {
            if !ApiError.isCancellation(error) {
                opencodeError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
        }
    }

    /// 카탈로그(downloaded 플래그)와 상태를 다시 당긴다 — 다운로드/취소/선택 직후 표시 동기화.
    @MainActor
    private func refreshLocalLlm() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        if let catalog = try? await api.localLlmModels(label: nil) {
            llmModels = catalog.catalog
            llmRecommendedId = catalog.recommendedModelId
            llmSelectedId = catalog.selectedModelId
        }
        if let st = try? await api.localLlmStatus(label: nil) { llmStatus = st }
    }

    /// 다운로드가 활성이면 ~1.5s 폴링으로 진행률을 갱신하고, 끝나면 카탈로그를 새로고침한 뒤
    /// 멈춘다. 이미 폴링 중이면 중복 시작하지 않는다(Mac 모델 탭과 같은 idiom).
    private func startLlmPollIfNeeded() {
        guard (llmStatus?.download.active ?? false), llmPollTask == nil else { return }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        llmPollTask = Task { @MainActor in
            defer { llmPollTask = nil }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                if Task.isCancelled { return }
                guard let st = try? await api.localLlmStatus(label: nil) else { continue }
                llmStatus = st
                if !st.download.active {
                    await refreshLocalLlm()
                    return
                }
            }
        }
    }

    /// 폰에서 모델 다운로드 시작. 디스크 부족·이미 받는 중·실패는 llmError 로 섹션에 명확히 표시.
    @MainActor
    private func startLlmDownload(_ id: String) async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        llmError = nil
        do {
            try await api.downloadLocalLlmModel(id)
            // 즉시 진행 상태를 한 번 당겨 카드가 곧장 progress 로 전환되게.
            if let st = try? await api.localLlmStatus(label: nil) { llmStatus = st }
            startLlmPollIfNeeded()
        } catch {
            if !ApiError.isCancellation(error) {
                llmError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
        }
    }

    @MainActor
    private func cancelLlmDownload() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        llmError = nil
        try? await api.cancelLocalLlmDownload()
        await refreshLocalLlm()
    }

    /// 선택 모델 저장. 성공하면 「선택됨」 뱃지가 옮겨 붙고, modelPresent 가 갱신돼 게이트가 풀린다.
    @MainActor
    private func selectLlmModel(_ id: String) async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        llmError = nil
        llmBusyModelId = id
        defer { llmBusyModelId = nil }
        do {
            try await api.selectLocalLlmModel(id)
            await refreshLocalLlm()
        } catch {
            if !ApiError.isCancellation(error) {
                llmError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
        }
    }

    /// 시트 재진입 시, 현재 선택한 어댑터의 설치가 daemon 에서 아직 진행 중이면 그 진행을
    /// 복구해 폴링을 잇는다 (시트를 닫았다 다시 열어도 「설치 계속 진행 중」 이 보이게).
    /// 선택을 강제로 바꾸지 않아 onChange 리셋과 경합하지 않는다 — 진행 중 어댑터가 현재
    /// 선택과 다르면 사용자가 그 어댑터를 고를 때 다시 복구된다.
    @MainActor
    private func recoverInstallStateIfNeeded() async {
        guard installProgress == nil else { return }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        guard let p = try? await api.agentInstallStatus(), p.isInstalling else { return }
        // 추론 서버 런타임 설치는 adapterId 가 "local_llm/<component>"(어댑터 무관 공유) — 로컬
        // 추론(local_llm·opencode) 선택 시 복구. opencode 도 같은 llama-server 설치를 재사용한다.
        if let aid = p.adapterId, aid.hasPrefix("local_llm/") {
            guard agentIsLocalInference else { return }
            installProgress = p
            installTask?.cancel()
            installTask = Task { await runComponentInstall(String(aid.dropFirst("local_llm/".count))) }
            return
        }
        guard p.adapterId == selectedAgentId else { return }
        installProgress = p
        installTask?.cancel()
        installTask = Task { await runInstall() }
    }

    /// 「다시 설치」 — 진행 스냅샷이 어느 경로(CLI vs local_llm 구성요소)인지 보고 올바른 설치를
    /// 다시 건다. adapterId 가 `local_llm/<component>` 면 구성요소 설치, 아니면 어댑터 설치.
    private func retryInstall(for p: AgentInstallProgress) {
        if let aid = p.adapterId, aid.hasPrefix("local_llm/") {
            startComponentInstall(String(aid.dropFirst("local_llm/".count)))
        } else {
            startInstall()
        }
    }

    /// 「Mac 에 설치」 / 「다시 설치」 탭 — 진행 중 task 를 취소하고 새 설치 폴링 루프 시작.
    private func startInstall() {
        installTask?.cancel()
        installTask = Task { await runInstall() }
    }

    /// local_llm 런타임 구성요소(llama-server/qwen) 설치 시작 — CLI 설치와 같은 폴링 루프 재사용.
    private func startComponentInstall(_ component: String) {
        installTask?.cancel()
        installTask = Task { await runComponentInstall(component) }
    }

    /// 구성요소 설치를 daemon 에 시작시키고 완료까지 폴링한다. 성공하면 로컬 LLM 상태를 재조회해
    /// binariesReady 를 갱신 → 게이트(localLlmCreateBlocked) 해제 → 「만들기」 활성. 시트를 안 떠난다.
    ///
    /// 엣지: llama.cpp 빌드는 분 단위로 길 수 있어 종료(done/error)까지 무기한 폴링한다(타임아웃
    /// 없음). Tor 단절로 폴링이 일시 실패해도 루프를 끊지 않고 다음 tick 에 재시도해 「설치
    /// 계속 진행 중」 표시를 유지한다. 폴링 중 사용자가 어댑터를 바꾸면 stale 로 보고 중단.
    @MainActor
    private func runComponentInstall(_ component: String) async {
        let targetId = "local_llm/\(component)"
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            installProgress = try await api.installLocalLlmComponent(component)
        } catch ApiError.httpStatus(409, _) {
            // 이미 진행 중 (다른 기기/이전 시도) — 합류해서 status 폴링만 한다.
        } catch {
            // 시작 자체 실패 — 막다른 길 대신 실패 상태로 폴백 표시.
            installProgress = AgentInstallProgress(
                adapterId: targetId,
                state: "error",
                command: nil,
                log: (error as? LocalizedError)?.errorDescription ?? "\(error)",
                exitCode: nil,
                error: "spawn_failed",
                installed: false,
                startedAt: nil,
            )
            return
        }
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if Task.isCancelled { break }
            // 폴링 중 사용자가 로컬 추론(local_llm·opencode)을 떠났으면 stale — 적용하지 않는다.
            if !agentIsLocalInference { break }
            do {
                let p = try await api.agentInstallStatus()
                // 다른 대상이 설치 중으로 바뀐 스냅샷이면 이 행과 무관 — 무시.
                guard p.adapterId == targetId else { continue }
                installProgress = p
                if !p.isInstalling {
                    // 성공이면 status 재조회로 binariesReady 갱신 → 게이트 해제.
                    if p.isDone { await loadLocalLlm() }
                    break
                }
            } catch {
                // 일시 실패 (Tor 단절 등) — 루프 유지, 다음 tick 에 재시도.
            }
        }
    }

    /// daemon 에 설치를 시작시키고 완료까지 진행을 폴링한다. 성공하면 도구 목록을 재탐지해
    /// 「설정 필요」 게이팅(selectedAgentNeedsCliInstall)을 푼다 → 같은 자리에서 세션 생성 가능.
    ///
    /// 엣지: Tor 회로 전환 등으로 폴링이 일시 실패해도 루프를 끊지 않고 다음 tick 에 재시도
    /// (send() 내부가 강제 재연결) — 「설치 계속 진행 중」 표시가 유지된다. 다른 어댑터가 이미
    /// 설치 중이면 daemon 이 409 busy 지만, 같은 어댑터면 합류하므로 그대로 폴링한다.
    @MainActor
    private func runInstall() async {
        let agentId = selectedAgentId
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            installProgress = try await api.installAgent(adapterId: agentId)
        } catch ApiError.httpStatus(409, _) {
            // 이미 진행 중 (다른 기기/이전 시도) — 합류해서 status 폴링만 한다.
        } catch {
            // 시작 자체 실패 (전송/검증 등) — 막다른 길 대신 실패 상태로 폴백 표시.
            installProgress = AgentInstallProgress(
                adapterId: agentId,
                state: "error",
                command: selectedAgentInstallHint,
                log: (error as? LocalizedError)?.errorDescription ?? "\(error)",
                exitCode: nil,
                error: "spawn_failed",
                installed: false,
                startedAt: nil,
            )
            return
        }
        // 종료(done/error)까지 1s 간격 폴링.
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if Task.isCancelled { break }
            do {
                let p = try await api.agentInstallStatus()
                // 폴링 중 사용자가 어댑터를 바꿨으면 stale — 적용하지 않는다.
                if selectedAgentId != agentId { break }
                installProgress = p
                if !p.isInstalling {
                    // 성공이면 installed=true 로 갱신된 목록을 다시 받아 게이팅 해제.
                    if p.isDone { await loadAgents() }
                    break
                }
            } catch {
                // 일시 실패 (Tor 단절 등) — 루프 유지, 다음 tick 에 재시도.
            }
        }
    }

    @MainActor
    private func loadResumeCandidates(for path: String) async {
        loadingResume = true
        resumeError = nil
        defer { loadingResume = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            resumeCandidates = try await api.desktopSessions(agentId: selectedAgentId, repoPath: path)
        } catch {
            resumeError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// 경로 자동완성용 — `<prefix>` 디렉터리 바로 아래 하위 폴더 목록을 daemon
    /// `GET /api/fs/list-dir` 에서 받아 fsDirs 에 채운다. fsDirsPrefix 로 「어느 prefix 의
    /// 결과인지」를 함께 기록해, 읽는 쪽(pathSuggestions ②)이 stale 결과를 무시할 수 있게 한다.
    ///
    /// - 같은 prefix 의 결과를 이미 들고 있으면 재조회 생략 (키 입력마다 호출되는 걸 막는다).
    /// - 절대경로(또는 ~) prefix 만 조회 — 상대/빈 prefix 는 daemon 이 어차피 빈 목록이라 호출 생략.
    /// - 옛 daemon(이 라우트 없는 빌드)의 404·통신 실패는 빈 목록으로 흡수 → 사용자 인지 0,
    ///   recents 기반 추천(①)만 뜨던 옛 동작으로 자연히 degrade.
    @MainActor
    private func loadFsDirs(forPrefix prefix: String) async {
        if prefix == fsDirsPrefix { return }  // 이미 같은 prefix 의 결과 보유 — 재조회 불필요.
        // 절대경로(또는 ~)가 아니면 daemon 호출 없이 비운다 (불필요한 네트워크 절약).
        guard prefix.hasPrefix("/") || prefix.hasPrefix("~") else {
            fsDirs = []
            fsDirsPrefix = prefix
            return
        }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        let dirs = (try? await api.listDir(prefix, label: nil)) ?? []
        // 응답이 오는 사이 사용자가 다른 prefix 로 이동했으면 stale — 적용하지 않는다.
        // (현 prefix 는 자기 onChange 가 다시 조회한다.)
        guard splitPathPrefix().prefix == prefix else { return }
        fsDirs = dirs
        fsDirsPrefix = prefix
    }

    // MARK: - Resume section

    private var resumeSection: some View {
        Section {
            if repoPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                // 경로 미선택 안내 — 섹션 자체는 항상 보이게 둬서
                // "어디서 이어받기 후보를 보게 되는지" 사용자가 한눈에 알 수 있게 한다.
                Text("위에서 레포 경로를 고르면, 데스크탑에서 진행 중이던 코드 에이전트 세션을 여기서 이어 받을 수 있어요.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else if loadingResume {
                HStack {
                    ProgressView()
                    Text("이어 받을 수 있는 데스크탑 세션 찾는 중…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else if let resumeError {
                Text(resumeError)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            } else {
                // 항상 "새 세션 시작" 옵션을 맨 위에.
                Button {
                    selectedResumeId = nil
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: selectedResumeId == nil
                              ? "largecircle.fill.circle"
                              : "circle")
                            .foregroundStyle(selectedResumeId == nil ? Theme.accent : .secondary)
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("새 세션 시작")
                                .font(.body.weight(.medium))
                            Text("빈 컨텍스트에서 시작합니다.")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if resumeCandidatesVisible.isEmpty {
                    if resumeCandidates.isEmpty {
                        Text("이 경로에서 진행 중이던 데스크탑 코드 에이전트 세션이 없습니다.")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    } else {
                        // 후보가 있긴 한데 전부 사용자가 숨김 처리한 경우 — 안내 + 진입점.
                        VStack(alignment: .leading, spacing: 4) {
                            Text("표시할 이어받기 후보가 없어요.")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text("\(resumeCandidates.count)개 모두 숨김 처리되어 있습니다.")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                } else {
                    ForEach(visibleResumeCandidates) { s in
                        Button {
                            selectedResumeId = s.sessionId
                        } label: {
                            ResumeRow(
                                session: s,
                                selected: selectedResumeId == s.sessionId,
                                onHide: {
                                    // 현재 선택이 숨김 대상이면 해제.
                                    if selectedResumeId == s.sessionId {
                                        selectedResumeId = nil
                                    }
                                    hiddenItems.hideResume(HiddenResumeMeta(
                                        sessionId: s.sessionId,
                                        repoPath: s.repoPath,
                                        preview: s.preview,
                                        lastActiveAt: s.lastActiveAt,
                                        gitBranch: s.gitBranch
                                    ))
                                }
                            )
                        }
                        .buttonStyle(.plain)
                    }
                    if resumeCandidatesVisible.count > 5 {
                        Button {
                            withAnimation { resumeExpanded.toggle() }
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: resumeExpanded ? "chevron.up" : "chevron.down")
                                Text(resumeExpanded
                                     ? "접기"
                                     : "더 보기 (\(resumeCandidatesVisible.count - 5)개)")
                            }
                            .font(.caption)
                            .foregroundStyle(.tint)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        } header: {
            HStack(spacing: 6) {
                Text("이어 받기")
                InfoButton(categoryId: "resume", font: .caption)
            }
        } footer: {
            Text("데스크탑에서 코드 에이전트로 작업 중이던 세션을 골라 모바일에서 이어 받을 수 있어요. 이전 대화 컨텍스트가 모두 유지됩니다.")
                .font(.caption2)
        }
    }

    /// 선택한 레포가 git 저장소일 때만 노출 — 새 브랜치 worktree 를 여기서 바로 만든다.
    /// 토글을 켜면 브랜치명 입력칸이 펼쳐지고, 「만들기」 가 worktree 생성 → 그 안에서 세션 시작
    /// 흐름으로 분기한다 (채팅방 BranchSheet 를 거치지 않아도 되게 한다).
    private var worktreeSection: some View {
        Section {
            // 프로 게이트 — worktree 생성은 프로 전용(채팅 BranchSheet 와 통일). 미보유 사용자가
            // 켜려 하면 토글을 켜지 않고 페이월을 띄운다. 커스텀 Binding 으로 set 을 가로채므로
            // worktreeMode 가 «프로 없이» true 가 되는 경로 자체가 없다(이번 버그의 근본 차단).
            Toggle(isOn: Binding(
                get: { worktreeMode },
                set: { want in
                    if want, worktreeProBlocked { paywallFeature = .worktree; return }
                    worktreeMode = want
                }
            )) {
                Label {
                    HStack(spacing: 6) {
                        Text("새 worktree 만들기")
                        // 미보유면 «프로» 마커 — 에이전트 행/다른 프로 진입점과 통일.
                        if worktreeProBlocked {
                            Text("프로")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(Theme.pro)
                        }
                    }
                } icon: {
                    // git/worktree 도구 그룹 — 아이콘만 주황(채팅 BranchSheet 의 WorktreeRow 와 통일).
                    // 토글/텍스트 본체엔 주황을 칠하지 않는다(주황=프로/고급 약속색, 색 정책 준수).
                    Image(systemName: "plus.rectangle.on.folder")
                        .foregroundStyle(Theme.pro)
                }
            }
            if worktreeMode {
                TextField("브랜치 이름 (영문·숫자)", text: $worktreeBranch)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
        } header: {
            Text("worktree")
        } footer: {
            if worktreeMode {
                // 한글·공백 등은 git 이 브랜치명으로 못 받는다 — 유효한 이름일 때만 「만들기」 활성.
                if let base = repoBranch {
                    Text("새 브랜치의 worktree(별도 작업 폴더)를 «\(base)» 기준으로 만들고 그 안에서 세션을 시작해요. 이름은 영문·숫자와 - _ . / 만 쓸 수 있어요.")
                        .font(.caption2)
                } else {
                    Text("새 브랜치의 worktree(별도 작업 폴더)를 만들고 그 안에서 세션을 시작해요. 이름은 영문·숫자와 - _ . / 만 쓸 수 있어요.")
                        .font(.caption2)
                }
            } else {
                Text("worktree 는 브랜치별 별도 작업 폴더예요. 채팅방에 들어가지 않고 새 브랜치를 여기서 바로 시작할 수 있어요.")
                    .font(.caption2)
            }
        }
    }

    /// 레포가 git 작업트리인지 조회해 worktree 섹션 노출 여부를 정한다. 실패/옛 daemon(이 라우트
    /// 없음)은 조용히 비-git 으로 — 섹션만 숨길 뿐 다른 흐름은 막지 않는다(이어받기 후보 로딩과 동일 톤).
    @MainActor
    private func loadGitInfo(for path: String) async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        let info = try? await api.repoGitInfo(repoPath: path)
        // 조회 도중 사용자가 다른 레포로 바꿨으면 stale 결과 — 현 상태를 건드리지 않는다.
        guard path == repoPath.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
        if let info, info.isRepo {
            repoIsGit = true
            repoBranch = info.branch
        } else {
            repoIsGit = false
            repoBranch = nil
        }
    }

    /// 브랜치명이 daemon 의 isValidRef 규칙(영숫자 + ._/-, 선행 `-`·`..` 금지)을 통과하는지.
    /// 제출 «전» 같은 규칙으로 막아 «생성 실패» 대신 비활성 버튼으로 즉시 피드백한다 (BranchSheet 와 동일).
    private func isValidGitName(_ raw: String) -> Bool {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 255 else { return false }
        guard !name.hasPrefix("-"), !name.contains("..") else { return false }
        return name.range(of: "^[A-Za-z0-9._/-]+$", options: .regularExpression) != nil
    }

    /// 「만들기」 탭 — worktree 모드면 onCreate «전» 에 새 worktree 를 만들고 그 경로로 세션을 시작한다.
    /// 일반 모드면 선택한 레포 경로 그대로. 실패는 시트를 닫지 않고 createError alert 으로 안내한다.
    @MainActor
    private func createTapped() async {
        creating = true
        defer { creating = false }
        var sessionRepoPath = repoPath
        var sessionTitle: String? = title.isEmpty ? nil : title
        var resume = selectedResumeId
        if worktreeMode {
            // 방어선 — 토글에서 이미 막지만, worktreeMode 가 프로 없이 true 인 경로가 생기더라도
            // 여기서 한 번 더 차단(게이트 단일화: 프로 판정은 항상 purchase.isUnlocked(.worktree)).
            if worktreeProBlocked {
                paywallFeature = .worktree
                return
            }
            let branch = worktreeBranch.trimmingCharacters(in: .whitespacesAndNewlines)
            let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
            do {
                let wt = try await api.createWorktreeForRepo(repoPath: repoPath, branch: branch, newBranch: true)
                sessionRepoPath = wt.path
                // 제목을 비웠으면 브랜치명을 제목으로 — 「제목 없음」 대신 어느 worktree 인지 보이게
                // (채팅방 BranchSheet 흐름과 동일). 새 브랜치+새 폴더라 이어받기는 결합하지 않는다.
                if sessionTitle == nil { sessionTitle = branch }
                resume = nil
            } catch {
                createError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
                return
            }
        }
        let err = await onCreate(sessionRepoPath, sessionTitle, resume, skipPermissions, selectedAgentId)
        // 실패면 시트를 닫지 않고 alert 로 사유를 명확히 보여 준다. 성공일 때만 닫는다.
        if let err {
            createError = err
        } else {
            dismiss()
        }
    }
}
