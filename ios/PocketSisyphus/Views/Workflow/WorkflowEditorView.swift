import SwiftUI
import UIKit  // UIImpactFeedbackGenerator — 롱프레스 노드 추가 햅틱

/// 워크플로우 캔버스 편집기 (Phase 1) — 노드를 추가/드래그/연결해 임의 그래프를 그린다.
///
/// - 노드 추가: 툴바 「+」 메뉴에서 시작/작업/종료 선택.
/// - 배치: 노드 본체를 드래그해 이동. 빈 곳 드래그로 팬, 핀치로 줌.
/// - 연결: 노드 하단의 «출력 포트»를 드래그해 다른 노드 위에 놓으면 선이 이어진다. 작업
///   노드는 포트가 둘 — 성공/다음(하단 중앙)·실패(우측 중앙, 빨강) — 라 결과별 다음 노드를 각각 지정한다.
///   순환은 막는다(성공 연결로 루프 불가). 루프는 작업의 «실패» 포트로만 — 실행 시 bound.
/// - 편집: 노드 탭 → 인스펙터(제목/프롬프트/에이전트/승인/삭제). 간선 제거는 화살표 핸들 길게 누르기.
/// - 저장: PUT 으로 daemon 에 그래프를 갱신 (daemon 이 DAG 재검증).
///
/// 좌표는 «월드» 기준(노드 x/y top-left). 화면 표시는 scale/offset 변환. 간선 Canvas 는
/// hit-testing 비활성 — 빈 영역 터치는 뒤의 팬 surface 로 빠지고, 노드만 자기 제스처를 잡는다.
struct WorkflowEditorView: View {
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker
    let workflowId: String
    /// 노드 세션을 채팅 화면으로 열기 — 실행 뷰어로 전달.
    let onOpenSession: (String) -> Void
    let onSaved: (WorkflowSummary) -> Void

    /// 마지막 저장된 정의 — 「실행」 뷰어에 넘긴다 (편집 중인 미저장 상태가 아니라 저장본).
    @State private var current: WorkflowSummary
    @State private var nodes: [EditNode]
    @State private var edges: [EditEdge]
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero
    /// 빈 영역 롱프레스로 띄우는 «노드 추가» 메뉴 — 누른 화면 좌표(screen)+월드 좌표(world).
    @State private var createMenu: CreateMenu?
    /// 편집 캔버스 진입 시 한 번만 전체 노드를 화면에 맞춘다(auto-fit). 회전/재레이아웃엔 재적용 X.
    @State private var didFit = false
    @State private var inspectNodeId: String?
    /// 포트에서 드래그해 선을 그리는 중 — 출발 노드/조건 + 현재 손가락 위치(월드 좌표).
    @State private var connectDrag: ConnectDrag?
    /// 짧게 떴다 사라지는 안내(예: 순환 거부).
    @State private var notice: LocalizedStringKey?
    /// 현재 선택된 요소 — 명확한 선택 표시용 (노드/간선 강조).
    @State private var selection: WfSel?
    @State private var dragStart: [String: CGPoint] = [:]
    @State private var saving = false
    @State private var error: String?
    @State private var dirty = false
    /// daemon 에 등록된 도구(코드 에이전트 + 터미널) — 노드 인스펙터의 «도구» 피커에 쓴다.
    /// 새 세션 시트와 동일하게 displayName 으로 노출(raw id 노출 금지). 404(옛 daemon)면 fallback.
    @State private var agents: [AgentInfo] = [AgentInfo.claudeCodeFallback]

    private let nodeW: CGFloat = 168
    private let nodeH: CGFloat = 70

    init(
        auth: AuthStore,
        conn: ConnectionManager,
        inflight: InFlightTracker,
        workflow: WorkflowSummary,
        onOpenSession: @escaping (String) -> Void,
        onSaved: @escaping (WorkflowSummary) -> Void
    ) {
        self.auth = auth
        self.conn = conn
        self.inflight = inflight
        self.workflowId = workflow.id
        self.onOpenSession = onOpenSession
        self.onSaved = onSaved
        _current = State(initialValue: workflow)
        _nodes = State(initialValue: workflow.nodes.map(EditNode.init(from:)))
        _edges = State(initialValue: workflow.edges.map(EditEdge.init(from:)))
    }

    /// 편집 히스토리 — 변경 직전 (nodes, edges) 스냅샷 스택. 구조적 변경(추가/삭제/연결/이동/
    /// 사이 삽입) 직전에 push 하고, undo 는 직전 스냅샷으로 되돌린다(redo 로 복원).
    @State private var undoStack: [EditSnapshot] = []
    @State private var redoStack: [EditSnapshot] = []

    struct EditSnapshot {
        let nodes: [EditNode]
        let edges: [EditEdge]
    }

    private enum WfSel: Equatable {
        case node(String)
        case edge(String)
    }

    /// 진행 중인 연결 드래그.
    private struct ConnectDrag {
        let from: String
        let cond: String?   // 출발 포트의 조건 (test 노드의 pass/fail, 그 외 nil)
        var point: CGPoint  // 월드 좌표
    }

    /// 빈 영역 롱프레스 «노드 추가» 메뉴 — 누른 화면 좌표(메뉴 위치)와 월드 좌표(노드 생성 위치).
    private struct CreateMenu {
        var screen: CGPoint
        var world: CGPoint
    }

