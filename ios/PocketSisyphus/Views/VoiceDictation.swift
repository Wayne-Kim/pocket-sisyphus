import SwiftUI

/// 재사용 가능한 음성 받아쓰기(온디바이스 Whisper) UI. ChatView 의 마이크 버튼 + 받아쓰기 삽입
/// 로직을 추출해, 「긴 자연어를 폰 키보드로 치는」 마찰이 있는 다른 입력란(예약 작업 명령·PO 수집
/// 지시·브리프 수정 코멘트)에도 붙인다. 인식기는 앱 전역 공유 싱글턴
/// (`WhisperSpeechRecognizer.shared`)이라, 한 번 `.ready` 가 되면 어디서 처음 누르든
/// 다운로드/준비 배너 없이 즉시 녹음한다(모델 로드는 «한 번이면 충분»).
///
/// 구성 (두 조각을 함께 붙인다):
///  - `DictationMicButton(text:)` — 입력란 «옆» 에 두는 인라인 마이크 버튼. 누르고 있는 동안
///    녹음, 떼면 인식 텍스트를 바인딩에 «삽입» 한다(자동 전송/저장 금지 — 검토 후 사용자가 보냄).
///  - `.voiceDictationChrome()` — 화면(컨테이너)에 한 번 붙이는 공통 크롬: 녹음 HUD·준비/다운로드
///    배너·준비 완료 토스트·오류 alert·모델 선로드. ChatView 와 동일한 UX·문자열을 그대로 쓴다.

// MARK: - DictationMicButton

/// 인라인 마이크 버튼 — ChatView 의 micKeyButton 과 동일한 «누르고 말하기» 동작. 누르는 순간
/// 녹음을 시작(모델 미준비면 첫 누름이 다운로드/로드만 시작)하고, 떼는 순간 인식 결과를
/// `text` 바인딩의 현재 내용에 이어 붙인다. 표시(스피너·펄스)는 `MicPushToTalkButton` 이 맡는다.
struct DictationMicButton: View {
    @ObservedObject private var speech = WhisperSpeechRecognizer.shared
    @Binding var text: String
    /// 받아쓰기 삽입 후 포커스를 줄 입력란(있으면). 없으면 포커스를 건드리지 않는다 — Form 행처럼
    /// 자동으로 키보드를 띄우고 싶지 않은 자리에서 nil 로 둔다.
    private var focus: FocusState<Bool>.Binding?

    init(text: Binding<String>, focus: FocusState<Bool>.Binding? = nil) {
        _text = text
        self.focus = focus
    }

    var body: some View {
        MicPushToTalkButton(
            isRecording: speech.isRecording,
            isBusy: speech.modelState == .preparing || speech.isTranscribing,
        ) { pressing in
            if pressing {
                Task { await speech.startRecording() }
            } else {
                Task {
                    await speech.stopRecording()
                    insert(speech.transcript)
                }
            }
        }
    }

    /// 인식된 텍스트를 입력 필드에 삽입한다(ChatView.insertTranscript 와 동일 규칙). 작성 중 텍스트가
    /// 있으면 공백으로 이어 붙여 키보드 + 음성을 한 입력에 섞을 수 있게 한다. 이미 공백/줄바꿈으로
    /// 끝나면 그대로 붙여(멀티라인 필드에서 줄바꿈 직후 삽입이 자연스럽게). 자동 전송/저장하지 않는다.
    private func insert(_ raw: String) {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        if text.isEmpty {
            text = t
        } else if text.hasSuffix(" ") || text.hasSuffix("\n") {
            text += t
        } else {
            text += " " + t
        }
        focus?.wrappedValue = true
    }
}

// MARK: - VoiceInputField

/// 입력란 + «우측 마이크(받아쓰기)» 공통 컴포넌트. 「긴 자연어를 폰 키보드로 치는」 마찰이 큰
/// 입력란(예약 명령·PO 수집 지시·브리프 코멘트·새 세션 첫 프롬프트 등)에 한 줄로 끼워 쓴다.
/// 예약 만들기 화면 «명령» 필드의 `HStack { TextField; DictationMicButton }` 레이아웃을 추출해
/// 한 줄/여러 줄을 한 컴포넌트로 통일했다.
///
/// 레이아웃:
///  - `lineLimit == nil` → 한 줄(TextField). 마이크는 가운데 정렬.
///  - `lineLimit = a...b` → 여러 줄(axis: .vertical + lineLimit). 마이크는 «아래» 정렬이라
///    줄이 늘어도 마지막 줄 옆에 붙는다.
///
/// 전제: 이 필드를 «담은 화면(컨테이너)» 에 `.voiceDictationChrome()` 를 «한 번» 붙여야
/// 녹음 HUD·준비 배너·오류 alert·모델 선로드가 동작한다(받아쓰기 UX 는 화면 단위 공통 크롬).
struct VoiceInputField: View {
    @Binding var text: String
    /// placeholder 는 LocalizedStringKey — 호출부의 string literal 이 카탈로그로 자동 추출된다.
    let placeholder: LocalizedStringKey
    /// 여러 줄이면 줄 범위(예: `2...6`). nil 이면 한 줄.
    var lineLimit: ClosedRange<Int>?
    /// 받아쓰기 삽입 후 포커스를 줄 입력란 바인딩(있으면). 제공 시 TextField 에도 `.focused` 적용.
    var focus: FocusState<Bool>.Binding?

    init(_ placeholder: LocalizedStringKey,
         text: Binding<String>,
         lineLimit: ClosedRange<Int>? = nil,
         focus: FocusState<Bool>.Binding? = nil) {
        self.placeholder = placeholder
        _text = text
        self.lineLimit = lineLimit
        self.focus = focus
    }

