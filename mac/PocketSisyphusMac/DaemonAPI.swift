import Foundation

/// Mac 앱이 자기 안의 daemon (127.0.0.1, 포트는 DaemonPaths.boundDaemonPort()) 을 호출하는
/// 얇은 HTTP 클라이언트.
///
/// 외부 노출 0 — daemon 은 loopback 만 바인딩되어 있고 우리는 같은 머신이라 Tor 우회.
/// 인증은 config.json 의 평문 token 을 직접 읽어 Bearer 헤더로 사용 (daemon 부팅 시
/// 우리가 직접 만들어 둔 token 이므로 별도 페어링 불필요).
enum DaemonAPI {
    enum Error: LocalizedError {
        case tokenUnavailable
        case http(status: Int, body: String)
        case decode(String)
        /// daemon 이 `{ "error": "<code>", "message": … }` 로 돌려준 구조화 에러. UI 친화 메시지로 매핑.
        case api(code: String, message: String?)

        var errorDescription: String? {
            switch self {
            case .tokenUnavailable:
                return String(localized: "daemon 토큰을 읽지 못했습니다 (config.json 확인 필요)")
            case .http(let status, let body):
                let snippet = String(body.prefix(200))
                return String(localized: "HTTP \(status): \(snippet)")
            case .decode(let m):
                return String(localized: "응답 파싱 실패: \(m)")
            case .api(let code, let message):
                switch code {
                case "invalid_webhook_url":
                    return String(localized: "올바른 Discord webhook URL 이 아니에요")
                case "invalid_deep_link_url":
                    return String(localized: "올바른 딥링크 페이지 주소가 아니에요 — ?·# 없는 https URL 만 가능해요")
                case "not_configured":
                    return String(localized: "webhook URL 이 설정되지 않았어요")
                case "delivery_failed":
                    return String(localized: "Discord 전송에 실패했어요 — URL 을 확인하세요")
                case "daemon_not_initialized":
                    return String(localized: "daemon 이 아직 초기화되지 않았어요")
                case "insufficient_disk":
                    return String(localized: "디스크 공간이 부족해요 — 모델 크기 + 여유 10GB 가 필요해요")
                case "busy":
                    return String(localized: "이미 다른 모델을 받는 중이에요 — 끝난 뒤 다시 시도하세요")
                case "model_in_use":
                    return String(localized: "지금 실행 중인 모델이라 삭제할 수 없어요 — 먼저 로컬 LLM 을 종료하세요")
                case "unknown_model":
                    return String(localized: "알 수 없는 모델이에요")
                case "invalid_key":
                    return String(localized: "올바른 ASC API 키가 아니에요: \(message ?? code)")
                case "asc_not_configured":
                    return String(localized: "ASC API 키가 설정되지 않았어요")
                case "verify_failed":
                    return String(localized: "ASC 검증 실패 — 키 권한/만료를 확인하세요: \(message ?? code)")
                default:
                    return String(localized: "요청 실패: \(code)")
                }
            }
        }
    }

    /// `~/Library/Application Support/PocketSisyphus/config.json` 에서 평문 token 추출.
    /// 파일이 없거나 token 키가 누락이면 nil — daemon 이 아직 init 안 됐다는 신호.
    private static func loadToken() -> String? {
        let url = DaemonPaths.configFile
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = obj["token"] as? String,
              !token.isEmpty
        else {
            return nil
        }
        return token
    }

    /// config.json 의 `localAdminSecret` — 폰 등록 후 attest 게이트를 우회하는 로컬 운영자
    /// 비밀. QR 에 없으므로 폰은 가질 수 없다. 없으면 nil(첫 부팅 전/옛 daemon → 헤더 생략).
    private static func loadLocalAdminSecret() -> String? {
        guard let data = try? Data(contentsOf: DaemonPaths.configFile),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return obj["localAdminSecret"] as? String
    }

