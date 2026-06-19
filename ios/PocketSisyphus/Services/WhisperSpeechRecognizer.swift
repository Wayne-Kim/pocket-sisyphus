import Foundation
import WhisperKit

/// 온디바이스 음성→텍스트(STT). OpenAI Whisper 를 CoreML(WhisperKit)로 돌린다.
///
/// 왜 SFSpeechRecognizer 가 아니라 Whisper 인가: iOS 내장 «온디바이스» 음성 모델
/// (`requiresOnDeviceRecognition`)은 대형 LM 문맥 보정이 없어 발음이 조금만 흐려도 엉뚱한
/// 단어로 떨어졌다(특히 한국어/CJK). Whisper 는 문맥을 이해해 사람이 알아듣듯 보정한다.
///
/// 프라이버시: 인식 자체는 100% 온디바이스 — 음성이 기기를 떠나지 않는다(외부 STT SaaS 0
/// 원칙 유지). 모델 «가중치 파일» 만 첫 사용 시 HuggingFace 에서 1회 다운로드해 캐시한다
/// (사용자 음성/데이터가 아니라 공개 가중치). 이후엔 완전 오프라인.
///
/// 사용 흐름(푸시-투-토크): 버튼을 누르면 `startRecording()` — 모델이 아직 준비 안 됐으면
/// 그 누름으로 다운로드/로드를 시작하고(녹음은 안 함), 준비된 뒤의 누름부터 녹음한다. 떼면
/// `stopRecording()` 이 녹음된 오디오를 한 번에 transcribe 해 `transcript` 에 담는다 — 짧은
/// 클립을 통째로 인식해 문맥 정확도가 높다. 호출부(ChatView)가 그 텍스트를 입력 필드에 «삽입»
/// 한다(자동 전송 금지 — 검토 후 전송).
@MainActor
final class WhisperSpeechRecognizer: ObservableObject {
    /// 모델 준비 상태 — 버튼의 모양/동작을 결정한다.
    enum ModelState: Equatable {
        case idle        // 아직 로드 시도 안 함 — 첫 누름이 prepare 를 시작.
        case preparing   // 다운로드/로드 진행 중(인디터미닛).
        case ready       // 인식 준비됨.
        case failed      // 다운로드/로드 실패.
    }

    @Published private(set) var modelState: ModelState = .idle
    /// 모델 가중치 다운로드 진행률(0…1). `.preparing` 중 다운로드 단계에서만 의미. 캐시되어 있으면
    /// 즉시 1 에 도달하고 곧 `.ready` 로 넘어간다.
    @Published private(set) var downloadProgress: Double = 0
    /// 다운로드가 끝나고 모델을 «로드» 하는 단계인가 — 진행률 대신 인디터미닛으로 표시하기 위함.
    @Published private(set) var isLoadingModel: Bool = false
    /// 지금 마이크로 녹음 중인가 — 버튼 활성(mic.fill + accent) 표시.
    @Published private(set) var isRecording: Bool = false
    /// 녹음을 떼고 Whisper 가 텍스트로 변환하는 중인가 — 버튼에 스피너.
    @Published private(set) var isTranscribing: Bool = false
    /// 마지막 인식 결과(stopRecording 후 채워진다).
    @Published private(set) var transcript: String = ""
    /// 마지막 오류 안내(권한 거부·다운로드 실패 등). UI 가 alert 으로 노출. nil = 오류 없음.
    @Published var lastError: String?

    /// 인식 언어 힌트(앱 언어를 따라감) — Whisper ISO 코드. 명시하면 언어 자동탐지 오류를 피한다.
    private let languageCode: String
    private var whisperKit: WhisperKit?
    private let audioProcessor = AudioProcessor()
    /// `startRecording()` 이 async 라, 준비/권한 대기 중 손을 떼는(stop) 경합을 막는 플래그.
    private var cancelRequested = false