    var body: some View {
        canvas
            .navigationTitle("편집")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
            .overlay(alignment: .bottom) { if let n = notice { noticeBanner(n) } }
            .overlay { if saving { ProgressView() } }
            .task { await loadAgents() }
            .sheet(
                isPresented: Binding(get: { inspectNodeId != nil }, set: { if !$0 { inspectNodeId = nil } }),
                onDismiss: { dirty = true }  // 인스펙터에서 무엇이든 바꿨을 수 있으니 저장 활성화.
            ) {
                if let idx = nodes.firstIndex(where: { $0.id == inspectNodeId }) {
                    NodeInspectorSheet(node: $nodes[idx], agents: agents) {
                        deleteNode(nodes[idx].id)
                        inspectNodeId = nil
                    }
                    .presentationDetents([.medium, .large])
                }
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
    }

    // MARK: - 캔버스

    private var canvas: some View {
        GeometryReader { geo in
            ZStack {
                // 팬/줌 surface — 빈 영역 터치를 잡는다. geo 크기로 고정해 «화면(local) 좌표»가
                // 캔버스 좌표와 일치하게 한다(월드보다 큰 ZStack 에 끌려가 origin 이 어긋나지 않도록).
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
                    // 빈 영역 길게 누르기 → 누른 자리에 «노드 추가» 메뉴. 손가락이 움직이면 위 팬
                    // 드래그(minimumDistance 기본 10)가 먼저 잡으므로, 가만히 누를 때만 메뉴가 뜬다.
                    .simultaneousGesture(createMenuGesture(canvas: geo.size))
                    .onTapGesture { selection = nil }

                world
                    .scaleEffect(scale)
                    .offset(offset)
            }
            .frame(width: geo.size.width, height: geo.size.height)
            // 롱프레스 «노드 추가» 메뉴 — world(geo 보다 큰) 를 품은 ZStack 좌표계에 끌려가면
            // .position 이 중앙정렬 오프셋만큼 밀려 메뉴가 화면 밖으로 샌다. 그래서 geo 크기로
            // 고정된 overlay(독립 좌표계, scrim 이 채움)에서 띄워 press(geo) 와 좌표계를 일치시킨다.
            // 스크림 탭은 닫기 + 메뉴 떠 있는 동안 노드 오조작 차단.
            .overlay {
                if let menu = createMenu {
                    ZStack {
                        Color.black.opacity(0.001)
                            .contentShape(Rectangle())
                            .onTapGesture { dismissCreateMenu() }
                        nodeCreateMenu(world: menu.world)
                            .position(clampedMenuCenter(press: menu.screen, canvas: geo.size))
                            .transition(.scale(scale: 0.9, anchor: .top).combined(with: .opacity))
                    }
                }
            }
            .clipped()
            // 진입 시 한 번 — 그려진 노드 전체가 보이도록 zoom/offset 을 맞춘다.
            .onAppear { attemptFit(geo.size) }
            .onChange(of: geo.size) { newSize in attemptFit(newSize) }
        }
    }

    private var world: some View {
        let size = worldSize()
        let bounds = worldBounds()
        return ZStack(alignment: .topLeading) {
            // 간선 Canvas — Canvas 는 자기 frame 으로 그리기를 클리핑한다. 노드(ZStack 자식)는
            // 클립 안 되는데 Canvas 만 클립돼, 노드를 좌/상단(음수 좌표)으로 끌면 «화살표만 잘려»
            // 보였다. 그래서 frame 을 음수까지 포함한 전체 bounds 로 키우고, origin 으로 offset +
            // 컨텍스트를 -origin 평행이동해 월드 좌표를 노드와 정확히 맞춘다.
            Canvas { ctx, _ in
                ctx.translateBy(x: -bounds.origin.x, y: -bounds.origin.y)
                drawEdges(ctx)
            }
            .frame(width: bounds.size.width, height: bounds.size.height)
            .offset(x: bounds.origin.x, y: bounds.origin.y)
            .allowsHitTesting(false)

            // 노드 카드 — 본체 드래그로 이동, 탭으로 인스펙터.
            ForEach($nodes) { $node in
                EditorNodeCard(
                    title: node.title.isEmpty ? editorTypeLabel(node.type) : node.title,
                    type: node.type,
                    agent: node.agent,
                    selected: selection == .node(node.id),
                    width: nodeW,
                    height: nodeH
                )
                .position(x: CGFloat(node.x) + nodeW / 2, y: CGFloat(node.y) + nodeH / 2)
                // 드래그는 «wf»(월드) 좌표공간에서 측정한다. 노드 본체의 .local 공간을 쓰면 .position
                // 으로 노드를 옮기는 순간 그 공간도 함께 움직여 피드백 루프가 생기고(=몇 배로 튐),
                // scaleEffect 보정을 또 곱하며 더 어긋난다. «wf» 는 월드 ZStack 에 고정돼 노드가 움직여도
                // 흔들리지 않고, 좌표가 이미 월드 단위라 scale 로 나눌 필요도 없다(포트 드래그와 동일).
                .gesture(
                    DragGesture(minimumDistance: 6, coordinateSpace: .named("wf"))
                        .onChanged { v in
                            let start = dragStart[node.id] ?? CGPoint(x: node.x, y: node.y)
                            if dragStart[node.id] == nil { dragStart[node.id] = start; pushUndo() }
                            node.x = Double(start.x + v.translation.width)
                            node.y = Double(start.y + v.translation.height)
                            dirty = true
                        }
                        .onEnded { _ in dragStart[node.id] = nil }
                )
                .onTapGesture {
                    selection = .node(node.id)
                    inspectNodeId = node.id
                }
            }

            // 간선 핸들 — 화살표 중점의 작은 점. 길게 누르면(컨텍스트 메뉴) 사이에 노드 추가 /
            // 연결 제거. (macOS 에선 우클릭으로 같은 메뉴가 뜬다.)
            ForEach(edges) { e in
                if let mid = edgeMidpoint(e) {
                    edgeHandle(e).position(mid)
                }
            }

            // 출력 포트 — 노드 위에 올려 드래그하면 선을 끌어 다른 노드에 놓아 연결한다.
            // (노드 본체보다 위 레이어라 포트 터치가 우선; 빈 곳은 뒤의 팬 surface 로.)
            ForEach(nodes) { node in
                ForEach(Array(outputPorts(node).enumerated()), id: \.offset) { _, port in
                    portHandle(nodeId: node.id, cond: port.cond, at: port.pt)
                }
            }
        }
        .coordinateSpace(name: "wf")
        .frame(width: size.width, height: size.height, alignment: .topLeading)
    }

    /// 한 출력 포트 핸들 — 드래그하면 connectDrag 를 갱신, 놓으면 대상 노드에 연결을 시도.
    private func portHandle(nodeId: String, cond: String?, at pt: CGPoint) -> some View {
        // iOS 는 터치 타겟이 작아 드래그로 선 긋기가 어려워 포인트를 2배로 키운다(15→30).
        Circle()
            .fill(portColor(cond))
            .frame(width: 30, height: 30)
            .overlay(Circle().stroke(Theme.onAccent, lineWidth: 2.5))
            .overlay(Circle().fill(Theme.onAccent).frame(width: 8, height: 8))
            .position(pt)
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .named("wf"))
                    .onChanged { v in
                        connectDrag = ConnectDrag(from: nodeId, cond: cond, point: v.location)
                    }
                    .onEnded { v in
                        if let target = nodeAt(v.location), target != nodeId {
                            tryCreateEdge(from: nodeId, to: target, condition: cond)
                        }
                        connectDrag = nil
                    }
            )
    }

    private func worldSize() -> CGSize {
        var maxX: CGFloat = 800
        var maxY: CGFloat = 1000
        for n in nodes {
            maxX = max(maxX, CGFloat(n.x) + nodeW + 80)
            maxY = max(maxY, CGFloat(n.y) + nodeH + 80)
        }
        return CGSize(width: maxX, height: maxY)
    }

    /// 간선 Canvas 가 클리핑 없이 그릴 영역 — 모든 노드를 감싸는 bounding box(음수 좌표 포함) +
    /// 여백. origin 은 음수일 수 있다(노드를 좌/상단으로 끌어 넘어간 경우).
    private func worldBounds() -> (origin: CGPoint, size: CGSize) {
        let pad: CGFloat = 240
        var minX: CGFloat = 0, minY: CGFloat = 0
        var maxX: CGFloat = 800, maxY: CGFloat = 1000
        for n in nodes {
            minX = min(minX, CGFloat(n.x))
            minY = min(minY, CGFloat(n.y))
            maxX = max(maxX, CGFloat(n.x) + nodeW)
            maxY = max(maxY, CGFloat(n.y) + nodeH)
        }
        let origin = CGPoint(x: minX - pad, y: minY - pad)
        return (origin, CGSize(width: maxX + pad - origin.x, height: maxY + pad - origin.y))
    }

    private func drawEdges(_ ctx: GraphicsContext) {
        let nodeById = Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, $0) })
        let nodeRects = nodes.map { CGRect(x: CGFloat($0.x), y: CGFloat($0.y), width: nodeW, height: nodeH) }
        for e in edges {
            guard let fromNode = nodeById[e.from], let toNode = nodeById[e.to] else { continue }
            // 화살표는 노드 중앙이 아니라 이 엣지를 만든 «출력 포트»(성공=하단 중앙 / 실패=우측 중앙)에서 시작한다.
            let from = outputPorts(fromNode).first(where: { $0.cond == e.condition })?.pt
                ?? CGPoint(x: CGFloat(fromNode.x) + nodeW / 2, y: CGFloat(fromNode.y) + nodeH)
            let to = CGPoint(x: CGFloat(toNode.x) + nodeW / 2, y: CGFloat(toNode.y) + nodeH / 2)
            let isSel = selection == .edge(e.id)
            let baseColor: Color = e.condition == "fail" ? Theme.Edge.fail
                : Theme.Edge.normal
            let color = isSel ? Theme.Edge.selected : baseColor
            let lw: CGFloat = isSel ? Theme.Edge.widthSelected : Theme.Edge.width
            // 직선 대신 곡선 라우팅 — 중간 노드 카드를 가로지르면 노드 위치 기준으로 우회한다.
            let routed = routeWorkflowEdge(from: from, to: to, condition: e.condition,
                                           nodeRects: nodeRects, nodeH: nodeH)
            ctx.stroke(routed.path, with: .color(color), lineWidth: lw)

            let ah: CGFloat = isSel ? Theme.Edge.arrowSelected : Theme.Edge.arrow
            let ang = routed.arrowAngle
            var head = Path()
            head.move(to: routed.end)
            head.addLine(to: CGPoint(x: routed.end.x - ah * cos(ang - .pi / 7), y: routed.end.y - ah * sin(ang - .pi / 7)))
            head.move(to: routed.end)
            head.addLine(to: CGPoint(x: routed.end.x - ah * cos(ang + .pi / 7), y: routed.end.y - ah * sin(ang + .pi / 7)))
            ctx.stroke(head, with: .color(color), lineWidth: lw)

            if e.condition == "fail" {
                ctx.draw(
                    Text("실패").font(.caption2).foregroundStyle(color),
                    at: routed.mid
                )
            }
        }

        // 진행 중인 연결 드래그 — 출발 포트에서 손가락까지 점선.
        if let cd = connectDrag, let src = sourcePortPoint(cd) {
            var temp = Path()
            temp.move(to: src)
            temp.addLine(to: cd.point)
            ctx.stroke(
                temp,
                with: .color(portColor(cd.cond)),
                style: StrokeStyle(lineWidth: Theme.Edge.widthDrag, dash: Theme.Edge.dragDash)
            )
        }
    }

    // MARK: - 포트 기하 / 히트테스트

    /// 노드의 출력 포트들 — start 는 하단 중앙 1개(다음), 작업은 하단 중앙(성공/다음)·우측 중앙(실패) 2개,
    /// end 는 없음. 좌표는 월드(노드 x/y) 기준.
    private func outputPorts(_ n: EditNode) -> [(cond: String?, pt: CGPoint)] {
        let bx = CGFloat(n.x)
        let by = CGFloat(n.y)
        switch n.type {
        case "end":
            return []
        case "start":
            return [(cond: nil, pt: CGPoint(x: bx + nodeW / 2, y: by + nodeH))]
        default:  // 작업(task) 및 옛 general/test — 성공/다음(하단 중앙) + 실패(우측 중앙)
            return [
                (cond: nil, pt: CGPoint(x: bx + nodeW / 2, y: by + nodeH)),
                (cond: "fail", pt: CGPoint(x: bx + nodeW, y: by + nodeH / 2)),
            ]
        }
    }

    private func sourcePortPoint(_ cd: ConnectDrag) -> CGPoint? {
        guard let n = nodes.first(where: { $0.id == cd.from }) else { return nil }
        return outputPorts(n).first(where: { $0.cond == cd.cond })?.pt
    }

    private func portColor(_ cond: String?) -> Color {
        switch cond {
        case "fail": return Theme.danger
        default: return Theme.accent   // nil = 성공/다음
        }
    }

    /// 월드 좌표 한 점이 어느 노드 사각형 안에 있는지 — 연결 드롭 대상 판정.
    private func nodeAt(_ p: CGPoint) -> String? {
        for n in nodes {
            let x = CGFloat(n.x), y = CGFloat(n.y)
            if p.x >= x && p.x <= x + nodeW && p.y >= y && p.y <= y + nodeH {
                return n.id
            }
        }
        return nil
    }

    // MARK: - 간선 핸들 (사이에 노드 추가 / 연결 제거)

    private func centerOf(_ id: String) -> CGPoint? {
        guard let n = nodes.first(where: { $0.id == id }) else { return nil }
        return CGPoint(x: CGFloat(n.x) + nodeW / 2, y: CGFloat(n.y) + nodeH / 2)
    }

    private func edgeMidpoint(_ e: EditEdge) -> CGPoint? {
        guard let f = centerOf(e.from), let t = centerOf(e.to) else { return nil }
        return CGPoint(x: (f.x + t.x) / 2, y: (f.y + t.y) / 2)
    }

    /// 화살표 중점 핸들 — 길게 누르기(iOS) / 우클릭(macOS) 으로 컨텍스트 메뉴.
    private func edgeHandle(_ e: EditEdge) -> some View {
        let color = portColor(e.condition)
        let isSel = selection == .edge(e.id)
        return ZStack {
            Color.clear.frame(width: 30, height: 30).contentShape(Rectangle())
            // «+» 글리프 제거 — 자동으로 노드가 추가될 것 같은 오해를 줘서. 둥근 점만 두고,
            // 사이에 노드 추가/연결 제거는 길게 누르기(컨텍스트 메뉴)로.
            Circle()
                .fill(color)
                .frame(width: isSel ? 20 : 16, height: isSel ? 20 : 16)
                .overlay(Circle().stroke(.white, lineWidth: 1.5))
                .overlay(Circle().stroke(Theme.accent, lineWidth: isSel ? 3 : 0))
                .shadow(color: isSel ? Theme.accent.opacity(0.6) : .clear, radius: isSel ? 4 : 0)
        }
        .onTapGesture { selection = .edge(e.id) }
        .contextMenu {
            Button { insertNodeOnEdge(e) } label: { Label("사이에 노드 추가", systemImage: "plus.square.on.square") }
            Button(role: .destructive) { deleteEdge(e) } label: { Label("연결 제거", systemImage: "scissors") }
        }
    }

    /// 간선 A→B 사이에 새 작업 노드 N 을 끼운다 — A→N(원래 조건 유지) + N→B(무조건).
    /// N 은 중점에 배치하고 인스펙터를 열어 프롬프트를 채우게 한다.
    private func insertNodeOnEdge(_ e: EditEdge) {
        guard let mid = edgeMidpoint(e) else { return }
        pushUndo()
        let nid = "n_\(UUID().uuidString.prefix(8))"
        nodes.append(EditNode(
            id: nid,
            type: "task",
            title: "",
            prompt: "",
            agent: "claude_code",
            skipPermissions: true,
            x: Double(mid.x - nodeW / 2),
            y: Double(mid.y - nodeH / 2)
        ))
        edges.removeAll { $0.id == e.id }
        edges.append(EditEdge(id: "e_\(UUID().uuidString.prefix(8))", from: e.from, to: nid, condition: e.condition))
        edges.append(EditEdge(id: "e_\(UUID().uuidString.prefix(8))", from: nid, to: e.to, condition: nil))
        dirty = true
        inspectNodeId = nid
    }

    private func deleteEdge(_ e: EditEdge) {
        pushUndo()
        edges.removeAll { $0.id == e.id }
        if selection == .edge(e.id) { selection = nil }
        dirty = true
    }

    // MARK: - 연결 생성 (+ 순환 방지)

    /// 포트 드래그로 from→to 연결을 시도한다. 자기연결/중복은 무시. 무조건(성공) 연결이 순환을
    /// 만들면 거부한다 — 루프는 작업의 «실패» 연결로만 허용(데몬 validateDef 와 동일 규칙; 실행
    /// 시 MAX_ITERATIONS 로 bound). condition 은 출발 포트가 정한다(작업: nil=성공 / "fail"=실패).
    private func tryCreateEdge(from: String, to: String, condition: String?) {
        if from == to { return }
        if edges.contains(where: { $0.from == from && $0.to == to && $0.condition == condition }) { return }
        let isFail = (condition == "fail")
        if !isFail && reachesForward(from: to, target: from) {
            showNotice("순환이 생겨요 — 루프는 작업의 «실패» 연결로만 만들 수 있어요")
            return
        }
        pushUndo()
        edges.append(EditEdge(id: "e_\(UUID().uuidString.prefix(8))", from: from, to: to, condition: condition))
        dirty = true
    }

    /// 전진 그래프(«실패» 간선 제외)에서 a 가 b 에 도달 가능한가 — 순환 판정용.
    /// from→to 추가가 순환이 되는 조건 = to 가 이미 from 에 (전진) 도달함.
    private func reachesForward(from a: String, target b: String) -> Bool {
        var adj: [String: [String]] = [:]
        for e in edges {
            if e.condition == "fail" { continue }
            adj[e.from, default: []].append(e.to)
        }
        var seen: Set<String> = []
        var stack = adj[a] ?? []
        while let cur = stack.popLast() {
            if cur == b { return true }
            if seen.contains(cur) { continue }
            seen.insert(cur)
            stack.append(contentsOf: adj[cur] ?? [])
        }
        return false
    }

    private func showNotice(_ s: LocalizedStringKey) {
        notice = s
        Task {
            try? await Task.sleep(nanoseconds: 1_900_000_000)
            await MainActor.run { if notice == s { notice = nil } }
        }
    }

    private func noticeBanner(_ text: LocalizedStringKey) -> some View {
        Text(text)
            .font(.caption.weight(.medium))
            .foregroundStyle(Theme.onAccent)
            .padding(.horizontal, Theme.Spacing.xl)
            .padding(.vertical, Theme.Spacing.m)
            .background(Theme.danger.opacity(0.92), in: Capsule())
            .padding(.bottom, Theme.Spacing.xxl)
    }

    private func addNode(_ type: String) {
        pushUndo()
        // 현재 뷰포트 좌상단 근처 월드 좌표에 배치 (대략).
        let baseX = Double(-offset.width / scale) + 60
        let baseY = Double(-offset.height / scale) + 60
        let jitter = Double(nodes.count % 5) * 24
        let title: String
        switch type {
        case "start", "end": title = editorTypeLabel(type)  // 기본 이름 다국어(카탈로그 경유)
        default: title = ""   // 작업 노드는 기본 제목 없이 — 사용자가 직접 입력
        }
        nodes.append(
            EditNode(
                id: "n_\(UUID().uuidString.prefix(8))",
                type: type,
                title: title,
                prompt: "",
                agent: isWorkType(type) ? "claude_code" : nil,
                skipPermissions: true,
                x: baseX + jitter,
                y: baseY + jitter
            )
        )
        dirty = true
    }

    private func deleteNode(_ id: String) {
        pushUndo()
        nodes.removeAll { $0.id == id }
        edges.removeAll { $0.from == id || $0.to == id }
        if selection == .node(id) { selection = nil }
        dirty = true
    }

    /// 롱프레스로 고른 월드 좌표 한 점을 중심으로 새 노드를 만든다(노드 x/y 는 top-left 라 절반 보정).
    private func addNode(_ type: String, at worldPoint: CGPoint) {
        pushUndo()
        let title: String
        switch type {
        case "start", "end": title = editorTypeLabel(type)  // 기본 이름 다국어(카탈로그 경유)
        default: title = ""   // 작업 노드는 기본 제목 없이 — 사용자가 직접 입력
        }
        nodes.append(
            EditNode(
                id: "n_\(UUID().uuidString.prefix(8))",
                type: type,
                title: title,
                prompt: "",
                agent: isWorkType(type) ? "claude_code" : nil,
                skipPermissions: true,
                x: Double(worldPoint.x - nodeW / 2),
                y: Double(worldPoint.y - nodeH / 2)
            )
        )
        dirty = true
        dismissCreateMenu()
    }

    // MARK: - 빈 영역 롱프레스 → 노드 추가 메뉴

    /// 빈 영역 길게 누르기 제스처 — 누른 «화면 좌표» 를 잡아(screen) 그 자리에 메뉴를 띄우고,
    /// 같은 점을 월드 좌표로 변환(world)해 노드 생성 위치로 쓴다. LongPress 자체는 위치를 안 주므로
    /// 0거리 DragGesture 를 sequenced 로 붙여 startLocation 을 얻는다.
    private func createMenuGesture(canvas: CGSize) -> some Gesture {
        LongPressGesture(minimumDuration: 0.4)
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .local))
            .onChanged { value in
                guard case .second(true, let drag?) = value, createMenu == nil else { return }
                let press = drag.startLocation
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
                    createMenu = CreateMenu(screen: press, world: localToWorld(press, canvas: canvas))
                }
            }
    }

    private func dismissCreateMenu() {
        withAnimation(.easeOut(duration: 0.15)) { createMenu = nil }
    }

    /// «노드 추가» 팝오버 — 시작/작업/종료 중 골라 누른 자리에 노드를 만든다.
    private func nodeCreateMenu(world: CGPoint) -> some View {
        // 아이콘 색 = 캔버스에 그려지는 노드 종류색(editorTypeColor) 그대로 — 시작 초록 / 작업 분홍 / 종료 파랑.
        VStack(spacing: 0) {
            createMenuRow("시작 노드", icon: "play.circle", color: editorTypeColor("start")) { addNode("start", at: world) }
            Divider().opacity(0.5)
            createMenuRow("작업 노드", icon: "cpu", color: editorTypeColor("task")) { addNode("task", at: world) }
            Divider().opacity(0.5)
            createMenuRow("종료 노드", icon: "flag.checkered", color: editorTypeColor("end")) { addNode("end", at: world) }
        }
        .frame(width: 188)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: Theme.Radius.l))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.l)
                .stroke(Color.white.opacity(0.12), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.4), radius: 12, y: 4)
    }

    private func createMenuRow(_ title: LocalizedStringKey, icon: String, color: Color, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .foregroundStyle(color)
                    .frame(width: 22)
                Text(title)
                    .foregroundStyle(.primary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// 메뉴 중심 좌표 — 손가락 살짝 아래에 두고 화면 밖으로 안 나가게 clamp.
    private func clampedMenuCenter(press: CGPoint, canvas: CGSize) -> CGPoint {
        let w: CGFloat = 188
        let h: CGFloat = 150   // 3행 메뉴 대략 높이
        var cx = press.x
        var cy = press.y + h / 2 + 14
        cx = min(max(cx, w / 2 + 8), canvas.width - w / 2 - 8)
        cy = min(max(cy, h / 2 + 8), canvas.height - h / 2 - 8)
        return CGPoint(x: cx, y: cy)
    }

    // MARK: - 좌표 변환 / auto-fit

    /// 화면(캔버스 local) 좌표 → 월드 좌표. 월드 ZStack 은 캔버스 가운데 정렬 + scaleEffect(중심
    /// 기준) + offset 으로 그려지므로 그 역변환. (worldSize 가 캔버스보다 커도 중앙 정렬 가정 유지.)
    private func localToWorld(_ p: CGPoint, canvas: CGSize) -> CGPoint {
        let s = worldSize()
        return CGPoint(
            x: (p.x - canvas.width / 2 - offset.width) / scale + s.width / 2,
            y: (p.y - canvas.height / 2 - offset.height) / scale + s.height / 2
        )
    }

    /// 진입 시 한 번만 — 모든 노드의 bounding box 가 여백과 함께 화면에 들어오도록 zoom/offset 설정.
    private func attemptFit(_ size: CGSize) {
        guard !didFit, size.width > 1, size.height > 1, !nodes.isEmpty else { return }
        didFit = true
        fitContent(in: size)
    }

    private func fitContent(in canvas: CGSize) {
        guard !nodes.isEmpty else { return }
        let s = worldSize()
        var minX = CGFloat.greatestFiniteMagnitude, minY = CGFloat.greatestFiniteMagnitude
        var maxX = -CGFloat.greatestFiniteMagnitude, maxY = -CGFloat.greatestFiniteMagnitude
        for n in nodes {
            minX = min(minX, CGFloat(n.x)); minY = min(minY, CGFloat(n.y))
            maxX = max(maxX, CGFloat(n.x) + nodeW); maxY = max(maxY, CGFloat(n.y) + nodeH)
        }
        let bw = max(1, maxX - minX), bh = max(1, maxY - minY)
        let bcx = (minX + maxX) / 2, bcy = (minY + maxY) / 2
        let pad: CGFloat = 100
        // 노드가 화면보다 작으면 100% 이상 확대하지 않는다(1.0 cap) — 작은 그래프가 과하게 커지지 않게.
        let fit = min(canvas.width / (bw + pad * 2), canvas.height / (bh + pad * 2))
        let newScale = min(1.0, max(0.4, fit))
        scale = newScale
        lastScale = newScale
        // bbox 중심을 캔버스 중심에 오게: offset = scale * (worldCenter - bboxCenter).
        offset = CGSize(
            width: (s.width / 2 - bcx) * newScale,
            height: (s.height / 2 - bcy) * newScale
        )
        lastOffset = offset
    }

    // MARK: - 툴바 / 배너

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            NavigationLink {
                WorkflowCanvasView(
                    auth: auth,
                    conn: conn,
                    inflight: inflight,
                    workflow: current,
                    onOpenSession: onOpenSession
                )
            } label: {
                Label("실행", systemImage: "play.fill")
            }
            .disabled(dirty || saving)
        }
        ToolbarItem(placement: .topBarLeading) {
            Button { undo() } label: { Image(systemName: "arrow.uturn.backward") }
                .disabled(undoStack.isEmpty)
                .accessibilityLabel(Text("실행 취소"))
        }
        ToolbarItem(placement: .topBarLeading) {
            Button { redo() } label: { Image(systemName: "arrow.uturn.forward") }
                .disabled(redoStack.isEmpty)
                .accessibilityLabel(Text("다시 실행"))
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button { addNode("start") } label: { Label("시작 노드", systemImage: "play.circle") }
                Button { addNode("task") } label: { Label("작업 노드", systemImage: "cpu") }
                Button { addNode("end") } label: { Label("종료 노드", systemImage: "flag.checkered") }
            } label: {
                Image(systemName: "plus")
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button { Task { await save() } } label: { Text("저장") }
                .disabled(saving || !dirty)
        }
    }

    // MARK: - Undo / Redo

    /// 변경 직전에 호출 — 현재 상태를 undo 스택에 쌓고 redo 스택을 비운다. (스택 100개 상한.)
    private func pushUndo() {
        undoStack.append(EditSnapshot(nodes: nodes, edges: edges))
        if undoStack.count > 100 { undoStack.removeFirst() }
        redoStack.removeAll()
    }

    private func undo() {
        guard let snap = undoStack.popLast() else { return }
        redoStack.append(EditSnapshot(nodes: nodes, edges: edges))
        nodes = snap.nodes
        edges = snap.edges
        selection = nil
        dirty = true
    }

    private func redo() {
        guard let snap = redoStack.popLast() else { return }
        undoStack.append(EditSnapshot(nodes: nodes, edges: edges))
        nodes = snap.nodes
        edges = snap.edges
        selection = nil
        dirty = true
    }

    // MARK: - 저장

    @MainActor
    private func save() async {
        saving = true
        defer { saving = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            let saved = try await api.updateWorkflow(
                id: workflowId,
                nodes: nodes.map { $0.toDef() },
                edges: edges.map { $0.toDef() }
            )
            dirty = false
            current = saved
            onSaved(saved)
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// daemon 의 도구 목록을 불러온다 (새 세션 시트와 동일). 404(옛 daemon)면 claude_code fallback 유지.
    @MainActor
    private func loadAgents() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        if let list = try? await api.listAgents(), !list.isEmpty {
            agents = list
        }
    }
}

