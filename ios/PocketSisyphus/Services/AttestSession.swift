import Foundation
import LocalAuthentication

/// Secure Enclave 기기 인증의 «세션 토큰» 관리 — 앱 전역 공유 싱글톤.
///
/// ## 왜 싱글톤인가
/// `ApiClient` 는 화면마다 `ApiClient(auth:conn:)` 로 즉석 생성되는 가벼운 객체라, attest
/// 토큰을 거기 두면 인스턴스끼리 공유가 안 된다. 토큰은 여기 in-memory 로 한 곳에 모으고
/// `ApiClient`·`WSClient` 가 헤더/쿼리에 끼워 넣을 때 읽어 간다.
///
/// ## 정책: «세션당 1회» Face ID
/// 한 번 challenge-response 로 토큰을 받으면, 그 토큰을 만료(24h)·daemon 재시작 전까지
/// 재사용한다. 포그라운드 복귀·SSH 재연결·여러 ApiClient 호출은 캐시된 토큰을 그냥 쓰므로
/// Face ID 프롬프트가 다시 뜨지 않는다. 토큰은 일부러 디스크에 안 적는다 — 앱 프로세스가
/// 죽으면 다음 콜드런치에서 1회 재인증(= 한 «세션» 의 경계).
@MainActor
final class AttestSession: ObservableObject {
    static let shared = AttestSession()
    private init() {}

    /// daemon 이 이 기기 인증을 «강제» 하는지에 대한 클라이언트 측 캐시.
    enum Enrollment { case unknown, enrolled, notEnrolled }

    private var cachedToken: String?
    private var expiry: Date?
    /// daemon 이 기기 인증을 강제하는지. AppRoot 가 잠금 게이트 노출 여부를 결정할 때 본다.
    @Published private(set) var enrollment: Enrollment = .unknown
    /// «이번 앱 프로세스에서 한 번이라도 잠금이 풀렸는가» 의 단방향 래치. 첫 토큰 확보 시 true.
    /// 24h 만료로 토큰이 무효화돼도 false 로 안 되돌린다 — 만료 후 첫 요청은 401→ApiClient 가
    /// «세션 안» 에서 조용히 재인증(드문 경우)하지, 전체 잠금 화면으로 되돌리지 않는다. false 로
    /// 되돌리는 경계는 «콜드 런치(프로세스 재시작)» 또는 «재페어링» 뿐.
    @Published private(set) var unlocked = false
    /// PairView 가 페어링 흐름(연결→등록→첫 토큰)을 «직접» 운전하는 동안 true. 이 사이엔
    /// AppRoot 가 잠금 게이트(LockView)를 띄우지 않는다 — 안 그러면 게이트의 ensureToken 과
    /// pairingEnroll 의 challenge-response 가 동시에 돌아 생체 프롬프트가 두 번 뜬다.
    @Published private(set) var pairing = false
    /// 동시 refresh 디듀프 — 여러 호출(HTTP 401 회복 + WS warm)이 겹쳐도 Face ID 한 번.
    private var inflight: Task<String?, Error>?

    /// AppRoot 의 잠금 게이트 노출 조건. 미등록(soft·옛 daemon·시뮬레이터)이거나 이미 잠금이
    /// 풀렸거나 페어링 중이면 게이트 없음. 등록 여부 미확인(.unknown)이면 일단 게이트를 띄워
    /// LockView 가 status 를 확인하게 한다(미등록으로 판명되면 즉시 통과).
    var needsAuthGate: Bool {
        // 시뮬레이터 개발 페어링 — SE 가 없어 LockView 를 절대 못 풀므로 게이트 자체를 끈다.
        // daemon 측 검증은 X-PS-Local(localAdminSecret) 이 대신한다.
        if DevPairing.isActive { return false }
        return !pairing && enrollment != .notEnrolled && !unlocked
    }