    /// 음성 인식 모델 변종 — 다운로드 용량/지연과 다국어(특히 CJK) 정확도의 트레이드오프.
    /// base = 빠르고 가벼움(기본), small = 정확도 우선(CJK 받아쓰기 신뢰도 ↑, 다운로드/지연 ↑).
    /// 두 변종 모두 «다국어» 모델만 쓴다 — `.en`(영어 전용) 변종은 ko/ja/zh 가 깨지므로 금지.
    enum ModelVariant: String, CaseIterable, Identifiable {
        case base = "openai_whisper-base"
        case small = "openai_whisper-small"

        var id: String { rawValue }

        /// 선택을 영속화하는 UserDefaults 키 — 앱 재시작 후에도 유지된다.
        static let storageKey = "voice.model.variant"
        static let `default`: ModelVariant = .base

        /// 지금 선택된 변종 — 저장값이 없거나 알 수 없으면 기본(base).
        static var current: ModelVariant {
            guard let raw = UserDefaults.standard.string(forKey: storageKey),
                  let v = ModelVariant(rawValue: raw) else { return .default }
            return v
        }

        static func persist(_ v: ModelVariant) {
            UserDefaults.standard.set(v.rawValue, forKey: storageKey)
        }

        /// 대략적 다운로드 용량(바이트) — 다운로드 전 저장공간 확인용. CoreML 변환 기준 근사치.
        var approxDownloadBytes: Int64 {
            switch self {
            case .base:  return 150 * 1024 * 1024
            case .small: return 480 * 1024 * 1024
            }
        }
    }

    /// WhisperKit 에 넘기는 변종 식별자 — 현재 «선택된» 변종을 따른다(설정에서 바꾸면 즉시 반영).
    /// nonisolated 인 저장 경로 헬퍼(modelFolderKey 등)가 참조하므로 nonisolated 로 둔다.
    nonisolated private static var modelName: String { ModelVariant.current.rawValue }

    /// 현재 «로드된»(또는 로드 시도 중인) 변종. 변종 전환 실패 시 «직전 모델» 폴백 판정 기준이다.
    /// UserDefaults 가 아니라 인메모리로 추적한다 — 설정의 @AppStorage 바인딩이 onChange 전에
    /// 이미 저장값을 새 변종으로 바꿔 버려, «직전 값» 을 저장소에서 읽으면 새 값과 같아지기 때문.
    private(set) var loadedVariant: ModelVariant = .current

    /// 앱 전역 공유 인스턴스. 모델 로드(다운로드 포함)는 «비싸고» 한 번이면 충분하므로, ChatView
    /// 마다 새로 만들지 않고 이 하나를 모든 채팅방이 공유한다. 그래야 한 번 `.ready` 가 된 뒤엔
    /// 방을 드나들어도 그대로 준비 상태가 유지된다(예전엔 방마다 @StateObject 라 들어올 때마다
    /// modelState=.idle 로 리셋 → 매번 prepare 가 다시 돌아 «다운로드 중» 배너가 떴다). 언어는
    /// 앱 재시작 때만 바뀌므로(LanguagePickerSheet 가 exit) 런치 시점 로케일로 한 번 고정해도 된다.
    static let shared = WhisperSpeechRecognizer(locale: appLocale())

    /// 한 번에 하나의 채팅방만 활성이므로 녹음 상태 공유는 안전하다.
    nonisolated init(locale: Locale = .current) {
        languageCode = Self.whisperLanguage(for: locale)
    }

    /// 앱이 «지금» 쓰는 언어의 로케일 — AppleLanguages override(있으면)·시스템 순.
    nonisolated static func appLocale() -> Locale {
        Locale(identifier: Locale.preferredLanguages.first ?? "en")
    }

    /// 앱 로케일(예: zh-Hans, pt-BR)을 Whisper ISO 언어코드(zh, pt)로 매핑. 지역 꼬리표를 떼고
    /// 베이스 언어만 남긴다 — Whisper 는 zh/pt 등 베이스 코드를 받는다.
    nonisolated static func whisperLanguage(for locale: Locale) -> String {
        let id = (locale.identifier.isEmpty ? "en" : locale.identifier)
        return String(id.split(separator: "-").first ?? "en").lowercased()
    }

