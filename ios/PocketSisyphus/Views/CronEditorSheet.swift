import SwiftUI

/// 예약 작업 생성/편집 시트. NewSessionSheet 의 «에이전트 picker + 경로 자동완성 + 자동 승인
/// 토글» UX 를 재사용(같은 ApiClient 엔드포인트)하고, ScheduleBuilder 로 «쉬운» 스케줄 입력 +
/// daemon 미리보기로 다음 실행 시각을 라이브로 보여 준다.
struct CronEditorSheet: View {
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker
    /// nil 이면 생성, non-nil 이면 그 작업 편집.
    let existing: CronJob?
    /// 저장 성공 후 목록 새로고침 트리거.
    let onSaved: () -> Void

    @State private var title = ""
    /// "agent" | "terminal". 에이전트 picker 와 «별도» 인 최상위 종류 선택.
    @State private var kind = "agent"
    @State private var agents: [AgentInfo] = [AgentInfo.claudeCodeFallback]
    @State private var selectedAgentId = AgentInfo.claudeCodeFallback.id
    @State private var repoPath = ""
    /// 에이전트 종류의 프롬프트.
    @State private var command = ""
    /// 터미널 종류의 쉘 스크립트 파일 절대경로 (command 와 분리 — 종류 전환 시 서로 안 지워지게).
    @State private var scriptPath = ""
    /// 터미널 인터프리터 — "zsh" | "bash" | "sh".
    @State private var shell = "zsh"
    @State private var schedule = ""
    @State private var sessionMode = "fresh"        // "fresh" | "continue"
    @State private var skipPermissions = true
    @State private var notify = true
    @State private var overlapAllow = false          // false → "skip"
    @State private var catchUp = false

    /// daemon 이 터미널 예약(cron_terminal_v1)을 지원하는지 — 없으면 종류 선택지를 숨기고
    /// 기존처럼 에이전트만 (옛 Mac 앱 호환, soft 폴백).
    @State private var supportsTerminal = false

    @State private var preview: SchedulePreview?
    @State private var previewTask: Task<Void, Never>?
    @State private var saving = false
    @State private var saveError: String?
    @Environment(\.dismiss) private var dismiss

    private var timezone: String { TimeZone.current.identifier }
    private var isEdit: Bool { existing != nil }
    private var isTerminal: Bool { kind == "terminal" }

    /// 터미널이면 스크립트 경로, 에이전트면 명령이 채워져야 한다.
    private var execInput: String { isTerminal ? scriptPath : command }

    private var canSave: Bool {
        !execInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !repoPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (preview?.valid ?? false)
            && !saving
    }

    private static let shells = ["zsh", "bash", "sh"]

    var body: some View {
        NavigationStack {
            Form {
                titleSection
                if supportsTerminal { kindSection }
                if isTerminal {
                    shellSection
                    repoSection
                    scriptSection
                } else {
                    agentSection
                    repoSection
                    commandSection
                }
                scheduleSection
                optionsSection
            }
            .navigationTitle(isEdit ? Text("예약 편집") : Text("새 예약"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: {
                        isEdit ? Text("저장") : Text("만들기")
                    }
                    .disabled(!canSave)
                }
            }
            .task { await initialLoad() }
            .onChange(of: schedule) { _ in scheduleDebouncedPreview() }
            .alert(
                "저장 실패",
                isPresented: Binding(get: { saveError != nil }, set: { if !$0 { saveError = nil } })
            ) {
                Button("확인", role: .cancel) {}
            } message: {
                Text(saveError ?? "")
            }
            // 명령 입력란의 마이크 받아쓰기 공통 크롬(녹음 HUD·준비 배너·오류 alert·모델 선로드).
            .voiceDictationChrome()
        }
    }

    // MARK: - Sections

    private var titleSection: some View {
        Section {
            VoiceInputField("이 예약의 이름 (선택)", text: $title)
        } header: {
            Text("이름")
        } footer: {
            Text("비워두면 명령의 앞부분이 제목이 됩니다.")
                .font(.caption2)
        }
    }

