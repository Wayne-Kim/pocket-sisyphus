import SwiftUI

/// 워크플로우 캔버스 — Phase 0 «읽기전용 뷰어».
///
/// 정의(노드 좌표 + 간선)를 ZStack 으로 그리고, 실행하면 daemon 의 run 상태를 폴링해 각 노드를
/// 상태색으로 칠한다. 노드를 탭하면 그 노드의 세션을 채팅 화면으로 연다(기존 ChatView 재사용).
/// 캔버스 편집(드래그/연결)은 Phase 1. 팬은 ScrollView 양축으로, 줌은 Phase 1.
struct WorkflowCanvasView: View {
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker
    let onOpenSession: (String) -> Void

    /// 지금 선택된 메인 탭 — 기록 run 캔버스 푸시의 탭 바 숨김을 «자동화 탭이 활성일 때만» 걸기 위함.
    /// 딥링크로 다른 탭 전환 시 숨김이 남아 탭 바가 사라진 채 갇히는 누출 방지(WorkflowListView 와 동형).
    @Environment(\.activeMainTab) private var activeMainTab
    private var canvasTabBarVisibility: Visibility {
        (activeMainTab ?? .workflows) == .workflows ? .hidden : .visible
    }

    /// 정의의 가변 사본 — 편집기에서 저장하면 onSaved 로 갱신돼 캔버스가 즉시 새 그래프를 그린다.
    @State private var def: WorkflowSummary
    @State private var runId: String?
    @State private var runState: WorkflowRunStateResponse?
    @State private var starting = false
    @State private var error: String?
    @State private var actionTarget: NodeAction?
    /// 팬/줌 — 편집기와 동일한 방식. ScrollView 대신 DragGesture+offset/scale 사용.
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    /// 최초 fit(zoom+center) 완료 여부 — runState 갱신/재레이아웃 시 재적용 방지(사용자 팬·줌 보존).
    @State private var didFit = false
    /// «실행 기록» 시트 노출 여부. 시트는 daemon 이 내려준 최근 20 run 을 보여 준다 — 캔버스의
    /// 자동 «최근 run 표시» 위에 얹는 진입점(회귀 0: loadLatestRun 동작은 그대로).
    @State private var showHistory = false
    /// 시트에서 고른 run — 시트가 닫힌 뒤(onDismiss) 그 run 의 캔버스로 push 하기 위한 임시 보관.
    /// 시트 닫힘과 push 를 한 사이클에 겹치면 push 가 누락될 수 있어 2단계로 나눈다.
    @State private var pendingHistoryRunId: String?
    /// navigationDestination(item:) 을 구동 — 비-nil 이면 그 run 의 읽기전용 캔버스로 push.
    @State private var historyRunId: String?
    /// 「루프 감독」 시트 노출 — 반복 진행/검사/변경을 위에서 한눈에 보고 한 번에 멈추는 전용 화면.
    @State private var showLoopMonitor = false

    /// 사용자 결정이 필요한 노드 (승인 게이트 / 수동 개입).
    private struct NodeAction: Identifiable {
        let id: String      // node_run id
        let status: String  // awaiting_approval | needs_attention
        let title: String
    }

    init(
        auth: AuthStore,
        conn: ConnectionManager,
        inflight: InFlightTracker,
        workflow: WorkflowSummary,
        initialRunId: String? = nil,
        onOpenSession: @escaping (String) -> Void
    ) {
        self.auth = auth
        self.conn = conn
        self.inflight = inflight
        self.onOpenSession = onOpenSession
        _def = State(initialValue: workflow)
        // 특정 run 으로 착지 (PO 브리프 상세 / po_gate 딥링크) — 없으면 최근 run 자동 로드.
        _runId = State(initialValue: initialRunId)
    }

    private let nodeW: CGFloat = 168
    private let nodeH: CGFloat = 70