    // MARK: - 모델 준비

    /// 모델을 (필요 시 다운로드 후) 로드한다. 이미 준비됐거나 진행 중이면 no-op. 첫 누름에서 호출.
    ///
    /// 핵심: 모델은 «한 번만» 받고 앱을 껐다 켜도 재사용한다.
    ///  - 받은 위치를 영속 디렉터리(Application Support, iOS 가 비우지 않고 백업되는 곳)로 «고정»
    ///    한다. 기본값은 iOS 가 정리할 수 있는 위치라, 매 실행 재다운로드의 원인이 될 수 있다.
    ///  - 한 번 받아 폴더 경로를 저장해 두면, 다음 실행부터는 «다운로드 호출 자체를 건너뛰고»
    ///    그 폴더에서 바로 로드한다(WhisperKit 은 modelFolder 가 주어지면 다운로드를 안 한다).
    func prepare() async {
        guard modelState == .idle || modelState == .failed else { return }
        modelState = .preparing
        downloadProgress = 0
        isLoadingModel = false
        lastError = nil
        do {
            // 0) 이미 받아둔 모델이 디스크에 있으면 다운로드 없이 바로 로드 — 앱 재실행에도 재사용.
            if let cached = Self.cachedModelFolder() {
                isLoadingModel = true
                let config = WhisperKitConfig(model: Self.modelName, modelFolder: cached.path, download: false)
                whisperKit = try await WhisperKit(config)
                isLoadingModel = false
                loadedVariant = ModelVariant.current
                modelState = .ready
                return
            }
            // 저장공간 부족 → «받기 전에» 안내하고 중단(받다 실패하느니 미리 막는다).
            guard Self.hasEnoughSpace(forBytes: ModelVariant.current.approxDownloadBytes) else {
                modelState = .failed
                lastError = String(localized: "저장공간이 부족해 음성 모델을 받을 수 없어요. 공간을 확보한 뒤 다시 시도해 주세요.")
                return
            }
            // 1) 처음이면 영속 위치로 1회 다운로드 — 진행률 보고. 콜백은 백그라운드라 MainActor 로 hop.
            let folder = try await WhisperKit.download(
                variant: Self.modelName,
                downloadBase: Self.modelsDownloadBase(),
                progressCallback: { [weak self] progress in
                    Task { @MainActor in self?.downloadProgress = progress.fractionCompleted }
                },
            )
            downloadProgress = 1
            // 다음 실행부터 재사용하도록 받은 폴더 경로를 저장.
            Self.saveModelFolder(folder)
            // 2) 받은 폴더에서 로드(재다운로드 없음). CoreML 컴파일/로드라 인디터미닛으로 표시.
            isLoadingModel = true
            let config = WhisperKitConfig(model: Self.modelName, modelFolder: folder.path, download: false)
            whisperKit = try await WhisperKit(config)
            isLoadingModel = false
            loadedVariant = ModelVariant.current
            modelState = .ready
        } catch {
            isLoadingModel = false
            modelState = .failed
            lastError = String(localized: "음성 모델을 준비하지 못했어요. 네트워크를 확인하고 다시 시도해 주세요.")
        }
    }

    /// 이미 받아둔 모델이 있으면 «미리» 로드한다(다운로드는 절대 하지 않음). 채팅방 진입 시 호출 →
    /// 마이크를 누르기 전에 .ready 가 되어 바로 녹음할 수 있다. 받은 적 없으면 no-op 으로 두어,
    /// 동의 없는 대용량 다운로드를 막는다(다운로드는 첫 누름에서만). 진행/완료/실패면 손대지 않는다.
    func preloadIfDownloaded() async {
        guard modelState == .idle, Self.cachedModelFolder() != nil else { return }
        await prepare()  // cachedModelFolder 가 있으니 prepare 는 다운로드 없이 로드 경로를 탄다.
    }