    /// challenge-response(Face ID 포함)가 «지금 진행 중» 인가 — 읽기 전용 신호.
    /// LockView 가 포그라운드 복귀 시 자동 인증을 재발사할지 판단할 때 본다. ensureToken 자체도
    /// inflight 로 디듀프하지만, 진행 중이면 호출을 아예 건너뛰어 생체 프롬프트 중복을 한 겹 더 막는다.
    var isAuthenticating: Bool { inflight != nil }

    /// PairView 가 verifyAndSave 진입/종료 시 호출 — 그동안 잠금 게이트 억제.
    func beginPairing() { pairing = true }
    func endPairing() { pairing = false }

    /// 헤더/쿼리 주입용 — 캐시된 «유효» 토큰을 동기 반환(네트워크/Face ID 없음). 없으면 nil.
    func currentToken() -> String? {
        guard let cachedToken, let expiry, expiry > Date() else { return nil }
        return cachedToken
    }

    /// 401 attest_required 를 받았을 때 — 캐시 무효화. 다음 ensureToken 이 재인증한다.
    func invalidate() {
        cachedToken = nil
        expiry = nil
    }

    /// 페어링 직후 1회 — daemon 이 attest 를 지원하면 SE 키를 등록하고 첫 토큰까지 확보.
    /// 옛 daemon(404)·미지원이면 조용히 통과(하위 호환). Face ID 는 (등록+검증 합쳐) 한 번.
    func pairingEnroll(api: ApiClient) async throws {
        guard DeviceAttestor.isAvailable else {
            // 시뮬레이터 등 Secure Enclave 미지원 — 기기 인증 비활성(soft)로 페어링 통과.
            NSLog("[Attest] Secure Enclave 미지원 — 기기 인증 등록 건너뜀")
            enrollment = .notEnrolled
            return
        }
        let status: (enrolled: Bool, fingerprint: String?, fingerprints: [String]?, slotAvailable: Bool?)
        do {
            status = try await api.attestStatus()
        } catch ApiError.httpStatus(404, _) {
            enrollment = .notEnrolled  // attest 모르는 옛 daemon
            return
        }

        // 현재 등록된 기기 지문 집합. 신규 daemon 은 fingerprints(목록), 옛 daemon 은
        // fingerprint(단일) 만 준다 — 둘을 합쳐 «내 키가 이미 등록돼 있나» 를 판정한다.
        let registered: [String] = status.fingerprints ?? status.fingerprint.map { [$0] } ?? []
        let mine = DeviceAttestor.hasKey() ? DeviceAttestor.publicKeyFingerprint() : nil

        if let mine, registered.contains(mine) {
            // 내 키가 이미 등록됨(재페어링) — 등록은 그대로 두고 challenge-response 로 토큰만 새로.
            enrollment = .enrolled
            try await runChallengeResponse(api: api, context: makeContext())
            return
        }

        if status.enrolled {
            // 이미 다른 기기가 등록돼 있고 내 키는 미등록. 빈 슬롯이 있으면 «추가 기기» 로
            // 등록하고, 없으면(=추가 기기 슬롯이 안 켜졌거나 이미 상한까지 등록) 생체 프롬프트가
            // 뜨기 «전» 에 명확히 막는다. 안내문은 특정 대수를 박지 않는다 — 상한(최대 3대)은
            // daemon 의 device-info.maxSlots 가 진실이고 옛/새 daemon 따라 달라질 수 있어, 여기선
            // «더 연결하려면 허용을 켜라» 로만 안내한다. slotAvailable 부재(옛 daemon)는 단일 기기
            // 모델 → 차단(기존 동작).
            let slotOpen = status.slotAvailable ?? false
            if !slotOpen {
                enrollment = .enrolled
                throw ApiError.attestFailed(String(localized:
                    "이 Mac에는 이미 기기가 연결돼 있어요. 기기를 더 연결하려면 Mac의 Pocket Sisyphus 설정 → 「기기」 탭에서 «추가 기기 허용»을 먼저 켠 뒤 다시 스캔해 주세요. (또는 기존 기기를 해제하세요.)"))
            }
            // slotOpen — 추가 기기로 등록을 이어 간다(아래 공통 등록 경로).
        }

        // 미등록(첫 기기) 또는 빈 슬롯(추가 기기) — 이 기기 SE 키 생성 + 소유 증명 서명
        // (공개키 자체에 서명) 동봉해 등록.
        let context = makeContext()
        let pub = try DeviceAttestor.enrollIfNeeded()
        guard let pubData = Data(base64Encoded: pub) else {
            throw ApiError.attestFailed(String(localized: "기기 인증 공개키 인코딩 오류"))
        }
        let regSig = try DeviceAttestor.sign(pubData, context: context)
        try await api.attestRegister(
            publicKeyBase64: pub, signatureBase64: regSig.base64EncodedString())
        enrollment = .enrolled
        // 같은 context 재사용 → reuse-duration 안이라 Face ID 두 번 안 뜸.
        try await runChallengeResponse(api: api, context: context)
    }