// MARK: - 편집용 가변 모델

struct EditNode: Identifiable, Equatable {
    let id: String
    var type: String
    var title: String
    var prompt: String
    /// 결과물 처리 지시 (비면 기본 Task 폴더 안내).
    var resultSpec: String
    /// 통과/실패를 가를 «검사 명령» (비면 «검사 미설정» — 자기 판단 폴백).
    var checkCommand: String
    var agent: String?
    var skipPermissions: Bool
    var requiresApproval: Bool
    var triggers: [WorkflowTriggerDef]
    var x: Double
    var y: Double

    init(
        id: String,
        type: String,
        title: String,
        prompt: String,
        resultSpec: String = "",
        checkCommand: String = "",
        agent: String?,
        skipPermissions: Bool,
        requiresApproval: Bool = false,
        triggers: [WorkflowTriggerDef] = [],
        x: Double,
        y: Double
    ) {
        self.id = id
        self.type = type
        self.title = title
        self.prompt = prompt
        self.resultSpec = resultSpec
        self.checkCommand = checkCommand
        self.agent = agent
        self.skipPermissions = skipPermissions
        self.requiresApproval = requiresApproval
        self.triggers = triggers
        self.x = x
        self.y = y
    }

    init(from def: WorkflowNodeDef) {
        self.id = def.id
        self.type = def.type
        self.title = def.title ?? ""
        self.prompt = def.prompt ?? ""
        self.resultSpec = def.result_spec ?? ""
        self.checkCommand = def.check_command ?? ""
        self.agent = def.agent ?? (isWorkType(def.type) ? "claude_code" : nil)
        self.skipPermissions = def.skip_permissions ?? true
        self.requiresApproval = def.requires_approval ?? false
        self.triggers = def.triggers ?? []
        self.x = def.x ?? 60
        self.y = def.y ?? 60
    }