    var body: some View {
        HStack(alignment: lineLimit == nil ? .center : .bottom, spacing: 8) {
            field
            DictationMicButton(text: $text, focus: focus)
        }
    }

    @ViewBuilder
    private var field: some View {
        if let range = lineLimit {
            applyFocus(TextField(placeholder, text: $text, axis: .vertical).lineLimit(range))
        } else {
            applyFocus(TextField(placeholder, text: $text))
        }
    }

    /// focus 바인딩이 있으면 `.focused` 를 적용, 없으면 그대로(Optional FocusState 처리).
    @ViewBuilder
    private func applyFocus(_ v: some View) -> some View {
        if let focus {
            v.focused(focus)
        } else {
            v
        }
    }
}

// MARK: - VoiceDictationChrome

/// 음성 받아쓰기 공통 크롬 — 마이크 버튼을 붙인 화면(컨테이너)에 «한 번» 붙인다. ChatView 의
/// recordingHUD·speechStatusBanner·오류 alert·준비 토스트·모델 선로드를 그대로 옮겨, 어느 화면에서
/// 녹음하든 동일한 피드백을 준다. HUD/배너/토스트는 화면 위쪽에 떠 입력란을 가리지 않고
/// (`allowsHitTesting(false)`) 누름 제스처는 마이크 버튼이 받는다.
struct VoiceDictationChrome: ViewModifier {
    @ObservedObject private var speech = WhisperSpeechRecognizer.shared
    @State private var showReadyToast = false

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                floatingStatus
                    .animation(.easeInOut(duration: 0.2), value: speech.isRecording)
                    .animation(.easeInOut(duration: 0.2), value: speech.modelState)
            }
            // 음성 입력(STT) 권한 거부·모델 다운로드/인식 실패 안내 — ChatView 와 동일 경로.
            .alert(
                "음성 입력",
                isPresented: Binding(get: { speech.lastError != nil }, set: { if !$0 { speech.lastError = nil } }),
            ) {
                Button("확인", role: .cancel) { speech.lastError = nil }
            } message: {
                Text(verbatim: speech.lastError ?? "")
            }
            // 음성 모델이 준비되면 «사용 가능» 토스트를 잠깐 띄웠다 자동으로 거둔다.
            .onChange(of: speech.modelState) { newState in
                guard newState == .ready else { return }
                withAnimation { showReadyToast = true }
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                    withAnimation { showReadyToast = false }
                }
            }
            // 이미 받아둔 모델이면 미리 로드 — 마이크를 누르면 다운로드/준비 없이 바로 녹음(다운로드는
            // 첫 누름에서만). 싱글턴이라 다른 화면에서 이미 .ready 면 즉시 no-op.
            .onAppear {
                Task { await speech.preloadIfDownloaded() }
            }
    }

    /// 상태에 따라 화면 위쪽에 띄울 떠 있는 안내 — 녹음 중 HUD > 준비/다운로드 배너 > 준비 토스트.
    @ViewBuilder
    private var floatingStatus: some View {
        if speech.isRecording {
            recordingHUD
        } else if speech.modelState == .preparing {
            preparingBanner
        } else if showReadyToast {
            readyToast
        }
    }

    /// 녹음 중 큰 플로팅 HUD — ChatView 와 동일하게 «녹음 중 / 손을 떼면 입력돼요» 를 분명히 보인다.
    private var recordingHUD: some View {
        HStack(spacing: 12) {
            Image(systemName: "mic.fill")
                .font(.title2.weight(.bold))
                .foregroundStyle(Theme.onAccent)
                .symbolEffect(.pulse, options: .repeating)
                .frame(width: 44, height: 44)
                .background(Theme.accent, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text("녹음 중")
                    .font(.headline)
                Text("손을 떼면 입력돼요")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().stroke(Theme.accent.opacity(0.5), lineWidth: 1))
        .shadow(color: .black.opacity(0.18), radius: 10, y: 3)
        .padding(.top, 12)
        .transition(.move(edge: .top).combined(with: .opacity))
        // 손가락 제스처는 마이크 버튼이 받아야 한다 — HUD 는 터치를 통과시킨다.
        .allowsHitTesting(false)
    }

    /// 모델 준비(다운로드/로드) 배너 — accent(보라)로 «진행» 을 알린다(경고 아님). 다운로드 단계엔
    /// 진행률(%) + 막대, 로드 단계엔 인디터미닛. 문자열은 ChatView speechStatusBanner 와 동일 키.
    private var preparingBanner: some View {
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
        }
        .foregroundStyle(Theme.accent)
        .tint(Theme.accent)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().stroke(Theme.accent.opacity(0.4), lineWidth: 1))
        .shadow(color: .black.opacity(0.15), radius: 8, y: 2)
        .padding(.top, 12)
        .transition(.move(edge: .top).combined(with: .opacity))
        .allowsHitTesting(false)
    }

    /// 준비 완료 토스트 — 모델이 .ready 가 된 순간 잠깐 떴다 사라진다.
    private var readyToast: some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark.circle.fill")
                .font(.caption.weight(.semibold))
            Text("음성 입력을 사용할 수 있어요")
                .font(.caption)
        }
        .foregroundStyle(Theme.accent)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().stroke(Theme.accent.opacity(0.4), lineWidth: 1))
        .shadow(color: .black.opacity(0.15), radius: 8, y: 2)
        .padding(.top, 12)
        .transition(.opacity)
        .allowsHitTesting(false)
    }
}

extension View {
    /// 마이크 버튼(`DictationMicButton`)을 붙인 화면에 음성 받아쓰기 공통 크롬(HUD·배너·토스트·오류
    /// alert·모델 선로드)을 더한다. 화면당 한 번만 붙인다.
    func voiceDictationChrome() -> some View {
        modifier(VoiceDictationChrome())
    }
}
