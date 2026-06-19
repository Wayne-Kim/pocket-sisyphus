import SwiftUI
import WebKit

/// 라이브 프리뷰 (preview_proxy_v1) — 폰에서 Mac 의 dev 서버(localhost:3000 류)를 본다.
///
/// ## 흐름
///  1. 사용자가 dev 포트를 입력 → `registerPreviewPort` 로 «세션별 명시 허용» (daemon 기본 차단).
///  2. 등록 응답의 `proxyPort` 로 `conn.openPreviewForward` — 채택된 SSH 세션 위에 forward 를
///     하나 더 연다(direct-tcpip 멀티플렉싱). 시뮬레이터는 호스트 loopback 직행.
///  3. `http://127.0.0.1:<로컬forward>/__psproxy__/<sid>/<port>` 진입 → daemon 프록시가 쿠키를
///     심고 dev 서버 root 로 redirect → WKWebView 가 root-relative 자산까지 정상 렌더.
///
/// WKWebView 의 핀치 줌/스크롤로 ZoomableScreenView 와 유사한 확대 탐색을 제공한다(웹 콘텐츠라
/// viewport meta 를 주입해 user-scalable 강제). 외부 서버 0 — 모든 트래픽은 기존 SSH/Tor 채널.
struct PreviewView: View {
    let sessionId: String
    let api: ApiClient
    @ObservedObject var conn: ConnectionManager
    /// daemon 프록시가 프리뷰 v2(절대 URL 리라이트 + 다중 dev 포트 라우팅)를 지원하는가. true 면
    /// «보조 포트 등록» 안내를 노출한다. false(옛 daemon)면 기존 단일 포트 UX 그대로 — 회귀 없음.
    var supportsMultiPort: Bool = false
    /// 화면 피드백 완성 콜백 — 캡처+마크업+코멘트를 «전송 대기 파일 참조»(fileRefs)로 올린다.
    /// ChatView 가 주입; 호출되면 이 시트(프리뷰)도 닫혀 채팅의 대기 첨부가 보인다.
    var onFeedback: ((FileReferenceDraft) -> Void)? = nil
    /// 외부 공유시트에 동봉할 세션 요약 카피 (제품명·App Store 링크 포함). ChatView 가 만들어 주입.
    /// 프리뷰 스크린샷과 함께 한 번에 내보낸다 (성장 레버 — 만든 결과를 외부 채널로 자랑).
    var shareCopy: String = ""
    @Environment(\.dismiss) private var dismiss

    @State private var portText: String = ""
    @State private var registeredPorts: [ApiClient.PreviewPortEntry] = []
    /// 이 세션이 띄운 dev 서버 후보 (감지). 0건이면 섹션 숨김 → 수동 입력 폴백.
    @State private var detectedPorts: [ApiClient.PreviewDetectedPort] = []
    @State private var proxyPort: Int?
    /// 현재 렌더 중인 진입 URL. nil 이면 포트 입력 화면.
    @State private var entryURL: URL?
    @State private var activePort: Int?
    @State private var isLoadingWeb = false
    @State private var loadError: String?
    @State private var actionError: String?
    @State private var isBusy = false
    /// 포트별 dev 서버 가동 여부 (probe 결과). UI 의 «실행 중/꺼짐» 배지.
    @State private var probe: [Int: Bool] = [:]
    /// WKWebView 강제 reload 토큰.
    @State private var reloadToken = 0
    /// 가시 영역 캡처(takeSnapshot)를 위해 WKWebView 를 약하게 들고 있는 핸들.
    @State private var webRef = PreviewWebRef()
    /// 캡처된 스냅샷 → «화면 피드백» 시트로 넘긴다.
    @State private var feedbackImage: UIImage?
    @State private var showFeedback = false
    /// 외부 공유시트로 넘길 묶음 (스냅샷 + 요약 카피). non-nil 이면 시스템 공유시트가 뜬다.
    @State private var sharePayload: SessionSharePayload?
    /// 피드백 시트에서 완성된 참조 — 시트가 «완전히» 닫힌 뒤(onDismiss) onFeedback 으로 올리고
    /// 프리뷰도 닫는다 (모달 전환 충돌 회피).
    @State private var pendingFeedback: FileReferenceDraft?