    private var isRunning: Bool { runState?.run.status == "running" }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                // 팬/줌 surface — 편집기와 동일한 방식. geo 크기로 «고정» 해, 월드보다 큰 ZStack 에
                // 끌려가 가운데 정렬이 깨지지 않게 한다. DragGesture+offset 은 콘텐츠 크기에 무관하게
                // 항상 자유롭게 팬/줌이 가능하다.
                Rectangle()
                    .fill(Color.black.opacity(0.001))  // design-lint: allow — 투명 제스처 히트 surface(opacity 0.001), 색은 무의미·테마 적응 불필요
                    .frame(width: geo.size.width, height: geo.size.height)
                    .contentShape(Rectangle())
                    .gesture(
                        SimultaneousGesture(
                            DragGesture()
                                .onChanged { v in
                                    offset = CGSize(
                                        width: lastOffset.width + v.translation.width,
                                        height: lastOffset.height + v.translation.height
                                    )
                                }
                                .onEnded { _ in lastOffset = offset },
                            MagnifyGesture()
                                .onChanged { v in scale = min(2.5, max(0.4, lastScale * v.magnification)) }
                                .onEnded { _ in lastScale = scale }
                        )
                    )

                canvasWorld
                    .scaleEffect(scale)
                    .offset(offset)
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .clipped()
            // 진입 시 한 번 — 그려진 요소 전체가 뷰포트에 보이도록 zoom/offset 을 맞춘다(편집기와 동일).
            .onAppear { attemptFit(geo.size) }
            .onChange(of: geo.size) { newSize in attemptFit(newSize) }
        }
        .navigationTitle(def.title ?? String(localized: "워크플로우"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showHistory = true
                } label: {
                    Label("실행 기록", systemImage: "clock.arrow.circlepath")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                if isRunning {
                    Button {
                        Task { await cancel() }
                    } label: {
                        Label("취소", systemImage: "stop.circle")
                    }
                } else {
                    Button {
                        Task { await start() }
                    } label: {
                        Label("실행", systemImage: "play.fill")
                    }
                    .disabled(starting)
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let st = runState?.run {
                runStatusBar(st)
            }
        }
        .task { await loadLatestRun() }
        .task(id: runId) { await pollLoop() }
        // 실행 기록 — 시트로 최근 20 run 을 보여 주고, 고른 run 은 시트가 닫힌 뒤 읽기전용 캔버스로 push.
        .sheet(isPresented: $showHistory, onDismiss: {
            if let rid = pendingHistoryRunId {
                pendingHistoryRunId = nil
                historyRunId = rid
            }
        }) {
            WorkflowRunHistorySheet(
                auth: auth,
                conn: conn,
                inflight: inflight,
                workflowId: def.id,
                workflowTitle: def.title ?? String(localized: "워크플로우")
            ) { rid in
                // 시트를 먼저 닫고(onDismiss) 그 run 으로 push — 닫힘과 push 가 한 사이클에 겹쳐 push 가 누락되는 걸 피한다.
                pendingHistoryRunId = rid
                showHistory = false
            }
            .presentationDetents([.medium, .large])
        }
        // 고른 run → WorkflowRunLoaderView 가 정의를 fetch 해 그 runId 의 캔버스를 폴링한다(읽기전용 경로).
        .navigationDestination(item: $historyRunId) { rid in
            WorkflowRunLoaderView(
                workflowId: def.id,
                runId: rid,
                onOpenSession: onOpenSession
            )
            .toolbar(canvasTabBarVisibility, for: .tabBar)
        }
        // 「루프 감독」 — 반복 진행/마지막 검사/변경 요약을 위에서 한눈에 + 한 번에 멈춤(전용 화면).
        .sheet(isPresented: $showLoopMonitor) {
            WorkflowLoopMonitorView(
                auth: auth,
                conn: conn,
                inflight: inflight,
                runId: runId,
                workflowTitle: def.title ?? String(localized: "워크플로우")
            )
        }
        .alert(
            "오류",
            isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } }),
            presenting: error
        ) { _ in
            Button("확인", role: .cancel) {}
        } message: { msg in
            Text(msg)
        }
        .confirmationDialog(
            actionTarget?.title ?? "",
            isPresented: Binding(get: { actionTarget != nil }, set: { if !$0 { actionTarget = nil } }),
            presenting: actionTarget
        ) { target in
            if target.status == "awaiting_approval" {
                Button("승인") { decide(target, "approve") }
                Button("거부", role: .destructive) { decide(target, "reject") }
            } else {
                Button("완료 처리") { decide(target, "complete") }
                Button("재시도") { decide(target, "retry") }
            }
            Button("취소", role: .cancel) {}
        } message: { target in
            // 분리 — ternary 는 String 으로 추론돼 Text(_:String) 로 가서 다국어가 안 됨.
            // 각 Text 를 따로 둬 LocalizedStringKey 추출 경로를 타게 한다.
            if target.status == "awaiting_approval" {
                Text("이 노드를 실행할까요?")
            } else {
                Text("이 노드가 결과를 못 남겼어요. 어떻게 할까요?")
            }
        }
    }

    // MARK: - 진입 시 전체 보기 (zoom + center)

    /// 진입 시 한 번만 — 노드가 있으면 fit 을 적용한다. 재레이아웃/runState 갱신엔 재적용하지 않아
    /// 사용자가 손으로 맞춘 팬·줌을 보존한다(편집기 attemptFit 과 동일).
    private func attemptFit(_ size: CGSize) {
        guard !didFit, size.width > 1, size.height > 1 else { return }
        let layout = computeLayout()
        guard !layout.nodes.isEmpty else { return }   // 노드가 아직 없으면 다음 기회에.
        didFit = true
        fitContent(in: size, layout: layout)
    }

    /// 노드 bounding box(카드 크기 포함)가 여백과 함께 뷰포트에 들어오도록 zoom(scale)+offset 을
    /// 맞춘다. world 는 ZStack 중앙 정렬 + scaleEffect(중심 기준) + offset 으로 그려지므로,
    /// bbox 중심을 뷰포트 중심에 두는 offset = scale * (worldCenter − bboxCenter). (편집기 fitContent 동일.)
    private func fitContent(in size: CGSize, layout: Layout) {
        let wSize = viewerWorldSize(layout: layout)
        var minX = CGFloat.greatestFiniteMagnitude, minY = CGFloat.greatestFiniteMagnitude
        var maxX = -CGFloat.greatestFiniteMagnitude, maxY = -CGFloat.greatestFiniteMagnitude
        for n in layout.nodes {
            minX = min(minX, n.center.x - nodeW / 2); minY = min(minY, n.center.y - nodeH / 2)
            maxX = max(maxX, n.center.x + nodeW / 2); maxY = max(maxY, n.center.y + nodeH / 2)
        }
        let bw = max(1, maxX - minX), bh = max(1, maxY - minY)
        let bcx = (minX + maxX) / 2, bcy = (minY + maxY) / 2
        let pad: CGFloat = 80
        // 노드가 뷰포트보다 작으면 100% 이상 확대하지 않는다(1.0 cap).
        let fit = min(size.width / (bw + pad * 2), size.height / (bh + pad * 2))
        let newScale = min(1.0, max(0.4, fit))
        scale = newScale
        lastScale = newScale
        offset = CGSize(width: (wSize.width / 2 - bcx) * newScale,
                        height: (wSize.height / 2 - bcy) * newScale)
        lastOffset = offset
    }

    /// 편집기 worldSize 와 동일하게 노드들을 다 포함할 수 있는 최소 world 크기.
    private func viewerWorldSize(layout: Layout) -> CGSize {
        var maxX: CGFloat = 800
        var maxY: CGFloat = 1000
        for n in layout.nodes {
            maxX = max(maxX, n.center.x + nodeW / 2 + 80)
            maxY = max(maxY, n.center.y + nodeH / 2 + 80)
        }
        return CGSize(width: maxX, height: maxY)
    }

    @MainActor
    private func decide(_ target: NodeAction, _ action: String) {
        guard let rid = runId else { return }
        actionTarget = nil
        Task {
            let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
            try? await api.workflowNodeDecision(runId: rid, nodeRunId: target.id, action: action)
            if let st = try? await api.workflowRunState(runId: rid) {
                await MainActor.run { runState = st }
            }
        }
    }

    // MARK: - 캔버스

    /// 표시용 노드 — 정의(좌표/타입/제목) + 런타임(상태/세션) 병합.
    private struct DisplayNode: Identifiable {
        let id: String
        let title: String
        let type: String
        let center: CGPoint
        let status: String
        let sessionId: String?
        /// 루프 반복 횟수 (0 = 첫 시도). >0 이면 재시도 중/했음.
        var iteration: Int = 0
        /// 이번에 되돌아간 사유 한 줄 (daemon). 없으면 nil.
        var loopbackReason: String? = nil
        /// 재시도 한도 도달로 멈춤.
        var limitReached: Bool = false
        /// 결과물 출처 (workflow_attention_v1) — nil/"agent"/"synthetic"/"empty".
        var resultKind: String? = nil
    }

    /// 팬/줌 world — 편집기 world 와 동일한 구조. frame 은 모든 노드를 포함할 수 있게 충분히 크게.
    private var canvasWorld: some View {
        let layout = computeLayout()
        let wSize = viewerWorldSize(layout: layout)
        let bounds = viewerBounds(layout: layout)
        return ZStack(alignment: .topLeading) {
            Canvas { ctx, _ in
                ctx.translateBy(x: -bounds.origin.x, y: -bounds.origin.y)
                drawEdges(
                    ctx: ctx,
                    edges: layout.edges,
                    nodeRects: layout.nodes.map {
                        CGRect(x: $0.center.x - nodeW / 2, y: $0.center.y - nodeH / 2, width: nodeW, height: nodeH)
                    }
                )
            }
            .frame(width: bounds.size.width, height: bounds.size.height)
            .offset(x: bounds.origin.x, y: bounds.origin.y)
            .allowsHitTesting(false)

            ForEach(layout.nodes) { node in
                WorkflowNodeCard(
                    title: node.title,
                    type: node.type,
                    status: node.status,
                    iteration: node.iteration,
                    loopbackReason: node.loopbackReason,
                    limitReached: node.limitReached,
                    resultKind: node.resultKind,
                    width: nodeW,
                    height: nodeH
                )
                .position(x: node.center.x, y: node.center.y)
                .onTapGesture {
                    if node.status == "awaiting_approval" || node.status == "needs_attention" {
                        actionTarget = NodeAction(id: node.id, status: node.status, title: node.title)
                    } else if let sid = node.sessionId {
                        onOpenSession(sid)
                    }
                }
            }
        }
        .frame(width: wSize.width, height: wSize.height, alignment: .topLeading)
    }

    /// 간선 Canvas 의 클립 없는 그리기 영역 (음수 좌표 포함 bounding box + 여백).
    private func viewerBounds(layout: Layout) -> (origin: CGPoint, size: CGSize) {
        return (layout.origin, layout.drawSize)
    }

    private struct DisplayEdge {
        let from: CGPoint
        let to: CGPoint
        let condition: String?
    }

    private struct Layout {
        let nodes: [DisplayNode]
        let edges: [DisplayEdge]
        let size: CGSize
        /// 간선 Canvas 의 클립 없는 그리기 영역 — 음수 좌표 포함 bounding box.
        let origin: CGPoint
        let drawSize: CGSize
    }

    /// 정의 + 런타임을 합쳐 표시용 레이아웃을 만든다.
    /// - run 모드: node_run 기준(정적+동적). 정적 간선은 def_node_id→node_run 매핑, 동적 노드는
    ///   parent_node_run_id 로 간선을 그린다. - run 없음: 정의(def) 노드/간선만 pending 으로.
    private func computeLayout() -> Layout {
        var nodes: [DisplayNode] = []
        var centers: [String: CGPoint] = [:]
        var info: [String: (tl: CGPoint, type: String)] = [:]
        var edgesOut: [DisplayEdge] = []
        var maxX: CGFloat = 0
        var maxY: CGFloat = 0
        var minX: CGFloat = 0
        var minY: CGFloat = 0

        func place(_ key: String, _ tlX: CGFloat, _ tlY: CGFloat, _ type: String) -> CGPoint {
            let c = CGPoint(x: tlX + nodeW / 2, y: tlY + nodeH / 2)
            centers[key] = c
            info[key] = (CGPoint(x: tlX, y: tlY), type)
            maxX = max(maxX, tlX + nodeW)
            maxY = max(maxY, tlY + nodeH)
            minX = min(minX, tlX)
            minY = min(minY, tlY)
            return c
        }
        // 엣지 시작점 = 출발 노드의 출력 포트(성공=하단 중앙 / 실패=우측 중앙, start 는 하단 중앙).
        func outPort(_ key: String, _ cond: String?) -> CGPoint? {
            guard let i = info[key] else { return nil }
            switch i.type {
            case "end": return centers[key]
            case "start": return CGPoint(x: i.tl.x + nodeW / 2, y: i.tl.y + nodeH)
            default:
                if cond == "fail" {
                    return CGPoint(x: i.tl.x + nodeW, y: i.tl.y + nodeH / 2)
                }
                return CGPoint(x: i.tl.x + nodeW / 2, y: i.tl.y + nodeH)
            }
        }

        if let rs = runState {
            var runIdByDef: [String: String] = [:]
            for nr in rs.nodeRuns where nr.def_node_id != nil {
                runIdByDef[nr.def_node_id!] = nr.id
            }
            for (i, nr) in rs.nodeRuns.enumerated() {
                let c = place(nr.id, CGFloat(nr.x ?? 40), CGFloat(nr.y ?? (40 + 140 * Double(i))), nr.node_type)
                nodes.append(
                    DisplayNode(
                        id: nr.id,
                        title: nr.title ?? (nr.def_node_id ?? "·"),
                        type: nr.node_type,
                        center: c,
                        status: nr.status,
                        sessionId: nr.session_id,
                        iteration: nr.iteration ?? 0,
                        loopbackReason: nr.loopback_reason,
                        limitReached: (nr.limit_reached ?? 0) != 0,
                        resultKind: nr.result_kind
                    )
                )
            }
            // 정적 def 간선 (def id → node_run id).
            for e in rs.edges {
                guard let fk = runIdByDef[e.from], let tk = runIdByDef[e.to],
                      let f = outPort(fk, e.condition), let t = centers[tk] else { continue }
                edgesOut.append(DisplayEdge(from: f, to: t, condition: e.condition))
            }
            // 동적 노드 간선 (parent_node_run_id → 자기).
            for nr in rs.nodeRuns where nr.def_node_id == nil {
                guard let p = nr.parent_node_run_id, let f = outPort(p, nil), let t = centers[nr.id] else { continue }
                edgesOut.append(DisplayEdge(from: f, to: t, condition: nil))
            }
        } else {
            for (i, n) in def.nodes.enumerated() {
                let c = place(n.id, CGFloat(n.x ?? 40), CGFloat(n.y ?? (40 + 140 * Double(i))), n.type)
                nodes.append(
                    DisplayNode(id: n.id, title: n.title ?? n.id, type: n.type, center: c, status: "pending", sessionId: nil)
                )
            }
            for e in def.edges {
                guard let f = outPort(e.from, e.condition), let t = centers[e.to] else { continue }
                edgesOut.append(DisplayEdge(from: f, to: t, condition: e.condition))
            }
        }
        let pad: CGFloat = 240
        let origin = CGPoint(x: minX - pad, y: minY - pad)
        let drawSize = CGSize(width: maxX + pad - origin.x, height: maxY + pad - origin.y)
        return Layout(
            nodes: nodes,
            edges: edgesOut,
            size: CGSize(width: maxX + 40, height: maxY + 40),
            origin: origin,
            drawSize: drawSize
        )
    }

    private func drawEdges(ctx: GraphicsContext, edges: [DisplayEdge], nodeRects: [CGRect]) {
        for e in edges {
            let color: Color = e.condition == "fail" ? Theme.Edge.fail
                : Theme.Edge.normal
            // 직선 대신 곡선으로 라우팅 — 경로가 중간 노드 카드를 가로지르면 노드 위치 기준으로 우회한다.
            // 화살촉은 곡선 끝 접선 방향, 끝점은 nodeH/2 보정으로 당긴 채 유지.
            let routed = routeWorkflowEdge(from: e.from, to: e.to, condition: e.condition,
                                           nodeRects: nodeRects, nodeH: nodeH)
            ctx.stroke(routed.path, with: .color(color), lineWidth: Theme.Edge.widthReadonly)

            let ah: CGFloat = Theme.Edge.arrow
            let angle = routed.arrowAngle
            var head = Path()
            head.move(to: routed.end)
            head.addLine(to: CGPoint(x: routed.end.x - ah * cos(angle - .pi / 7), y: routed.end.y - ah * sin(angle - .pi / 7)))
            head.move(to: routed.end)
            head.addLine(to: CGPoint(x: routed.end.x - ah * cos(angle + .pi / 7), y: routed.end.y - ah * sin(angle + .pi / 7)))
            ctx.stroke(head, with: .color(color), lineWidth: Theme.Edge.widthReadonly)

            if e.condition == "fail" {
                ctx.draw(
                    Text("실패").font(.caption2).foregroundStyle(color),
                    at: routed.mid
                )
            }
        }
    }

    // MARK: - 하단 상태바

    /// 실패한 run 을 주저앉힌 노드 — node_runs 의 status=="failed" 중 가장 마지막에 끝난 것.
    /// 「어느 노드」(이름) + 선택적 「어떻게」(daemon verdict) 를 돌려준다. 못 찾으면 nil → 사유 줄 생략
    /// (엣지: node_runs 빈약). engine 은 daemon 재시작 시 떠 있던 running 을 failed 로 reconcile 하므로
    /// 재시작 중단도 그 노드가 failed 로 잡힌다(ARCHITECTURE §12.2).
    private var failedNode: (name: String, detail: String?)? {
        guard let runs = runState?.nodeRuns else { return nil }
        let failed = runs
            .filter { $0.status == "failed" }
            .sorted { ($0.ended_at ?? $0.created_at) > ($1.ended_at ?? $1.created_at) }
        guard let node = failed.first, let name = node.title ?? node.def_node_id else { return nil }
        // verdict 가 「pass/fail」 류 토큰이 아니라 사람이 읽을 짧은 사유면 보조 줄로(daemon 데이터 → verbatim).
        let generic: Set<String> = ["fail", "failed", "pass", "ok", "done", "error"]
        let v = node.verdict?.trimmingCharacters(in: .whitespacesAndNewlines)
        let detail: String? = {
            guard let v, !v.isEmpty, v.count <= 80, !v.contains("\n"),
                  !generic.contains(v.lowercased()) else { return nil }
            return v
        }()
        return (name, detail)
    }

    /// 재시도 한도(max_iterations)에 닿아 멈춘 노드 — 있으면 그 이름/사유를 run 레벨에서 분명히 드러낸다.
    private var limitReachedNode: (name: String, reason: String?)? {
        guard let runs = runState?.nodeRuns else { return nil }
        guard let node = runs.first(where: { ($0.limit_reached ?? 0) != 0 }) else { return nil }
        guard let name = node.title ?? node.def_node_id else { return nil }
        let r = node.loopback_reason?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (name, (r?.isEmpty == false) ? r : nil)
    }

    @ViewBuilder
    private func runStatusBar(_ run: WorkflowRunInfo) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.s) {
            HStack(spacing: Theme.Spacing.m) {
                if run.status == "running" {
                    ProgressView().controlSize(.small)
                }
                workflowStatusText(run.status)
                    .font(.subheadline.weight(.medium))
                Spacer()
                // 「루프 감독」 진입 — 반복 진행/검사/변경을 위에서 한눈에 + 한 번에 멈춤. run 이 있으면 항상.
                Button {
                    showLoopMonitor = true
                } label: {
                    Label("루프 감독", systemImage: "gauge.with.dots.needle.bottom.50percent")
                }
                .font(.caption)
                .accessibilityLabel(Text("루프 감독"))
                if isRunning {
                    Text("진행 중…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    // 종료된 run(done/failed/cancelled) — 현재 정의로 재실행. start() 가 runWorkflow(def.id)
                    // 를 그대로 호출하므로 수동 실행과 동일한 workflow_v1 소프트 게이트(pro)를 탄다.
                    Button {
                        Task { await start() }
                    } label: {
                        Label("재실행", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(starting)   // 빠른 더블탭 — 시작 중 비활성.
                }
            }
            // 격리(worktree) + 머지 관측 — 이 run 이 어느 격리 브랜치에서 돌고 머지가 큐/완료/충돌인지.
            // 데이터는 기존 merge-queue API + run 의 노드 세션을 엮어 구성(self-contained 폴링/상태).
            WorkflowRunIsolationView(
                auth: auth,
                conn: conn,
                inflight: inflight,
                repoPath: def.repo_path ?? runState?.nodes.first(where: { $0.repo_path != nil })?.repo_path,
                sessionIds: runState?.nodeRuns.compactMap(\.session_id) ?? [],
                runStatus: run.status
            )
            // 실패한 run — 어느 노드가 (어떻게) 실패했는지 짧게. node_runs 가 빈약하면 줄 생략.
            if run.status == "failed", let info = failedNode {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("‹\(info.name)› 노드 실패")
                        if let detail = info.detail {
                            Text(verbatim: detail)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
                .font(.caption)
                .foregroundStyle(Theme.danger)
            }
            // 종료된 run 에서만 — 재실행이 「현재」 정의로 새 run 을 시작함을 분명히(과거 정의 복제 아님).
            if !isRunning {
                Text("재실행하면 현재 워크플로우 정의로 새 실행이 시작돼요(과거 정의를 복제하지 않아요).")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Theme.Spacing.xxl)
        .padding(.vertical, Theme.Spacing.l)
        .background(.ultraThinMaterial)
    }

    // MARK: - Actions

    @MainActor
    private func loadLatestRun() async {
        // 이미 실행 중이면(러닝 폴 진행) 건드리지 않는다.
        if runId != nil { return }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            let detail = try await api.workflowDetail(id: def.id)
            if let latest = detail.runs.first {
                runId = latest.id
            }
        } catch {
            // 최근 run 조회 실패는 치명적 아님 — 정의만 보여준다.
        }
    }

    @MainActor
    private func start() async {
        starting = true
        defer { starting = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            let rid = try await api.runWorkflow(id: def.id)
            runState = nil
            runId = rid
        } catch {
            self.error = error.localizedDescription
        }
    }

    @MainActor
    private func cancel() async {
        guard let rid = runId else { return }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            try await api.cancelWorkflowRun(runId: rid)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func pollLoop() async {
        guard let rid = runId else { return }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        while !Task.isCancelled {
            do {
                let st = try await api.workflowRunState(runId: rid)
                await MainActor.run { runState = st }
                if st.run.status != "running" { break }
            } catch {
                // 일시 실패 — 잠시 후 재시도 (캔버스를 떠나면 task 취소로 루프 종료).
            }
            try? await Task.sleep(nanoseconds: 1_500_000_000)
        }
    }
}

// MARK: - 노드 카드 / 상태 표시 helpers

/// 한 노드 카드 — 타입 아이콘 + 제목 + 상태색 테두리.
private struct WorkflowNodeCard: View {
    let title: String
    let type: String
    let status: String
    var iteration: Int = 0
    var loopbackReason: String? = nil
    var limitReached: Bool = false
    /// 결과물 출처 (workflow_attention_v1) — "synthetic"/"empty" 면 둘째 줄에 warning 표식.
    var resultKind: String? = nil
    let width: CGFloat
    let height: CGFloat

    /// 재시도 중/했음 — 반복 횟수가 1 이상이면 루프를 한 번 이상 돌았다는 뜻.
    private var isRetrying: Bool { iteration > 0 }

    /// 결과가 «합성본/빈 결과» 인지 — 정상 결과(agent)·미실행(nil)과 구분. 합성본은 «프롬프트 타이핑
    /// 화면» 이 결과로 둔갑한 것이라, 다음 노드가 헛돌지 않게 시각적으로 분명히 표시한다.
    private var synthetic: Bool { resultKind == "synthetic" || resultKind == "empty" }
    private var resultMarkerText: Text? {
        switch resultKind {
        case "synthetic": return Text("합성본")
        case "empty": return Text("빈 결과")
        default: return nil
        }
    }

    /// 둘째 줄에 «되돌아간 사유» 를 보일지 — 재시도 중이고 사유 문자열이 있을 때만.
    private var reasonLine: String? {
        guard isRetrying, let r = loopbackReason?.trimmingCharacters(in: .whitespacesAndNewlines),
              !r.isEmpty else { return nil }
        return r
    }

    var body: some View {
        let color = workflowStatusColor(status)
        HStack(spacing: Theme.Spacing.m) {
            Image(systemName: workflowTypeIcon(type))
                .font(.system(size: 18))
                .foregroundStyle(color)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                // 둘째 줄: 재시도 중엔 «되돌아간 사유», 합성본/빈 결과면 warning 표식, 아니면 상태 라벨.
                if let reason = reasonLine {
                    Text(verbatim: reason)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else if let marker = resultMarkerText {
                    Label { marker } icon: {
                        Image(systemName: "doc.text.magnifyingglass")
                    }
                    .labelStyle(.titleAndIcon)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(Theme.warning)
                    .lineLimit(1)
                } else {
                    workflowStatusText(status)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.Spacing.l)
        .frame(width: width, height: height)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.l)
                .fill(color.opacity(Theme.Opacity.fill))
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.l)
                .stroke(color.opacity(status == "pending" ? Theme.Opacity.border : 0.8), lineWidth: 1.5)
        )
        // 합성본/빈 결과는 정상 «완료»(초록 테두리)와 헷갈리지 않게 warning 테두리를 덧입힌다.
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.l)
                .strokeBorder(Theme.warning.opacity(synthetic ? 0.9 : 0), lineWidth: 1.5)
        )
        // 재시도 배지 — 레이아웃 footprint 를 키우지 않도록 overlay(우상단). limit_reached 면 danger,
        // 아니면 중립(회색) — 반복 횟수는 «개수» 라 status 색을 빌려 쓰지 않는다.
        .overlay(alignment: .topTrailing) {
            if isRetrying || limitReached {
                retryBadge
                    .padding(Theme.Spacing.xs)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    @ViewBuilder
    private var retryBadge: some View {
        let isLimit = limitReached
        HStack(spacing: 2) {
            Image(systemName: isLimit ? "exclamationmark.octagon.fill" : "arrow.clockwise")
                .font(.system(size: 9, weight: .bold))
            Text(verbatim: "\(max(iteration, 1))")
                .font(.system(size: 10, weight: .semibold))
                .monospacedDigit()
        }
        .foregroundStyle(isLimit ? Theme.onAccent : Color.primary)
        .padding(.horizontal, Theme.Spacing.s)
        .padding(.vertical, Theme.Spacing.xxs)
        .background(
            Capsule().fill(isLimit ? Theme.danger : Color.secondary.opacity(Theme.Opacity.badge))
        )
    }

    /// 카드 전체를 한 문장으로 — VoiceOver 가 제목·상태·재시도·한도·사유를 한 번에 읽는다.
    private var accessibilityText: Text {
        var t = Text(verbatim: title) + Text(verbatim: ", ") + workflowStatusText(status)
        if limitReached {
            t = t + Text(verbatim: ", ") + Text("재시도 한도 도달")
        } else if isRetrying {
            t = t + Text(verbatim: ", ") + Text("재시도 \(iteration)회")
        }
        if let reason = reasonLine {
            t = t + Text(verbatim: ", ") + Text("되돌아간 사유: ") + Text(verbatim: reason)
        }
        if let marker = resultMarkerText {
            t = t + Text(verbatim: ", ") + marker
        }
        return t
    }
}

func workflowStatusColor(_ status: String) -> Color {
    switch status {
    case "running": return Theme.accent
    case "done": return Theme.success
    case "failed": return Theme.danger
    case "needs_attention", "awaiting_approval": return Theme.warning
    case "skipped": return .secondary
    default: return .secondary // pending
    }
}

private func workflowTypeIcon(_ type: String) -> String {
    switch type {
    case "start": return "play.circle.fill"
    case "end": return "flag.checkered"
    default: return "cpu" // task (및 옛 general/test)
    }
}

/// 상태 라벨 — Text(LocalizedStringKey) 자동 추출 경로 (각 분기가 Text literal).
/// 색 약속은 workflowStatusColor 와 한 쌍 — 실행 기록 시트(WorkflowRunHistorySheet)도 재사용.
func workflowStatusText(_ status: String) -> Text {
    switch status {
    case "running": return Text("실행 중")
    case "done": return Text("완료")
    case "failed": return Text("실패")
    case "needs_attention": return Text("확인 필요")
    case "awaiting_approval": return Text("승인 대기")
    case "skipped": return Text("건너뜀")
    case "cancelled": return Text("취소됨")
    default: return Text("대기 중")
    }
}