    /// 음성 인식 모델 변종(정확도/용량)을 바꾼다 — 새 변종을 1회 다운로드/로드하고 이 싱글턴을
    /// 새 가중치로 재로드한다. 「1회 다운로드 후 영구 재사용」 정책 그대로: 변종마다 캐시 폴더가
    /// 따로(`whisper.modelFolder.<변종>`)라, 한 번 받은 변종은 다시 받지 않고 즉시 로드된다.
    ///
    /// 교체 시점에 녹음 중이면 먼저 끝낸 뒤 교체한다(가중치가 바뀌면 인식이 깨진다). 새 변종
    /// 준비가 실패(다운로드 실패/취소·공간 부족)하면 직전 변종으로 «안전 폴백» 한다 — 직전 변종은
    /// 이미 캐시돼 있어 재다운로드 없이 즉시 복구되고, lastError 로 사용자에게 알린다.
    func setVariant(_ variant: ModelVariant) async {
        let previous = loadedVariant
        guard variant != previous else { return }

        // 진행 중 녹음이 있으면 먼저 종료한 뒤 교체한다.
        if isRecording { await stopRecording() }

        // 변종 전환 — 저장값을 바꾸고 현재 로드를 버린 뒤 새로 준비한다(상태/진행률 그대로 노출).
        ModelVariant.persist(variant)
        whisperKit = nil
        modelState = .idle
        downloadProgress = 0
        isLoadingModel = false
        lastError = nil

        await prepare()

        // 새 변종 준비 실패 → 직전 변종으로 폴백(캐시돼 있어 재다운로드 없이 복구).
        if modelState == .failed {
            ModelVariant.persist(previous)
            whisperKit = nil
            modelState = .idle
            downloadProgress = 0
            isLoadingModel = false
            await prepare()
            lastError = String(localized: "선택한 음성 모델을 준비하지 못해 이전 모델로 되돌렸어요. 네트워크와 저장공간을 확인해 주세요.")
        }
    }