    var body: some View {
        NavigationStack {
            Group {
                if let url = entryURL {
                    webContainer(url: url)
                } else {
                    portPicker
                }
            }
            .navigationTitle("프리뷰")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("닫기") { dismiss() }
                        .tint(Color.primary)   // 해제 버튼은 중립색 (색 정책).
                }
                if entryURL != nil {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        // 외부 공유 — 지금 보이는 프리뷰를 캡처해 세션 요약 카피와 함께 시스템
                        // 공유시트로 내보낸다. 외부 앱(X·Reddit·Discord·메신저) 은 사용자가 고른다.
                        Button {
                            captureForShare()
                        } label: {
                            Label("공유", systemImage: "square.and.arrow.up")
                        }
                        Button {
                            captureFeedback()
                        } label: {
                            Label("피드백", systemImage: "pencil.tip.crop.circle")
                        }
                        Button {
                            backToPicker()
                        } label: {
                            Label("포트 변경", systemImage: "number")
                        }
                        Button {
                            reloadToken += 1
                            loadError = nil
                        } label: {
                            Label("새로고침", systemImage: "arrow.clockwise")
                        }
                    }
                }
            }
            // 화면 피드백 시트 — 캡처 위에 마크업+코멘트. 완성본은 onDismiss 에서 fileRefs 로 올린다.
            .sheet(isPresented: $showFeedback, onDismiss: {
                if let draft = pendingFeedback {
                    pendingFeedback = nil
                    onFeedback?(draft)
                    dismiss()   // 채팅으로 복귀 — 대기 첨부 칩이 보인다.
                }
            }) {
                if let img = feedbackImage {
                    PreviewFeedbackSheet(
                        snapshot: img,
                        sessionId: sessionId,
                        api: api,
                        target: .preview(
                            url: previewURLString,
                            resolveElement: { point in await resolveElement(at: point) },
                        ),
                        onComplete: { draft in pendingFeedback = draft },
                    )
                }
            }
            // 외부 공유시트 — 캡처된 스냅샷 + 세션 요약 카피를 사용자가 고른 외부 앱으로 내보낸다.
            .sheet(item: $sharePayload) { payload in
                ActivityShareSheet(items: [payload.text, payload.image])
            }
        }
        .task {
            await loadPorts()
            await loadDetected()
        }
    }

    // MARK: - 포트 입력 화면

    private var portPicker: some View {
        Form {
            Section {
                Text("Mac 에서 실행 중인 dev 서버의 포트를 등록하면, 폰에서 바로 미리볼 수 있어요. 등록한 포트만 열리고 그 외에는 모두 차단됩니다.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if supportsMultiPort {
                    Text("앱 포트와 별도 API·HMR 포트를 함께 등록할 수 있어요. 프리뷰를 열면 등록한 포트가 모두 함께 동작하고, 절대 URL 자산도 자동으로 연결돼요.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            if !detectedPorts.isEmpty {
                Section {
                    ForEach(detectedPorts) { cand in
                        detectedRow(cand)
                    }
                } header: {
                    Text("감지된 포트")
                } footer: {
                    Text("이 세션이 띄운 dev 서버예요. 탭하면 등록하고 바로 열어요.")
                }
            }

            Section("포트 등록") {
                HStack {
                    TextField("포트 번호 (예: 3000)", text: $portText)
                        .keyboardType(.numberPad)
                        .textFieldStyle(.plain)
                    Button {
                        if let port = parsedPort { Task { await registerAndOpen(port: port) } }
                    } label: {
                        if isBusy {
                            ProgressView()
                        } else {
                            Text("열기")
                        }
                    }
                    .disabled(isBusy || parsedPort == nil)
                }
                if let actionError {
                    Text(actionError)
                        .font(.footnote)
                        .foregroundStyle(Theme.danger)
                }
            }

            if !registeredPorts.isEmpty {
                Section {
                    ForEach(registeredPorts) { entry in
                        Button {
                            Task { await open(port: entry.port) }
                        } label: {
                            HStack {
                                Label("\(entry.port)", systemImage: "globe")
                                    .foregroundStyle(Color.primary)
                                Spacer()
                                probeBadge(for: entry.port)
                            }
                        }
                        .swipeActions {
                            Button(role: .destructive) {
                                Task { await unregister(port: entry.port) }
                            } label: {
                                Label("삭제", systemImage: "trash")
                            }
                        }
                    }
                } header: {
                    Text("등록된 포트")
                } footer: {
                    if supportsMultiPort && registeredPorts.count > 1 {
                        Text("탭해서 연 포트가 주 포트예요. 나머지 등록 포트는 보조로 함께 동작해요.")
                    }
                }
            }
        }
        .refreshable {
            await loadPorts()
            await loadDetected()
        }
    }

    /// 감지된 후보 한 행 — 탭하면 기존 등록 경로(register → forward → open) 그대로.
    @ViewBuilder
    private func detectedRow(_ cand: ApiClient.PreviewDetectedPort) -> some View {
        let isRegistered = registeredPorts.contains { $0.port == cand.port }
        Button {
            Task { await registerAndOpen(port: cand.port) }
        } label: {
            HStack {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(cand.port)")
                            .foregroundStyle(Color.primary)
                        if let cmd = cand.command, !cmd.isEmpty {
                            Text(verbatim: cmd)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                } icon: {
                    Image(systemName: "antenna.radiowaves.left.and.right")
                }
                Spacer()
                if isRegistered {
                    Text("등록됨")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .disabled(isBusy)
    }

    @ViewBuilder
    private func probeBadge(for port: Int) -> some View {
        if let up = probe[port] {
            (up ? Text("실행 중") : Text("꺼짐"))
                .font(.caption2)
                .foregroundStyle(up ? Theme.success : .secondary)
        } else {
            EmptyView()
        }
    }

    // MARK: - 웹 렌더 화면

    private func webContainer(url: URL) -> some View {
        ZStack {
            PreviewWebView(
                url: url,
                reloadToken: reloadToken,
                webRef: webRef,
                isLoading: $isLoadingWeb,
                loadError: $loadError,
            )
            .ignoresSafeArea(edges: .bottom)

            if isLoadingWeb {
                ProgressView()
            }
            if let loadError {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.largeTitle)
                        .foregroundStyle(Theme.warning)
                    Text("불러올 수 없어요")
                        .font(.headline)
                    Text(loadError)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("다시 시도") {
                        self.loadError = nil
                        reloadToken += 1
                    }
                    .buttonStyle(.borderedProminent)
                }
                .padding(32)
                .background(.background)
            }
            // 캡처 실패 등 액션 오류 토스트 — 하단에 잠깐 떠올라 자동 사라진다.
            if let actionError {
                VStack {
                    Spacer()
                    Text(actionError)
                        .font(.footnote)
                        .foregroundStyle(.primary)   // 자동 적응 (색 정책: .white/.black 금지).
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(.regularMaterial, in: Capsule())
                        .padding(.bottom, 24)
                }
                .transition(.opacity)
                .task {
                    try? await Task.sleep(nanoseconds: 2_500_000_000)
                    self.actionError = nil
                }
            }
        }
    }

    // MARK: - 동작

    /// 프롬프트 컨텍스트에 실을 «프리뷰 진입경로» — 에이전트가 Mac 에서 그대로 열어볼 수 있도록
    /// 로컬 forward 포트가 아니라 dev 서버 포트로 표기. 포트 미상이면 진입 URL 그대로.
    private var previewURLString: String {
        if let p = activePort { return "http://localhost:\(p)" }
        return entryURL?.absoluteString ?? ""
    }

    /// 현재 WKWebView 의 가시 영역을 이미지로 캡처해 «화면 피드백» 시트를 띄운다.
    /// afterScreenUpdates=false → 현재 프레임 그대로 (로딩 중/빈 화면도 단서로 캡처). 실패 시 토스트.
    private func captureFeedback() {
        guard let web = webRef.web else {
            actionError = String(localized: "화면을 캡처할 수 없어요")
            return
        }
        let config = WKSnapshotConfiguration()
        config.afterScreenUpdates = false
        web.takeSnapshot(with: config) { image, error in
            if let image {
                feedbackImage = image
                showFeedback = true
            } else {
                actionError = error?.localizedDescription
                    ?? String(localized: "화면을 캡처할 수 없어요")
            }
        }
    }

    /// 현재 프리뷰의 가시 영역을 캡처해, 세션 요약 카피와 함께 시스템 공유시트로 내보낸다.
    /// 캡처 패턴은 captureFeedback 과 동일(afterScreenUpdates=false → 현재 프레임 그대로).
    private func captureForShare() {
        guard let web = webRef.web else {
            actionError = String(localized: "화면을 캡처할 수 없어요")
            return
        }
        let config = WKSnapshotConfiguration()
        config.afterScreenUpdates = false
        web.takeSnapshot(with: config) { image, error in
            if let image {
                sharePayload = SessionSharePayload(text: shareCopy, image: image)
            } else {
                actionError = error?.localizedDescription
                    ?? String(localized: "화면을 캡처할 수 없어요")
            }
        }
    }

    /// 마크업이 가리킨 «웹뷰 포인트» 좌표의 DOM 요소를 식별해 한 줄 설명으로 돌려준다.
    /// 살아있는 WKWebView(시트가 위에 떠 있어 스크롤/줌이 동결됨)에서 elementFromPoint 를 실행한다.
    /// - 핀치 줌(scrollView.zoomScale)만큼 나눠 «뷰 포인트 → 뷰포트 CSS px» 로 환산한다.
    ///   (콘텐츠 스크롤 오프셋은 elementFromPoint 가 뷰포트 기준이라 상쇄돼 별도 보정 불필요.)
    /// - 실패(웹뷰 해제·JS 오류·요소 없음)하면 nil → 피드백은 요소 정보 없이 그대로 전송된다.
    @MainActor
    private func resolveElement(at webPoint: CGPoint) async -> String? {
        guard let web = webRef.web else { return nil }
        let zoom = web.scrollView.zoomScale
        let cx = webPoint.x / max(zoom, 0.0001)
        let cy = webPoint.y / max(zoom, 0.0001)
        let js = Self.elementProbeJS(x: cx, y: cy)
        let result = try? await web.evaluateJavaScript(js)
        guard let json = result as? String, let data = json.data(using: .utf8),
              let info = try? JSONDecoder().decode(PreviewElementInfo.self, from: data)
        else { return nil }
        return info.formatted
    }

    /// (x, y) 뷰포트 CSS px 위치의 요소를 elementFromPoint 로 집어 식별 정보를 JSON 문자열로 반환.
    /// 안정적 selector(최대 5단계, id 있으면 거기서 끊음), 태그/클래스/텍스트/role/aria/testid/rect.
    private static func elementProbeJS(x: CGFloat, y: CGFloat) -> String {
        let ix = Int(x.rounded())
        let iy = Int(y.rounded())
        return """
        (function(){
          function esc(s){ try { return (window.CSS && CSS.escape) ? CSS.escape(s) : s; } catch(e){ return s; } }
          function cssPath(el){
            if(!el || el.nodeType!==1) return '';
            var parts=[];
            while(el && el.nodeType===1 && parts.length<5){
              if(el.id){ parts.unshift('#'+esc(el.id)); break; }
              var sel=el.nodeName.toLowerCase();
              var cn=(typeof el.className==='string')?el.className.trim():'';
              if(cn){ sel += cn.split(/\\s+/).slice(0,2).map(function(c){return '.'+esc(c);}).join(''); }
              var p=el.parentNode;
              if(p && p.nodeType===1){
                var same=Array.prototype.filter.call(p.children,function(c){return c.nodeName===el.nodeName;});
                if(same.length>1){ sel += ':nth-of-type('+(Array.prototype.indexOf.call(same,el)+1)+')'; }
              }
              parts.unshift(sel);
              el=p;
            }
            return parts.join(' > ');
          }
          var el=document.elementFromPoint(\(ix),\(iy));
          if(!el) return null;
          var r=el.getBoundingClientRect();
          var txt=(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80);
          var cn=(typeof el.className==='string')?el.className.trim():'';
          return JSON.stringify({
            tag: el.nodeName.toLowerCase(),
            id: el.id||null,
            cls: cn||null,
            selector: cssPath(el),
            text: txt||null,
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            testid: el.getAttribute('data-testid'),
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
          });
        })();
        """
    }

    private var parsedPort: Int? {
        guard let p = Int(portText.trimmingCharacters(in: .whitespaces)), p >= 1024, p <= 65535 else {
            return nil
        }
        return p
    }

    private func loadPorts() async {
        do {
            let resp = try await api.previewPorts(sessionId: sessionId)
            registeredPorts = resp.ports
            proxyPort = resp.proxyPort
            await refreshProbes()
        } catch {
            // 목록 조회 실패는 치명적 아님 — 등록 화면은 그대로 쓸 수 있다.
            actionError = error.localizedDescription
        }
    }

    private func refreshProbes() async {
        for entry in registeredPorts {
            if let up = try? await api.probePreviewPort(entry.port) {
                probe[entry.port] = up
            }
        }
    }

    /// 감지 조회 실패(lsof 부재/권한 거부 등)는 치명적 아님 — 빈 목록이면 섹션이 숨고
    /// 수동 입력만 남는다(폴백).
    private func loadDetected() async {
        if let cands = try? await api.detectPreviewPorts(sessionId: sessionId) {
            detectedPorts = cands
        }
    }

    private func registerAndOpen(port: Int) async {
        actionError = nil
        isBusy = true
        defer { isBusy = false }
        do {
            let resp = try await api.registerPreviewPort(sessionId: sessionId, port: port)
            registeredPorts = resp.ports
            if let pp = resp.proxyPort { proxyPort = pp }
            portText = ""
            await open(port: port)
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func open(port: Int) async {
        actionError = nil
        loadError = nil
        // 프록시 포트 확보 — 목록/등록 응답에서 받은 값. 없으면 한 번 더 조회.
        if proxyPort == nil {
            await loadPorts()
        }
        guard let pp = proxyPort, pp > 0 else {
            actionError = String(localized: "프리뷰를 사용할 수 없어요 (daemon 미지원)")
            return
        }
        guard let forwardPort = conn.openPreviewForward(toProxyPort: UInt16(pp)) else {
            actionError = String(localized: "Mac 에 연결되어 있지 않아요")
            return
        }
        guard let url = URL(string: "http://127.0.0.1:\(forwardPort)/__psproxy__/\(sessionId)/\(port)") else {
            actionError = String(localized: "프리뷰 주소를 만들 수 없어요")
            return
        }
        activePort = port
        entryURL = url
    }

    private func backToPicker() {
        entryURL = nil
        activePort = nil
        loadError = nil
        Task { await refreshProbes() }
    }

    private func unregister(port: Int) async {
        do {
            let resp = try await api.unregisterPreviewPort(sessionId: sessionId, port: port)
            registeredPorts = resp.ports
            probe[port] = nil
        } catch {
            actionError = error.localizedDescription
        }
    }
}

/// elementFromPoint 로 집어낸 «가리킨 요소» 의 식별 정보 — JS 가 만든 JSON 을 그대로 디코드한다.
/// `formatted` 가 selector·텍스트·속성·rect 를 비번역 기술 토큰 한 줄로 합쳐 프롬프트에 싣는다
/// (코드 리뷰의 `path:L10-L40` 처럼 «정확한 좌표» 역할).
struct PreviewElementInfo: Decodable {
    var tag: String?
    var id: String?
    var cls: String?
    var selector: String?
    var text: String?
    var role: String?
    var ariaLabel: String?
    var testid: String?
    var rect: Rect?

    struct Rect: Decodable {
        var x: Int
        var y: Int
        var w: Int
        var h: Int
    }

    /// 예: `button.cta#submit “제출” [aria-label=보내기] @120,340 88×44`
    var formatted: String {
        var bits: [String] = []
        if let s = selector, !s.isEmpty {
            bits.append(s)
        } else if let t = tag, !t.isEmpty {
            bits.append(t)
        }
        if let t = text, !t.isEmpty { bits.append("“\(t)”") }
        var attrs: [String] = []
        if let a = ariaLabel, !a.isEmpty { attrs.append("aria-label=\(a)") }
        if let r = role, !r.isEmpty { attrs.append("role=\(r)") }
        if let d = testid, !d.isEmpty { attrs.append("data-testid=\(d)") }
        if !attrs.isEmpty { bits.append("[" + attrs.joined(separator: ", ") + "]") }
        if let r = rect { bits.append("@\(r.x),\(r.y) \(r.w)×\(r.h)") }
        return bits.isEmpty ? (tag ?? "element") : bits.joined(separator: " ")
    }
}

/// WKWebView 래퍼 — dev 서버 페이지를 핀치 줌/스크롤 가능하게 렌더. 콘텐츠 격리를 위해 비영속
/// 데이터 스토어를 써 프리뷰 쿠키(ps_preview)가 앱 API/다른 프리뷰와 섞이지 않게 한다.
/// WKWebView 를 약하게 들고 있는 핸들 — takeSnapshot 호출부(PreviewView)가 참조를 잡기 위함.
final class PreviewWebRef {
    weak var web: WKWebView?
}

private struct PreviewWebView: UIViewRepresentable {
    let url: URL
    let reloadToken: Int
    let webRef: PreviewWebRef
    @Binding var isLoading: Bool
    @Binding var loadError: String?

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // 프리뷰마다 쿠키/스토리지 격리 — 라우팅 쿠키가 다른 컨텍스트로 새지 않게.
        config.websiteDataStore = .nonPersistent()
        // viewport user-scalable 을 강제해 핀치 줌 허용 (dev 페이지가 막아둔 경우 대비).
        let viewportJS = """
        var m = document.querySelector('meta[name=viewport]');
        if (!m) { m = document.createElement('meta'); m.name = 'viewport'; document.head.appendChild(m); }
        m.content = 'width=device-width, initial-scale=1, minimum-scale=0.25, maximum-scale=10, user-scalable=yes';
        """
        let script = WKUserScript(source: viewportJS, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        config.userContentController.addUserScript(script)

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        web.scrollView.maximumZoomScale = 10
        web.scrollView.minimumZoomScale = 0.25
        context.coordinator.web = web
        webRef.web = web   // 캡처용 핸들 — PreviewView 가 takeSnapshot 호출 시 사용.
        web.load(URLRequest(url: url))
        context.coordinator.lastReloadToken = reloadToken
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        if context.coordinator.lastReloadToken != reloadToken {
            context.coordinator.lastReloadToken = reloadToken
            // 진입 URL 로 다시 로드 (쿠키 재설정 포함) — 단순 reload 보다 견고.
            web.load(URLRequest(url: url))
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        let parent: PreviewWebView
        weak var web: WKWebView?
        var lastReloadToken = 0

        init(_ parent: PreviewWebView) { self.parent = parent }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            parent.isLoading = true
            parent.loadError = nil
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.isLoading = false
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            parent.isLoading = false
            parent.loadError = error.localizedDescription
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            parent.isLoading = false
            parent.loadError = error.localizedDescription
        }
    }
}