    /// 토큰 확보 — 캐시 유효하면 그대로, 아니면 challenge-response 1회(Face ID).
    /// 미등록(soft)·옛 daemon 이면 nil(프롬프트 없음). 동시 호출은 단일 in-flight 로 합친다.
    @discardableResult
    func ensureToken(api: ApiClient) async throws -> String? {
        if let t = currentToken() { return t }
        if enrollment == .notEnrolled { return nil }
        if let inflight { return try await inflight.value }
        let task = Task<String?, Error> { [weak self] in
            guard let self else { return nil }
            return try await self.refresh(api: api)
        }
        inflight = task
        defer { inflight = nil }
        return try await task.value
    }

    // MARK: - private

    private func refresh(api: ApiClient) async throws -> String? {
        // 등록 여부 재확인 (옛 daemon → 404 → notEnrolled, 프롬프트 없이 종료).
        let status: (enrolled: Bool, fingerprint: String?, fingerprints: [String]?, slotAvailable: Bool?)
        do {
            status = try await api.attestStatus()
        } catch ApiError.httpStatus(404, _) {
            enrollment = .notEnrolled
            return nil
        }
        if !status.enrolled {
            enrollment = .notEnrolled
            return nil
        }
        enrollment = .enrolled
        guard DeviceAttestor.hasKey() else {
            // daemon 은 등록돼 있는데 이 기기엔 SE 키가 없음 = 기기 교체/복원/재설치 후 키 소실.
            // 재등록은 막혀 있으므로(409) Mac 에서 페어링을 다시 시작해야 복구된다.
            throw ApiError.attestFailed(
                String(localized: "이 기기의 인증 키가 없습니다 — Mac에서 페어링을 다시 시작하세요"))
        }
        try await runChallengeResponse(api: api, context: makeContext())
        return cachedToken
    }

    /// challenge 발급 → SE 서명 → verify → 토큰 캐시. Face ID 는 여기 sign 에서 1회.
    private func runChallengeResponse(api: ApiClient, context: LAContext) async throws {
        let challenge = try await api.attestChallenge()
        let sig = try DeviceAttestor.sign(Data(challenge.nonce.utf8), context: context)
        let result = try await api.attestVerify(
            nonce: challenge.nonce, signatureBase64: sig.base64EncodedString())
        cachedToken = result.token
        expiry = Date(timeIntervalSince1970: Double(result.exp) / 1000.0)
        // 토큰 확보 = 잠금 해제. 단방향 래치라 이후 만료/invalidate 로 false 로 안 돌아간다.
        unlocked = true
    }

    private func makeContext() -> LAContext {
        let ctx = LAContext()
        // 한 인증 사이클(등록 서명 + nonce 서명)에서 Face ID 한 번만 뜨게 하는 reuse 윈도우.
        ctx.touchIDAuthenticationAllowableReuseDuration = 30
        return ctx
    }
}