    /// 모델 가중치를 받아둘 영속 디렉터리 — Application Support/WhisperKitModels. Caches/tmp 와 달리
    /// iOS 가 임의로 비우지 않고 앱 재실행/업데이트에도 (Data 컨테이너가 유지되는 한) 그대로 남는다.
    nonisolated private static func modelsDownloadBase() -> URL {
        let fm = FileManager.default
        let base = (try? fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("WhisperKitModels", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// 모델별 저장 경로 기억 키 — 모델명이 바뀌면(예: small 로 상향) 키도 달라져 새로 받는다.
    nonisolated private static var modelFolderKey: String { "whisper.modelFolder.\(modelName)" }

    /// 다운로드 전 저장공간 확인 — 받을 용량의 1.5배(다운로드 + 압축 해제 여유)가 있어야 true.
    /// 가용량을 못 읽으면 막지 않는다(오탐으로 차단하지 않도록 보수적으로 진행).
    nonisolated private static func hasEnoughSpace(forBytes needed: Int64) -> Bool {
        let url = modelsDownloadBase()
        guard let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
              let available = values.volumeAvailableCapacityForImportantUsage
        else { return true }
        return available > Int64(Double(needed) * 1.5)
    }

    /// 이전에 받아 저장해 둔 모델 폴더 — 실제로 파일이 남아 있을 때만 반환(없으면 nil → 재다운로드).
    ///
    /// 저장값은 «절대 경로가 아니라» 다운로드 베이스 기준 «상대 경로» 다(Apple 은 앱 컨테이너
    /// 절대 경로 영속화를 금한다 — OS 복원·마이그레이션 등에서 컨테이너 경로가 바뀌면 절대 경로는
    /// stale 이 돼, 파일이 멀쩡히 있어도 재다운로드하게 된다). 매 실행 현재 컨테이너 기준으로
    /// modelsDownloadBase() 를 다시 계산해 상대 경로를 붙이므로, 앱 «업데이트» 후에도 그대로 찾는다.
    nonisolated private static func cachedModelFolder() -> URL? {
        guard let rel = UserDefaults.standard.string(forKey: modelFolderKey), !rel.isEmpty else { return nil }
        let url = modelsDownloadBase().appendingPathComponent(rel, isDirectory: true)
        let fm = FileManager.default
        guard fm.fileExists(atPath: url.path),
              let contents = try? fm.contentsOfDirectory(atPath: url.path),
              !contents.isEmpty
        else { return nil }
        return url
    }

    /// 받은 폴더를 다운로드 베이스 기준 «상대 경로» 로 저장한다(절대 경로 영속화 금지 — 위 설명).
    nonisolated private static func saveModelFolder(_ url: URL) {
        let basePath = modelsDownloadBase().path
        var rel = url.path
        if rel.hasPrefix(basePath) {
            rel = String(rel.dropFirst(basePath.count))
        }
        rel = rel.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        // 베이스 밖(예외적)이면 절대 경로로라도 저장 — 같은 컨테이너 안에선 동작.
        UserDefaults.standard.set(rel.isEmpty ? url.path : rel, forKey: modelFolderKey)
    }

    // MARK: - 녹음 / 인식

    /// 버튼을 누르는 순간 호출. 모델이 준비 안 됐으면 준비만 시작하고 녹음은 하지 않는다(false 반환).
    /// 준비됐으면 마이크 권한 확인 후 녹음을 시작한다(true 반환).
    @discardableResult
    func startRecording() async -> Bool {
        cancelRequested = false
        lastError = nil

        guard modelState == .ready, let _ = whisperKit else {
            // 첫 누름 등 — 준비를 시작(또는 재시도)하고 이번 누름으론 녹음하지 않는다.
            await prepare()
            return false
        }

        guard await AudioProcessor.requestRecordPermission() else {
            lastError = String(localized: "설정에서 마이크 권한을 허용해 주세요.")
            return false
        }
        // 권한 대기 중 이미 손을 뗐으면 시작하지 않는다.
        guard !cancelRequested else { return false }

        do {
            transcript = ""
            audioProcessor.purgeAudioSamples(keepingLast: 0)
            try audioProcessor.startRecordingLive(callback: nil)
            isRecording = true
            return true
        } catch {
            lastError = String(localized: "녹음을 시작하지 못했어요.")
            return false
        }
    }

    /// 버튼을 떼는 순간 호출. 녹음을 멈추고 모인 오디오를 한 번에 transcribe 한다.
    /// 녹음 중이 아니었으면(준비 중 누름 등) no-op.
    func stopRecording() async {
        cancelRequested = true
        guard isRecording else { return }
        isRecording = false
        audioProcessor.stopRecording()

        let samples = Array(audioProcessor.audioSamples)
        // 너무 짧으면(스침 탭) 인식하지 않는다 — 16kHz 기준 0.3초 미만.
        guard samples.count > 4800, let whisperKit else { return }

        isTranscribing = true
        defer { isTranscribing = false }
        do {
            let options = DecodingOptions(task: .transcribe, language: languageCode, usePrefillPrompt: true)
            let results = try await whisperKit.transcribe(audioArray: samples, decodeOptions: options)
            let text = results.map(\.text).joined(separator: " ")
            transcript = Self.clean(text)
        } catch {
            lastError = String(localized: "음성을 인식하지 못했어요.")
        }
    }

    /// Whisper 출력 정리 — 앞뒤 공백과 «[_BG_]» 류의 비발화 토큰/이중 공백을 제거한다.
    private static func clean(_ raw: String) -> String {
        var s = raw
        // 비발화/특수 토큰 (대괄호로 감싼 마커, 예: [BLANK_AUDIO], (music)) 제거.
        s = s.replacingOccurrences(of: #"\[[^\]]*\]"#, with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\([^)]*\)"#, with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