    func toDef() -> WorkflowNodeDef {
        let isWork = isWorkType(type)
        return WorkflowNodeDef(
            id: id,
            type: type,
            title: title.isEmpty ? nil : title,
            agent: isWork ? agent : nil,
            prompt: isWork ? (prompt.isEmpty ? nil : prompt) : nil,
            result_spec: isWork ? (resultSpec.isEmpty ? nil : resultSpec) : nil,
            check_command: isWork ? (checkCommand.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : checkCommand) : nil,
            skip_permissions: isWork ? skipPermissions : nil,
            requires_approval: (isWork && requiresApproval) ? true : nil,
            triggers: (type == "start" && !triggers.isEmpty) ? triggers : nil,
            x: x,
            y: y
        )
    }
}

struct EditEdge: Identifiable, Equatable {
    let id: String
    var from: String
    var to: String
    var condition: String?

    init(id: String, from: String, to: String, condition: String?) {
        self.id = id
        self.from = from
        self.to = to
        self.condition = condition
    }

    init(from def: WorkflowEdgeDef) {
        self.id = def.id
        self.from = def.from
        self.to = def.to
        self.condition = def.condition
    }

    func toDef() -> WorkflowEdgeDef {
        WorkflowEdgeDef(id: id, from: from, to: to, condition: condition)
    }
}