    /// 페어링 값 (token + onion + client-auth) 전체 회전. 옛 QR 즉시 무효.
    /// 응답에 새 onion 주소가 포함됨 — UI 표시용.
    @discardableResult
    static func rotatePairing() async throws -> String {
        guard let token = loadToken() else { throw Error.tokenUnavailable }

        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(DaemonPaths.boundDaemonPort())/api/admin/rotate-pairing")!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let secret = loadLocalAdminSecret() {
            req.setValue(secret, forHTTPHeaderField: "X-PS-Local")
        }
        // Tor 가 정지→재시작하는 동안 시간이 필요. waitForOnion 이 최대 30초라 60초 여유.
        req.timeoutInterval = 60

        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw Error.http(status: -1, body: "non-http response")
        }
        let body = String(data: data, encoding: .utf8) ?? ""
        guard (200..<300).contains(http.statusCode) else {
            throw Error.http(status: http.statusCode, body: body)
        }

        struct Resp: Decodable {
            let ok: Bool
            let onion: String
        }
        do {
            let parsed = try JSONDecoder().decode(Resp.self, from: data)
            return parsed.onion
        } catch {
            throw Error.decode("\(error)")
        }
    }

    // MARK: - 페어링된 기기 정보 / 슬롯 관리 (/api/admin/device-info, /device-slot, /revoke-device)

    /// 페어링/인증된 기기 목록 + 슬롯 상태. 다중 기기(최대 maxSlots대) 모델.
    struct DeviceInfo: Decodable {
        /// 1대 이상 등록됐는지. false 면 soft 모드(옛 폰 앱 / 미등록).
        let enrolled: Bool
        /// 추가 기기 슬롯이 켜져 있는지. 기본 false(1대만 허용).
        let extraSlotAllowed: Bool
        /// 연결 가능한 기기의 절대 상한 (현재 3). 표시는 항상 이 값을 따른다(하드코딩 금지).
        let maxSlots: Int
        /// 페어링 SSH client 키 지문 ("SHA256:...") — 모든 기기가 공유(QR 의 키).
        let sshClientKeyFingerprint: String?
        /// 등록된 기기들.
        let devices: [Device]

        struct Device: Decodable, Identifiable {
            /// SE 공개키 등록 시각 (epoch ms). 미상이면 nil.
            let registeredAt: Int64?
            /// 마지막 인증 접속 시각 (epoch ms, daemon 부팅 후 in-memory). 기록 없으면 nil.
            let lastSeen: Int64?
            /// SE 공개키 지문 ("SHA256:..."). 해제(revoke) 시 이 값을 키로 쓴다.
            let attestKeyFingerprint: String?
            /// SwiftUI ForEach 용 — 지문이 고유 식별자.
            var id: String { attestKeyFingerprint ?? "\(registeredAt ?? 0)" }
        }
    }

    /// 기기 목록 + 슬롯 상태 조회. notifyRequest 빌더 재사용(Bearer + X-Client-Version + X-PS-Local).
    static func deviceInfo() async throws -> DeviceInfo {
        let req = try notifyRequest(path: "/api/admin/device-info", method: "GET")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw Error.http(status: -1, body: "non-http response")
        }
        guard (200..<300).contains(http.statusCode) else {
            try throwAPIError(status: http.statusCode, data: data)
        }
        do {
            return try JSONDecoder().decode(DeviceInfo.self, from: data)
        } catch {
            throw Error.decode("\(error)")
        }
    }

    /// 추가 기기 슬롯 허용 토글. 끄려는데 1대를 넘게 등록돼 있으면 daemon 이
    /// `remove_extra_device_first`(409) 로 거절한다 — 호출부가 typed 에러로 안내.
    static func setExtraDeviceSlot(allowed: Bool) async throws {
        let req = try notifyRequest(
            path: "/api/admin/device-slot", method: "POST",
            jsonBody: ["allowed": allowed])
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw Error.http(status: -1, body: "non-http response")
        }
        guard (200..<300).contains(http.statusCode) else {
            try throwAPIError(status: http.statusCode, data: data)
        }
    }

    /// 등록된 기기 1대를 지문으로 골라 해제(attest 키 제거). 그 폰은 즉시 인증 거부된다.
    static func revokeDevice(fingerprint: String) async throws {
        let req = try notifyRequest(
            path: "/api/admin/revoke-device", method: "POST",
            jsonBody: ["fingerprint": fingerprint])
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw Error.http(status: -1, body: "non-http response")
        }
        guard (200..<300).contains(http.statusCode) else {
            try throwAPIError(status: http.statusCode, data: data)
        }
    }

    // MARK: - Discord 알림 설정 (/api/notify/*)

    /// 현재 X-Client-Version 헤더 값 — 호환성 미들웨어 통과용. Mac marketing 버전(예: 2.6.0).
    private static var clientVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }

    /// `/api/notify/*` 호출용 공통 요청 빌더 — Bearer + X-Client-Version + JSON body.
    private static func notifyRequest(
        path: String,
        method: String,
        jsonBody: [String: Any]? = nil,
        timeout: TimeInterval = 15
    ) throws -> URLRequest {
        guard let token = loadToken() else { throw Error.tokenUnavailable }
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(DaemonPaths.boundDaemonPort())\(path)")!)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(clientVersion, forHTTPHeaderField: "X-Client-Version")
        if let secret = loadLocalAdminSecret() {
            req.setValue(secret, forHTTPHeaderField: "X-PS-Local")
        }
        req.timeoutInterval = timeout
        if let jsonBody {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: jsonBody)
        }
        return req
    }

    /// non-2xx 응답에서 daemon 의 `{ "error": "<code>" }` 를 뽑아 typed 에러로. 코드가
    /// 없으면 raw http 에러로 fallback.
    private static func throwAPIError(status: Int, data: Data) throws -> Never {
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let code = obj["error"] as? String {
            throw Error.api(code: code, message: obj["message"] as? String)
        }
        throw Error.http(status: status, body: String(data: data, encoding: .utf8) ?? "")
    }

    /// 현재 알림 설정 조회. webhook URL 은 redact 된 미리보기만 온다 (평문 비반환).
    struct NotifyConfig: Decodable {
        struct Discord: Decodable {
            let configured: Bool
            let enabled: Bool
            let webhookUrlPreview: String?
            /// 사용자 지정 딥링크 브리지 base URL — 비밀 아님(공개 정적 페이지), 평문으로 옴.
            /// 구버전 daemon 응답엔 없을 수 있어 optional.
            let deepLinkBaseUrl: String?
            /// daemon 이 알려주는 기본 브리지 URL — placeholder 표시용 (단일 진실 원천).
            let deepLinkBaseUrlDefault: String?
            struct Events: Decodable {
                let turnComplete: Bool
                let sessionExit: Bool
                let error: Bool
            }
            let events: Events
        }
        let discord: Discord
    }

    static func getNotifyConfig() async throws -> NotifyConfig {
        let req = try notifyRequest(path: "/api/notify/config", method: "GET")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw Error.http(status: -1, body: "non-http response")
        }
        guard (200..<300).contains(http.statusCode) else {
            try throwAPIError(status: http.statusCode, data: data)
        }
        do {
            return try JSONDecoder().decode(NotifyConfig.self, from: data)
        } catch {
            throw Error.decode("\(error)")
        }
    }

    /// webhook URL 갱신 방식 — 평문 URL 은 저장 후 화면에 안 남기므로(redact 정책)
    /// 「기존 URL 그대로 두고 나머지 설정만 바꾸는」 케이스가 필요하다.
    enum WebhookURLUpdate {
        /// 키 생략 — daemon 이 기존 저장된 URL 을 유지 (이미 설정된 경우만 의미 있음).
        case keep
        /// 새 URL 저장.
        case set(String)
        /// 설정 해제 (URL 제거).
        case clear
    }

    /// Discord webhook 설정 저장. deepLinkBaseUrl 이 빈문자열이면 기본 브리지 페이지로 복귀.
    static func setDiscordWebhook(
        url: WebhookURLUpdate,
        enabled: Bool,
        turnComplete: Bool,
        sessionExit: Bool,
        error: Bool,
        deepLinkBaseUrl: String
    ) async throws {
        var discord: [String: Any] = [
            "enabled": enabled,
            "events": [
                "turnComplete": turnComplete,
                "sessionExit": sessionExit,
                "error": error,
            ],
            "deepLinkBaseUrl": deepLinkBaseUrl,
        ]
        switch url {
        case .keep: break // 키 생략 = 기존 URL 유지
        case .set(let u): discord["webhookUrl"] = u
        case .clear: discord["webhookUrl"] = ""
        }
        let req = try notifyRequest(
            path: "/api/notify/config",
            method: "POST",
            jsonBody: ["discord": discord]
        )
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw Error.http(status: -1, body: "non-http response")
        }
        guard (200..<300).contains(http.statusCode) else {
            try throwAPIError(status: http.statusCode, data: data)
        }
    }

    // MARK: - 로컬 LLM (/api/local-llm/*)

    /// daemon 이 띄운 llama-server 의 핵심 상태. status 응답의 `server` 하위객체만 디코드.
    /// spawnedByUs=true 일 때만 stop 이 실제로 메모리를 회수한다 (adopt 한 외부/LaunchAgent
    /// 서버는 daemon 이 건드리지 않음) → Mac UI 가 이 플래그로 종료 버튼 노출을 분기.
    struct LlmServerInfo: Decodable {
        let state: String          // stopped/preflight/starting/ready/error/adopted
        let modelId: String?
        let spawnedByUs: Bool
        let pid: Int?
        let ctxSize: Int?
    }
    private struct LocalLlmStatusEnvelope: Decodable { let server: LlmServerInfo }

    private static func localLlmRequest(
        path: String,
        method: String,
        jsonBody: [String: Any]? = nil,
        timeout: TimeInterval = 15
    ) throws -> URLRequest {
        guard let token = loadToken() else { throw Error.tokenUnavailable }
        guard let url = URL(string: "http://127.0.0.1:\(DaemonPaths.boundDaemonPort())\(path)") else {
            throw Error.tokenUnavailable
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(clientVersion, forHTTPHeaderField: "X-Client-Version")
        if let secret = loadLocalAdminSecret() {
            req.setValue(secret, forHTTPHeaderField: "X-PS-Local")
        }
        req.timeoutInterval = timeout
        if let jsonBody {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: jsonBody)
        }
        return req
    }

    /// 공통 send — 2xx 검증 + 구조화 에러 변환 + 옵셔널 디코드. 본문이 필요 없으면 T=EmptyOK.
    private static func localLlmSend<T: Decodable>(_ req: URLRequest, decode: T.Type) async throws -> T {
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw Error.http(status: -1, body: "non-http response")
        }
        guard (200..<300).contains(http.statusCode) else {
            try throwAPIError(status: http.statusCode, data: data)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw Error.decode("\(error)")
        }
    }

    /// 응답 본문을 안 쓰는 호출용 — 2xx 검증 + 구조화 에러 변환만.
    private static func localLlmSendNoBody(_ req: URLRequest) async throws {
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw Error.http(status: -1, body: "non-http response")
        }
        guard (200..<300).contains(http.statusCode) else {
            try throwAPIError(status: http.statusCode, data: data)
        }
    }

    // MARK: - 로컬 LLM 모델 카탈로그 / 다운로드 / 삭제 / 선택

    /// 카탈로그 모델 한 항목 (다운로드 여부 포함). daemon catalog.ts CatalogModel + downloaded.
    /// 표시에 필요한 필드만 디코드 — 나머지(hfRepo/sha256 등)는 무시.
    struct LlmCatalogModel: Decodable, Identifiable {
        let id: String
        let displayName: String
        let description: String
        let tier: String
        let quant: String
        let fileSizeBytes: Int64
        let minRamBytes: Int64
        let recommendedRamBytes: Int64
        let estDecodeTokSec: Double
        let estRssBytes: Int64
        /// 이 모델이 제공 가능한 최대 컨텍스트 (YaRN 포함). 구버전 daemon 엔 없을 수 있다.
        let ctxMax: Int?
        /// OpenAI 호환 도구호출이 견고한가 — false 면 «분석 전용»(에이전트 비권장). 구버전 daemon 엔 없을 수 있다.
        let toolCallCapable: Bool?
        let downloaded: Bool
    }
    struct LlmCatalogResponse: Decodable {
        let catalog: [LlmCatalogModel]
        let downloaded: [String]
        let recommendedModelId: String?
        let selectedModelId: String?
        let ctxSize: Int?
    }

    struct LlmHardware: Decodable {
        let totalRamBytes: Int64
        let chipBrand: String?
        let gpuCores: Int?
    }
    struct LlmDownloadProgress: Decodable {
        let modelId: String?
        let state: String   // idle/downloading/verifying/ready/error
        let bytesDownloaded: Int64
        let bytesTotal: Int64
        let percent: Double
        let bytesPerSec: Double
        let etaSeconds: Double?
        let error: String?
    }
    struct LlmBinaries: Decodable { let homebrew: Bool; let llamaServer: Bool; let qwen: Bool; let aria2c: Bool }
    struct LlmFullStatus: Decodable {
        let hardware: LlmHardware
        let recommendedModelId: String?
        let selectedModelId: String?
        let modelPresent: Bool
        let server: LlmServerInfo
        let download: LlmDownloadProgress
        let binaries: LlmBinaries
        let ctxSize: Int?
    }

    /// 카탈로그 + downloaded 플래그 + 추천/선택 모델.
    static func localLlmModels() async throws -> LlmCatalogResponse {
        let req = try localLlmRequest(path: "/api/local-llm/models", method: "GET")
        return try await localLlmSend(req, decode: LlmCatalogResponse.self)
    }

    /// 전체 상태 — 하드웨어 + 다운로드 진행 + 서버 + 선택/추천. (모델 탭 폴링에 사용.)
    static func localLlmFullStatus() async throws -> LlmFullStatus {
        let req = try localLlmRequest(path: "/api/local-llm/status", method: "GET")
        return try await localLlmSend(req, decode: LlmFullStatus.self)
    }

    /// 모델 다운로드 시작 (동시 1개). 디스크 부족이면 insufficient_disk, 이미 받는 중이면 busy.
    static func downloadLocalLlmModel(_ modelId: String) async throws {
        let req = try localLlmRequest(path: "/api/local-llm/download", method: "POST", jsonBody: ["modelId": modelId])
        try await localLlmSendNoBody(req)
    }

    /// 진행 중 다운로드 취소.
    static func cancelLocalLlmDownload() async throws {
        let req = try localLlmRequest(path: "/api/local-llm/download/cancel", method: "POST")
        try await localLlmSendNoBody(req)
    }

    /// 받은 모델 삭제 (디스크 회수). 실행 중 모델이면 model_in_use 로 거절된다.
    static func deleteLocalLlmModel(_ modelId: String) async throws {
        let encoded = modelId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? modelId
        let req = try localLlmRequest(path: "/api/local-llm/models/\(encoded)", method: "DELETE")
        try await localLlmSendNoBody(req)
    }

    /// 선택 모델 및 컨텍스트 크기 저장. 실행 중 서버는 자동 교체하지 않는다.
    static func saveLocalLlmConfig(modelId: String?, ctxSize: Int?) async throws {
        var body: [String: Any] = [:]
        if let modelId {
            body["modelId"] = modelId
        }
        if let ctxSize {
            body["ctxSize"] = ctxSize
        }
        let req = try localLlmRequest(path: "/api/local-llm/select", method: "POST", jsonBody: body)
        try await localLlmSendNoBody(req)
    }

    /// 선택 모델 저장 (config.localLlm.selectedModelId). 실행 중 서버는 자동 교체하지 않는다.
    static func selectLocalLlmModel(_ modelId: String) async throws {
        try await saveLocalLlmConfig(modelId: modelId, ctxSize: nil)
    }

    /// 로컬 LLM 서버 상태 조회 — Mac 메뉴가 «우리가 띄운 서버인지 + pid» 를 보고 종료
    /// 버튼/점유 메모리 표시를 분기한다.
    static func localLlmServer() async throws -> LlmServerInfo {
        let req = try localLlmRequest(path: "/api/local-llm/status", method: "GET")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw Error.http(status: -1, body: "non-http response")
        }
        guard (200..<300).contains(http.statusCode) else {
            try throwAPIError(status: http.statusCode, data: data)
        }
        do {
            return try JSONDecoder().decode(LocalLlmStatusEnvelope.self, from: data).server
        } catch {
            throw Error.decode("\(error)")
        }
    }

    // MARK: - 로컬 LLM 런타임 구성요소 설치 (/api/admin/install-agent)

    /// 설치 진행 스냅샷 — daemon `agent/install.ts` AgentInstallProgress 와 1:1. 폰/Mac 공용.
    /// adapterId 는 `local_llm/<component>` (구성요소 설치) — 어느 대상이 설치 중인지 매칭에 쓴다.
    struct AgentInstallProgress: Decodable {
        let adapterId: String?
        let state: String          // idle/installing/done/error
        let command: String?
        let log: String
        let exitCode: Int?
        let error: String?
        let installed: Bool
        let startedAt: Double?
    }

    /// `POST /api/admin/install-agent { component }` — local_llm 런타임 구성요소(llama-server /
    /// qwen)를 설치 시작한다. 폰과 같은 라우트·whitelist 상수 명령을 쓴다(임의 명령 실행 아님).
    /// 반환은 시작 시점 스냅샷 — 이후 진행은 `agentInstallStatus()` 폴링으로 읽는다.
    @discardableResult
    static func installLocalLlmComponent(_ component: String) async throws -> AgentInstallProgress {
        let req = try localLlmRequest(path: "/api/admin/install-agent", method: "POST", jsonBody: ["component": component])
        return try await localLlmSend(req, decode: AgentInstallProgress.self)
    }

    /// `GET /api/admin/install-agent/status` — 설치 진행 폴링(로그/상태/종료코드).
    static func agentInstallStatus() async throws -> AgentInstallProgress {
        let req = try localLlmRequest(path: "/api/admin/install-agent/status", method: "GET")
        return try await localLlmSend(req, decode: AgentInstallProgress.self)
    }

    /// 우리가 띄운 llama-server 를 정지해 점유 메모리를 회수한다. daemon 은 그대로 살아
    /// 있어 폰 연결이 유지된다. 다음 로컬 LLM 세션에서 supervisor 가 온디맨드로 다시 띄운다.
    /// SIGTERM → 최대 5s 후 SIGKILL 까지 daemon 이 await 하므로 timeout 을 넉넉히.
    static func stopLocalLlm() async throws {
        let req = try localLlmRequest(path: "/api/local-llm/server/stop", method: "POST", timeout: 20)
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw Error.http(status: -1, body: "non-http response")
        }
        guard (200..<300).contains(http.statusCode) else {
            try throwAPIError(status: http.statusCode, data: data)
        }
    }

    // MARK: - Discord 알림 설정 (계속)

    // MARK: - App Store Connect API 키 (/api/po/asc-key) — PO 수집의 스토어 리뷰 신호용

    /// 현재 키 설정 상태 — p8 본문은 절대 안 온다(비밀). keyId/issuerId 는 입력칸 복원용.
    struct AscKeyStatus: Decodable {
        let configured: Bool
        let keyId: String?
        let issuerId: String?
    }

    static func getAscKey() async throws -> AscKeyStatus {
        let req = try notifyRequest(path: "/api/po/asc-key", method: "GET")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw Error.http(status: -1, body: "non-http response")
        }
        guard (200..<300).contains(http.statusCode) else {
            try throwAPIError(status: http.statusCode, data: data)
        }
        do {
            return try JSONDecoder().decode(AscKeyStatus.self, from: data)
        } catch {
            throw Error.decode("\(error)")
        }
    }

    /// 키 저장 — daemon 이 PEM 형식을 검증하고 config.json(0600) 에만 보관한다.
    static func setAscKey(keyId: String, issuerId: String, privateKeyPem: String) async throws {
        let req = try notifyRequest(
            path: "/api/po/asc-key",
            method: "PUT",
            jsonBody: ["keyId": keyId, "issuerId": issuerId, "privateKeyPem": privateKeyPem]
        )
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw Error.http(status: -1, body: "non-http response")
        }
        guard (200..<300).contains(http.statusCode) else {
            try throwAPIError(status: http.statusCode, data: data)
        }
    }

    static func deleteAscKey() async throws {
        let req = try notifyRequest(path: "/api/po/asc-key", method: "DELETE")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw Error.http(status: -1, body: "non-http response")
        }
        guard (200..<300).contains(http.statusCode) else {
            try throwAPIError(status: http.statusCode, data: data)
        }
    }

    /// ASC 실호출 검증 결과 — appId 를 줬으면 그 앱 이름 + 전체 리뷰 수까지 온다.
    struct AscVerifyResult: Decodable {
        let ok: Bool
        let appName: String?
        let reviewCount: Int?
    }

    /// 실호출 검증 — 키 후보(저장 전)나 저장된 키로 ASC API 가 실제로 응답하는지 확인.
    /// appId(앱 ID 또는 번들 ID)를 주면 리뷰 읽기 권한까지 확인한다. ASC 왕복이라 timeout 여유.
    static func verifyAscKey(
        appId: String?,
        keyId: String? = nil,
        issuerId: String? = nil,
        privateKeyPem: String? = nil
    ) async throws -> AscVerifyResult {
        var body: [String: Any] = [:]
        if let appId, !appId.isEmpty { body["appId"] = appId }
        if let keyId, let issuerId, let privateKeyPem, !privateKeyPem.isEmpty {
            body["keyId"] = keyId
            body["issuerId"] = issuerId
            body["privateKeyPem"] = privateKeyPem
        }
        let req = try notifyRequest(
            path: "/api/po/asc-key/verify",
            method: "POST",
            jsonBody: body,
            timeout: 30
        )
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw Error.http(status: -1, body: "non-http response")
        }
        guard (200..<300).contains(http.statusCode) else {
            try throwAPIError(status: http.statusCode, data: data)
        }
        do {
            return try JSONDecoder().decode(AscVerifyResult.self, from: data)
        } catch {
            throw Error.decode("\(error)")
        }
    }

    /// 테스트 알림 한 발. url / deepLinkBaseUrl 을 주면 저장 전 그 값으로 검증 발사,
    /// nil 이면 저장된 설정으로.
    static func testDiscord(url: String?, deepLinkBaseUrl: String? = nil) async throws {
        var body: [String: Any] = [:]
        if let url, !url.isEmpty { body["webhookUrl"] = url }
        if let deepLinkBaseUrl, !deepLinkBaseUrl.isEmpty { body["deepLinkBaseUrl"] = deepLinkBaseUrl }
        let req = try notifyRequest(
            path: "/api/notify/test",
            method: "POST",
            jsonBody: body,
            timeout: 20
        )
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw Error.http(status: -1, body: "non-http response")
        }
        guard (200..<300).contains(http.statusCode) else {
            try throwAPIError(status: http.statusCode, data: data)
        }
    }

    // MARK: - 최근 프로젝트 (/api/recent-projects) — 디자인 탭 레포 픽커용

    struct RecentProject: Decodable, Identifiable, Hashable {
        let path: String
        var id: String { path }
    }

    /// ~/.claude/projects 스캔 결과 — 디자인 부트스트랩 탭이 «어느 레포» 를 고를지 채운다.
    static func recentProjects() async throws -> [RecentProject] {
        let req = try notifyRequest(path: "/api/recent-projects", method: "GET")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw Error.http(status: -1, body: "non-http response")
        }
        guard (200..<300).contains(http.statusCode) else {
            try throwAPIError(status: http.statusCode, data: data)
        }
        struct Resp: Decodable { let projects: [RecentProject] }
        do {
            return try JSONDecoder().decode(Resp.self, from: data).projects
        } catch {
            throw Error.decode("\(error)")
        }
    }

    // MARK: - PO 디자인 directive 부트스트랩 (/api/po/design-directive/*, /api/po/profile)

    /// 레포의 PO 프로필 중 디자인 상태 — 선언(승인된 강신호)·초안(검토 대기)·생성 세션(non-nil=생성 중).
    /// 디자인 탭이 소비하는 부분만 디코드한다(나머지 프로필 필드는 무시).
    struct PoDesignState: Decodable {
        let designDirective: String?
        let designDirectiveDraft: String?
        let designDirectiveDraftSessionId: String?
    }

    /// `GET /api/po/profile?repoPath=…` — 디자인 상태를 읽어 온다.
    static func getPoDesignState(repoPath: String) async throws -> PoDesignState {
        let q = repoPath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? repoPath
        let req = try notifyRequest(path: "/api/po/profile?repoPath=\(q)", method: "GET")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw Error.http(status: -1, body: "non-http response")
        }
        guard (200..<300).contains(http.statusCode) else {
            try throwAPIError(status: http.statusCode, data: data)
        }
        do {
            return try JSONDecoder().decode(PoDesignState.self, from: data)
        } catch {
            throw Error.decode("\(error)")
        }
    }

    /// `POST /api/po/design-directive/bootstrap` — 디자이너 에이전트가 레포 디자인 SSOT 를 스캔해
    /// directive 초안 작성을 시작한다. 이미 생성 중이면 daemon 이 400 (bootstrap_failed).
    static func bootstrapPoDesignDirective(repoPath: String) async throws {
        let req = try notifyRequest(
            path: "/api/po/design-directive/bootstrap", method: "POST",
            jsonBody: ["repoPath": repoPath])
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw Error.http(status: -1, body: "non-http response")
        }
        guard (200..<300).contains(http.statusCode) else {
            try throwAPIError(status: http.statusCode, data: data)
        }
    }

    /// `POST /api/po/design-directive/approve` — 검토(가능하면 편집)한 directive 를 승인해
    /// design_directive(선언된 강신호)로 복사하고 초안을 정리한다.
    static func approvePoDesignDirective(repoPath: String, directive: String) async throws {
        let req = try notifyRequest(
            path: "/api/po/design-directive/approve", method: "POST",
            jsonBody: ["repoPath": repoPath, "directive": directive])
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw Error.http(status: -1, body: "non-http response")
        }
        guard (200..<300).contains(http.statusCode) else {
            try throwAPIError(status: http.statusCode, data: data)
        }
    }

    /// `DELETE /api/po/design-directive/draft?repoPath=…` — 초안 버리기(승인 안 함).
    static func discardPoDesignDraft(repoPath: String) async throws {
        let q = repoPath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? repoPath
        let req = try notifyRequest(
            path: "/api/po/design-directive/draft?repoPath=\(q)", method: "DELETE")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw Error.http(status: -1, body: "non-http response")
        }
        guard (200..<300).contains(http.statusCode) else {
            try throwAPIError(status: http.statusCode, data: data)
        }
    }
}