    /// 최상위 «종류» 선택 — 에이전트 vs 터미널. 에이전트 picker 와 별개의 카테고리.
    private var kindSection: some View {
        Section {
            Picker(selection: $kind) {
                Text("에이전트").tag("agent")
                Text("터미널").tag("terminal")
            } label: {
                Text("종류")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .accessibilityLabel(Text("종류"))
        } header: {
            Text("종류")
        } footer: {
            Text(isTerminal
                ? "정해진 시각에 쉘 스크립트 파일을 실행해요."
                : "정해진 시각에 코드 에이전트에게 프롬프트를 보내요.")
                .font(.caption2)
        }
    }

    /// 터미널 인터프리터 선택 — 스크립트를 어떤 셸로 돌릴지.
    private var shellSection: some View {
        Section {
            Picker(selection: $shell) {
                ForEach(Self.shells, id: \.self) { s in
                    Text(verbatim: s).tag(s)
                }
            } label: {
                Text("셸")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .accessibilityLabel(Text("셸"))
        } header: {
            Text("셸")
        } footer: {
            Text("스크립트를 로그인 셸로 한 번 실행해, PATH·환경이 평소처럼 잡혀요.")
                .font(.caption2)
        }
    }

    /// 터미널 종류의 스크립트 파일 선택 (파일 자동완성).
    private var scriptSection: some View {
        Section {
            ScriptPathField(auth: auth, conn: conn, inflight: inflight, scriptPath: $scriptPath)
        } header: {
            Text("스크립트 파일")
        } footer: {
            Text("Mac 에 있는 쉘 스크립트 파일의 절대 경로예요 (예: /Users/나/scripts/backup.sh).")
                .font(.caption2)
        }
    }

    private var agentSection: some View {
        Section {
            Picker(selection: $selectedAgentId) {
                ForEach(agents) { a in
                    HStack(spacing: 8) {
                        Image(systemName: AgentKind.from(id: a.id).systemImage)
                        Text(a.displayName)
                        if !a.isInstalled {
                            Text("설정 필요").font(.caption2).foregroundStyle(Theme.warning)
                        }
                    }
                    .tag(a.id)
                }
            } label: {
                Text("CLI 도구")
            }
            .pickerStyle(.inline)
            .labelsHidden()
            .accessibilityLabel(Text("CLI 도구"))
        } header: {
            Text("에이전트")
        }
    }

    private var repoSection: some View {
        Section {
            RepoPathField(auth: auth, conn: conn, inflight: inflight, repoPath: $repoPath)
        } header: {
            Text("작업 폴더")
        } footer: {
            Text("이 폴더에서 에이전트를 실행해요. 없는 폴더는 자동으로 만들어요.")
                .font(.caption2)
        }
    }

    private var commandSection: some View {
        Section {
            // 긴 자연어 프롬프트라 폰 키보드 마찰이 큰 자리 — 받아쓰기(온디바이스 Whisper)로 말해서
            // 입력할 수 있게 마이크 버튼을 붙인다. 결과는 삽입만 하고 자동 저장하지 않는다(검토 후 저장).
            VoiceInputField("예: 어제 연 PR들 리뷰해서 요약해줘", text: $command, lineLimit: 2...6)
        } header: {
            Text("명령")
        } footer: {
            Text("에이전트에게 보낼 프롬프트예요.")
                .font(.caption2)
        }
    }

    private var scheduleSection: some View {
        Section {
            ScheduleBuilder(schedule: $schedule)
            previewRow
        } header: {
            Text("언제")
        }
    }

    @ViewBuilder
    private var previewRow: some View {
        if let p = preview {
            if p.valid {
                VStack(alignment: .leading, spacing: 2) {
                    Label("다음 실행", systemImage: "clock")
                        .font(.caption).foregroundStyle(.secondary)
                    ForEach(Array(p.nextRunDates.prefix(3).enumerated()), id: \.offset) { _, d in
                        Text(d.formatted(date: .abbreviated, time: .shortened))
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
            } else {
                Label(p.error ?? String(localized: "잘못된 cron 식이에요."), systemImage: "exclamationmark.triangle")
                    .font(.caption2).foregroundStyle(Theme.warning)
            }
        }
    }

    private var optionsSection: some View {
        Section {
            // 도구 자동 승인·세션 이어가기는 에이전트 전용 개념 — 터미널 종류에선 숨긴다.
            if !isTerminal {
                Toggle(isOn: $skipPermissions) {
                    Label("도구 자동 승인", systemImage: "lock.open.fill")
                }
                Picker(selection: $sessionMode) {
                    Text("매번 새 세션").tag("fresh")
                    Text("같은 대화 이어가기").tag("continue")
                } label: {
                    Label("세션", systemImage: "bubble.left.and.bubble.right")
                }
            }
            Toggle(isOn: $notify) {
                Label("완료 알림", systemImage: "bell")
            }
            DisclosureGroup {
                Toggle(isOn: $overlapAllow) {
                    Text("겹쳐 실행 허용")
                }
                Toggle(isOn: $catchUp) {
                    Text("켤 때 놓친 실행 보충")
                }
            } label: {
                Text("고급 옵션").font(.subheadline)
            }
        } header: {
            Text("옵션")
        } footer: {
            Text(isTerminal
                ? "스크립트는 신뢰하는 것만 등록하세요. Mac 이 깨어 있어야 실행돼요."
                : "예약 작업은 사람이 없을 때 도니까 도구를 자동 승인하는 게 좋아요. 신뢰하는 폴더에서만 쓰세요. Mac 이 깨어 있어야 실행돼요.")
                .font(.caption2)
        }
    }

    // MARK: - Load / preview / save

    private func initialLoad() async {
        if let job = existing {
            title = job.title ?? ""
            kind = job.kindValue
            repoPath = job.repo_path
            if job.isTerminal {
                scriptPath = job.command
                shell = job.shell ?? "zsh"
            } else {
                selectedAgentId = job.agent
                command = job.command
            }
            schedule = job.schedule
            sessionMode = job.session_mode
            skipPermissions = job.skipPermissions
            notify = job.notifyEnabled
            overlapAllow = job.overlap_policy == "allow"
            catchUp = job.catchUp
        }
        await loadCapabilities()
        await loadAgents()
        scheduleDebouncedPreview()
    }

    /// daemon 이 터미널 예약을 지원하는지 확인 — 종류 선택지 노출 여부. 옛 daemon(404/미지원)은
    /// supportsTerminal=false 로 두어 에이전트만 보이게 (graceful 폴백). 편집 중인 작업이 이미
    /// 터미널이면 — daemon 이 지원한다는 뜻이므로 — 무조건 노출한다.
    private func loadCapabilities() async {
        if existing?.isTerminal == true { supportsTerminal = true; return }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        if let info = try? await api.getServerVersion(label: nil) {
            supportsTerminal = info.capabilities.contains("cron_terminal_v1")
        }
    }

    private func loadAgents() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        if let list = try? await api.listAgents(label: nil), !list.isEmpty {
            // 예약 픽커는 «무인 실행에 적합한» 에이전트만 (cron_eligible_v1) — Terminal(셸) 과
            // Local LLM(콜드스타트 ~1분) 은 daemon 이 이 표식을 안 달아 자동 제외된다.
            // 표식을 단 에이전트가 하나도 없으면(예: cron 은 되지만 이 플래그가 없는 옛 daemon)
            // 전체 목록으로 폴백해 픽커가 비지 않게 한다 (무회귀).
            let eligible = list.filter { $0.capabilities.contains("cron_eligible_v1") }
            let shown = eligible.isEmpty ? list : eligible
            agents = shown
            if !shown.contains(where: { $0.id == selectedAgentId }) {
                selectedAgentId = shown.first!.id
            }
        }
    }

    /// 식이 바뀔 때마다 400ms 디바운스로 daemon 미리보기 호출.
    private func scheduleDebouncedPreview() {
        previewTask?.cancel()
        let expr = schedule.trimmingCharacters(in: .whitespaces)
        guard !expr.isEmpty else { preview = nil; return }
        previewTask = Task {
            try? await Task.sleep(nanoseconds: 400_000_000)
            if Task.isCancelled { return }
            let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
            let result = try? await api.previewSchedule(expr, timezone: timezone, label: nil)
            if Task.isCancelled { return }
            await MainActor.run { preview = result }
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        // 터미널: command=스크립트 경로, agent 는 생략(데몬이 'shell' 고정), shell 동봉.
        // 에이전트: command=프롬프트, agent=선택, shell 생략.
        let req = CronJobUpsertRequest(
            title: trimmedTitle.isEmpty ? nil : trimmedTitle,
            kind: kind,
            agent: isTerminal ? nil : selectedAgentId,
            repoPath: repoPath.trimmingCharacters(in: .whitespacesAndNewlines),
            command: execInput.trimmingCharacters(in: .whitespacesAndNewlines),
            shell: isTerminal ? shell : nil,
            schedule: schedule.trimmingCharacters(in: .whitespaces),
            timezone: timezone,
            skipPermissions: skipPermissions,
            sessionMode: sessionMode,
            overlapPolicy: overlapAllow ? "allow" : "skip",
            catchUp: catchUp,
            notify: notify,
            enabled: existing?.isEnabled ?? true
        )
        do {
            if let job = existing {
                _ = try await api.updateCronJob(job.id, req)
            } else {
                _ = try await api.createCronJob(req)
            }
            onSaved()
            dismiss()
        } catch {
            saveError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }
}

// MARK: - 스크립트 파일 입력 (디렉터리 + 파일 자동완성)

/// 터미널 예약의 쉘 스크립트 «파일» 을 고르는 컴포넌트. RepoPathField 와 비슷하지만 폴더로
/// 내려가는 것뿐 아니라 «파일» 도 칩으로 보여 — 탭하면 그 절대경로가 그대로 채워진다
/// (daemon /api/fs/list-dir?files=1). 폴더 칩(폴더 아이콘)은 한 단계 내려가고, 파일 칩(문서
/// 아이콘)은 최종 선택. 사용자가 직접 경로를 타이핑해도 된다.
private struct ScriptPathField: View {
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker
    @Binding var scriptPath: String

    @State private var fsDirs: [String] = []
    @State private var fsFiles: [String] = []
    @State private var fsPrefix = ""

    private struct Entry: Hashable { let name: String; let isDir: Bool }

    var body: some View {
        Group {
            TextField("/Users/you/scripts/backup.sh", text: $scriptPath)
                .font(.body.monospaced())
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            if !suggestions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        Button { popSegment() } label: {
                            Image(systemName: "arrow.up.left")
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .accessibilityLabel(Text("상위 경로"))

                        ForEach(suggestions, id: \.self) { e in
                            Button { select(e) } label: {
                                Label(e.name, systemImage: e.isDir ? "folder" : "doc.text")
                                    .lineLimit(1)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                    }
                }
            }
        }
        .onAppear { Task { await loadEntries(forPrefix: splitPrefix().prefix) } }
        .onChange(of: scriptPath) { _ in
            Task { await loadEntries(forPrefix: splitPrefix().prefix) }
        }
    }

    private func splitPrefix() -> (prefix: String, token: String) {
        let s = scriptPath
        if let lastSlash = s.lastIndex(of: "/") {
            return (String(s[...lastSlash]), String(s[s.index(after: lastSlash)...]))
        }
        return ("", s)
    }

    private var suggestions: [Entry] {
        let (prefix, token) = splitPrefix()
        guard prefix == fsPrefix else { return [] } // 현재 폴더 항목이 로드된 뒤에만 노출
        let tokenLower = token.lowercased()
        func matches(_ seg: String) -> Bool {
            tokenLower.isEmpty || seg.lowercased().hasPrefix(tokenLower)
        }
        let dirs = fsDirs.filter(matches).sorted().map { Entry(name: $0, isDir: true) }
        let files = fsFiles.filter(matches).sorted().map { Entry(name: $0, isDir: false) }
        return dirs + files
    }

    private func select(_ e: Entry) {
        let (prefix, _) = splitPrefix()
        scriptPath = prefix + e.name + (e.isDir ? "/" : "")
    }

    private func popSegment() {
        var p = scriptPath
        if p.hasSuffix("/") { p.removeLast() }
        if let lastSlash = p.lastIndex(of: "/") {
            p = String(p[...lastSlash])
        } else {
            p = ""
        }
        scriptPath = p
    }

    @MainActor
    private func loadEntries(forPrefix prefix: String) async {
        if prefix == fsPrefix { return }
        guard prefix.hasPrefix("/") || prefix.hasPrefix("~") else {
            fsDirs = []
            fsFiles = []
            fsPrefix = prefix
            return
        }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        let entries = try? await api.listDirEntries(prefix, label: nil)
        guard splitPrefix().prefix == prefix else { return } // 그새 prefix 가 또 바뀌었으면 버림
        fsDirs = entries?.dirs ?? []
        fsFiles = entries?.files ?? []
        fsPrefix = prefix
    }
}