// MARK: - 노드 카드 (편집기)

private struct EditorNodeCard: View {
    let title: String
    let type: String
    let agent: String?
    let selected: Bool
    let width: CGFloat
    let height: CGFloat

    var body: some View {
        let color = editorTypeColor(type)
        HStack(spacing: Theme.Spacing.m) {
            Image(systemName: editorTypeIcon(type))
                .font(.system(size: 18))
                .foregroundStyle(color)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                if let a = agent, isWorkType(type) {
                    Text(verbatim: AgentKind.from(id: a).displayName)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.Spacing.l)
        .frame(width: width, height: height)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.l).fill(color.opacity(selected ? Theme.Opacity.badge : Theme.Opacity.fill)))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.l)
                .stroke(selected ? Theme.accent : color.opacity(0.6), lineWidth: selected ? 3 : 1.5)
        )
        .shadow(color: selected ? Theme.accent.opacity(0.55) : .clear, radius: selected ? 7 : 0)
    }
}

// MARK: - 노드 인스펙터

private struct NodeInspectorSheet: View {
    @Binding var node: EditNode
    /// daemon 에 등록된 도구 목록 (displayName + 설치여부). 새 세션 시트와 동일 소스.
    let agents: [AgentInfo]
    let onDelete: () -> Void

    @Environment(\.dismiss) private var dismiss

    private var isWork: Bool { isWorkType(node.type) }
    /// 현재 선택된 도구 id (기본 claude_code).
    private var selectedAgentId: String { node.agent ?? "claude_code" }
    /// 터미널(셸) 도구 — 명령 기반이 아니라 «셸 스크립트» 를 실행한다.
    private var isShell: Bool { selectedAgentId == "shell" }
    private var agentBinding: Binding<String> {
        Binding(get: { selectedAgentId }, set: { node.agent = $0 })
    }

    /// 작업 노드는 «할 일»(프롬프트 / 셸 스크립트)이 있어야 완료할 수 있다. 시작/종료는 항상 완료 가능.
    private var promptMissing: Bool {
        isWork && node.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    private var isValid: Bool { !promptMissing }

    /// 검사 명령 미설정 — 통과 여부를 에이전트 «자기 판단» 에 의존하게 된다(약한 게이트). 진짜 «설정
    /// 필요» 경고라 warning(노랑). pro(주황)와 혼동 금지.
    private var checkMissing: Bool {
        isWork && node.checkCommand.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    @ViewBuilder
    private var triggerSection: some View {
        Section {
            if node.triggers.isEmpty {
                Text("수동 실행만 — 자동 트리거를 추가할 수 있어요.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(node.triggers.indices, id: \.self) { i in
                triggerRow(i)
            }
            .onDelete { node.triggers.remove(atOffsets: $0) }
            Button {
                node.triggers.append(WorkflowTriggerDef(kind: "cron", schedule: "0 9 * * *"))
            } label: {
                Label("크론 트리거 추가", systemImage: "plus.circle")
            }
            // 추가 메뉴에는 cron 만 노출한다 — GitHub 변경 감지 트리거는 의도적으로 제공하지 않는다.
        } header: {
            Text("트리거")
        } footer: {
            Text("수동 실행은 항상 가능해요. 크론 트리거를 추가하면 Mac 이 정해진 시각에 자동으로 시작해요.")
        }
    }

    @ViewBuilder
    private func triggerRow(_ i: Int) -> some View {
        if node.triggers[i].kind == "cron" {
            VStack(alignment: .leading, spacing: Theme.Spacing.s) {
                Text("크론 스케줄").font(.subheadline.weight(.medium))
                CronPresetBuilder(cron: bindCron(i))
            }
        } else {
            // 옛 GitHub 트리거(현재 비활성) — 데이터만 보존, 편집 UI 는 숨긴다.
            Text("GitHub 변경 감지 (준비 중)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func bindCron(_ i: Int) -> Binding<String> {
        Binding(
            get: { node.triggers[i].schedule ?? "0 9 * * *" },
            set: { node.triggers[i].schedule = $0 }
        )
    }

    @ViewBuilder
    private var checkSection: some View {
        Section {
            VoiceInputField("예: npm test · ./scripts/lint.sh · swift build", text: $node.checkCommand, lineLimit: 1...4)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .font(.system(.body, design: .monospaced))
                .accessibilityLabel(Text("검사 명령"))
        } header: {
            Text("검사 명령")
        } footer: {
            if checkMissing {
                Label {
                    Text("검사 미설정 — 통과 여부를 에이전트 자기 판단에 맡겨요. 검사 명령(종료 코드 0=통과)을 지정하면 더 믿을 수 있어요.")
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
                .foregroundStyle(Theme.warning)
                .accessibilityLabel(Text("검사 미설정 경고"))
            } else {
                Text("이 명령의 종료 코드로 통과/실패를 판정해요 (0=통과, 비0=실패). 실패하면 마지막 출력 몇 줄을 다음 반복에 «직전 실패 사유» 로 알려줘요.")
            }
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("기본") {
                    VoiceInputField("제목", text: $node.title)
                    LabeledContent("종류") { Text(editorTypeLabel(node.type)) }
                }
                if isWork {
                    // «도구» 선택 — 새 세션 시트와 동일하게 displayName 으로 노출 (raw id 노출 X).
                    Section {
                        Picker("도구", selection: agentBinding) {
                            ForEach(agents) { a in
                                Label(a.displayName, systemImage: AgentKind.from(id: a.id).systemImage).tag(a.id)
                            }
                        }
                    } header: {
                        Text("도구")
                    }
                    if isShell {
                        // 터미널은 명령 기반이 아니라 스크립트를 실행한다 — 프롬프트 대신 셸 스크립트.
                        Section {
                            VoiceInputField("실행할 셸 스크립트 또는 명령 (예: ./scripts/build.sh)", text: $node.prompt, lineLimit: 3...12)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                                .font(.system(.body, design: .monospaced))
                        } header: {
                            Text("셸 스크립트")
                        } footer: {
                            if promptMissing {
                                Label("필수 — 실행할 스크립트를 작성해야 완료할 수 있어요", systemImage: "exclamationmark.circle.fill")
                                    .foregroundStyle(Theme.warning)
                            } else {
                                Text("터미널 도구는 이 내용을 그대로 실행해요. 실행할 스크립트 파일 경로를 적거나 명령을 직접 작성하세요.")
                            }
                        }
                    } else {
                        Section {
                            VoiceInputField("프롬프트", text: $node.prompt, lineLimit: 3...10)
                        } header: {
                            Text("에이전트가 할 일")
                        } footer: {
                            if promptMissing {
                                Label("필수 — 작성해야 완료할 수 있어요", systemImage: "exclamationmark.circle.fill")
                                    .foregroundStyle(Theme.warning)
                            }
                        }
                        Section {
                            VoiceInputField("예: 변경 요약과 파일 목록을 표로 정리해 담아라", text: $node.resultSpec, lineLimit: 2...8)
                        } header: {
                            Text("결과물 처리")
                        } footer: {
                            Text("기본적으로 결과는 Task 폴더의 result.md 에 저장돼 다음 노드가 이어받아요. 여기에 어떤 내용을·어떤 형식으로 담을지 세부 지시를 적을 수 있어요.")
                        }
                        Section {
                            Toggle("도구 자동 승인", isOn: $node.skipPermissions)
                        }
                    }
                    Section {
                        Toggle("실행 전 승인 필요", isOn: $node.requiresApproval)
                    } footer: {
                        Text("켜면 이 노드는 실행 직전에 멈추고, 캔버스에서 승인해야 진행해요.")
                    }
                    checkSection
                }
                if node.type == "start" {
                    triggerSection
                }
                Section {
                    Button(role: .destructive) {
                        onDelete()
                        dismiss()
                    } label: {
                        Label("이 노드 삭제", systemImage: "trash")
                    }
                }
            }
            .navigationTitle(node.title.isEmpty ? editorTypeLabel(node.type) : node.title)
            .navigationBarTitleDisplayMode(.inline)
            .voiceDictationChrome()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("완료") { dismiss() }
                        .disabled(!isValid)
                }
            }
        }
    }
}

// MARK: - 편집기 표시 helpers (file-scope private)

/// 일하는 노드(에이전트 실행) 인가 — 통합 후엔 task. 옛 general/test 도 같게 취급(하위호환).
private func isWorkType(_ type: String) -> Bool {
    type == "task" || type == "general" || type == "test"
}

private func editorTypeColor(_ type: String) -> Color {
    // 노드 종류색 — 캔버스 카드 + 추가 메뉴 공통. Theme.Node 단일 정의를 따른다(Mac wfTypeColor 와 동기).
    switch type {
    case "start": return Theme.Node.start  // 초록
    case "end": return Theme.Node.end      // 파랑
    default: return Theme.Node.task        // 분홍 — task (및 옛 general/test)
    }
}

private func editorTypeIcon(_ type: String) -> String {
    switch type {
    case "start": return "play.circle.fill"
    case "end": return "flag.checkered"
    default: return "cpu"  // task
    }
}

private func editorTypeLabel(_ type: String) -> String {
    switch type {
    case "start": return String(localized: "시작")
    case "end": return String(localized: "종료")
    default: return String(localized: "작업")  // task (및 옛 general/test)
    }
}

// MARK: - 크론 프리셋 빌더

/// raw 5필드 cron 을 직접 타이핑하지 않고 빈도(매일/매주/매월) + 시각 + 요일/일 로 쉽게 세팅한다.
/// 선택을 cron 식으로 변환해 Binding 에 쓰고, 기존 식은 들어올 때 best-effort 로 파싱해 채운다.
private struct CronPresetBuilder: View {
    @Binding var cron: String
    @State private var freq: Freq = .daily
    @State private var time = CronPresetBuilder.dateAt(9, 0)
    @State private var weekdays: Set<Int> = [1, 2, 3, 4, 5]   // cron: 0=일 … 6=토
    @State private var dom = 1
    @State private var hourInterval = 1   // 매시간 모드: N 시간마다 (*/N)
    @State private var minuteOfHour = 0   // 매시간 모드: 매시 N분
    @State private var loaded = false

    enum Freq: Hashable { case hourly, daily, weekly, monthly }
    /// cron 요일 번호를 월~일 순으로 — 라벨은 OS 가 로케일별로 주는 약어를 쓴다(별도 번역 불필요).
    private static let wdOrder = [1, 2, 3, 4, 5, 6, 0]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.m) {
            Picker("빈도", selection: $freq) {
                Text("매시간").tag(Freq.hourly)
                Text("매일").tag(Freq.daily)
                Text("매주").tag(Freq.weekly)
                Text("매월").tag(Freq.monthly)
            }
            .pickerStyle(.segmented)

            if freq == .hourly {
                Stepper("\(hourInterval)시간마다", value: $hourInterval, in: 1...23)
                Stepper("매시 \(minuteOfHour)분", value: $minuteOfHour, in: 0...59)
            } else {
                DatePicker("시각", selection: $time, displayedComponents: .hourAndMinute)
            }

            if freq == .weekly {
                HStack(spacing: Theme.Spacing.xs) {
                    ForEach(Self.wdOrder, id: \.self) { num in
                        let on = weekdays.contains(num)
                        Text(verbatim: Self.weekdaySymbol(num))
                            .font(.caption.weight(.semibold))
                            .frame(width: 32, height: 32)
                            .background(on ? Theme.accent : Color.secondary.opacity(0.15), in: Circle())
                            .foregroundStyle(on ? Theme.onAccent : .primary)
                            .onTapGesture { if on { weekdays.remove(num) } else { weekdays.insert(num) } }
                    }
                }
            }
            if freq == .monthly {
                Stepper("매월 \(dom)일", value: $dom, in: 1...31)
            }

            Text(verbatim: cron)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
        }
        .onAppear { if !loaded { parse(); loaded = true } }
        .onChange(of: freq) { _ in regen() }
        .onChange(of: time) { _ in regen() }
        .onChange(of: weekdays) { _ in regen() }
        .onChange(of: dom) { _ in regen() }
        .onChange(of: hourInterval) { _ in regen() }
        .onChange(of: minuteOfHour) { _ in regen() }
    }

    private func hm() -> (Int, Int) {
        let c = Calendar.current.dateComponents([.hour, .minute], from: time)
        return (c.hour ?? 9, c.minute ?? 0)
    }

    private func regen() {
        let (h, m) = hm()
        switch freq {
        case .hourly: cron = "\(minuteOfHour) */\(hourInterval) * * *"
        case .daily: cron = "\(m) \(h) * * *"
        case .weekly:
            let days = weekdays.isEmpty ? "*" : weekdays.sorted().map(String.init).joined(separator: ",")
            cron = "\(m) \(h) * * \(days)"
        case .monthly: cron = "\(m) \(h) \(dom) * *"
        }
    }

    private func parse() {
        let f = cron.split(separator: " ").map(String.init)
        guard f.count == 5, let m = Int(f[0]) else { regen(); return }
        // 시 필드가 */N 또는 * 면 «매시간» 모드.
        if f[1].hasPrefix("*/") || f[1] == "*" {
            freq = .hourly
            hourInterval = max(1, min(23, Int(f[1].dropFirst(2)) ?? 1))
            minuteOfHour = max(0, min(59, m))
            regen(); return
        }
        guard let h = Int(f[1]) else { regen(); return }
        time = Self.dateAt(h, m)
        if f[2] != "*", let d = Int(f[2]) {
            freq = .monthly; dom = max(1, min(31, d))
        } else if f[4] != "*" {
            freq = .weekly
            let parsed = Set(f[4].split(separator: ",").compactMap { Int($0) })
            weekdays = parsed.isEmpty ? [1, 2, 3, 4, 5] : parsed
        } else {
            freq = .daily
        }
        regen()
    }

    private static func dateAt(_ h: Int, _ m: Int) -> Date {
        Calendar.current.date(bySettingHour: h, minute: m, second: 0, of: Date()) ?? Date()
    }

    /// cron 요일 번호(0=일 … 6=토) → 로케일 약어. shortWeekdaySymbols 는 [일,월,…,토] 순.
    private static func weekdaySymbol(_ cronNum: Int) -> String {
        let syms = Calendar.current.shortWeekdaySymbols
        return cronNum >= 0 && cronNum < syms.count ? syms[cronNum] : "\(cronNum)"
    }
}
