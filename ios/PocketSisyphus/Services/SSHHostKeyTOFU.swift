import Foundation
import Crypto
import NIOCore
import NIOSSH

/// 직접 SSH 채널의 host key 검증 — NIOSSH 표준 fingerprint API 위에 세운 TOFU + 핀.
///
/// 기존엔 host 공개키 한 줄(`cfg.sshHostKey`)이 있을 때만 `.trustedKeys` 로 strict pin 하고,
/// 없으면 `.acceptAnything()` 으로 무조건 받았다 — 후자가 적대적 LAN 에서 직접 채널 MITM 의
/// 여지였다. 이 validator 가 그 공백을 메운다.
///
/// ## 검증 우선순위 (강한 anchor 우선)
/// 1. **pinned key** (`cfg.sshHostKey` 의 완전한 공개키): 제시된 host key 와 «정확히» 일치해야
///    통과. 가장 강함.
/// 2. **신뢰 fingerprint**: pairing QR(대면 스캔) 또는 `/endpoint`(onion 인증 채널)로 받은
///    `expectedFingerprint`. 제시된 key 의 fingerprint 가 이것과 일치해야 통과. 첫 연결에도
///    신뢰 공백 없는 strict 검증이라 순수 TOFU 보다 강하다.
/// 3. **순수 TOFU**: anchor 가 전혀 없을 때만 — 장부에 없으면 첫 연결 시 기록하고 받아들이며,
///    있으면 대조한다.
///
/// 통과한 fingerprint 는 항상 `KnownHostStore` 에 기록(갱신)해 이후 연결의 TOFU 기준으로 쓴다.
/// 불일치는 `verdict` 박스에 기록하고 promise 를 fail 시켜 연결을 거부한다 — 서버 위장(MITM)
/// 신호다. 같은 sshd host key 를 직접/onion 이 공유하므로 onion 채널에도 무해하게 적용된다
/// (제시 key 의 fingerprint 가 anchor 와 일치).
final class TOFUHostKeyValidator: NIOSSHClientServerAuthenticationDelegate, @unchecked Sendable {

    /// host key 검증 결과를 검증 스레드(NIO event loop) → 호출자(SSHClient)로 전달하는 1비트 박스.
    /// 불일치(MITM 의심)면 expected/actual fingerprint 를 담는다. SSHClient 가 connect 실패 후
    /// 이 박스를 보고 일반 연결 실패와 host key 불일치를 구분한다.
    final class Verdict: @unchecked Sendable {
        private let lock = NSLock()
        private var _mismatch: (expected: String, actual: String)?
        var mismatch: (expected: String, actual: String)? {
            lock.lock(); defer { lock.unlock() }
            return _mismatch
        }
        func recordMismatch(expected: String, actual: String) {
            lock.lock(); defer { lock.unlock() }
            _mismatch = (expected, actual)
        }
    }

    private let identity: String
    private let pinnedKey: NIOSSHPublicKey?
    private let expectedFingerprint: String
    private let knownHosts: KnownHostStore
    private let verdict: Verdict

    init(
        identity: String,
        pinnedKey: NIOSSHPublicKey?,
        expectedFingerprint: String,
        knownHosts: KnownHostStore,
        verdict: Verdict
    ) {
        self.identity = identity
        self.pinnedKey = pinnedKey
        self.expectedFingerprint = expectedFingerprint
        self.knownHosts = knownHosts
        self.verdict = verdict
    }

    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        let fp = Self.fingerprint(of: hostKey)

        // 1) 완전한 pinned key — 정확히 일치해야 통과 (가장 강한 anchor).
        if let pinned = pinnedKey {
            if hostKey == pinned {
                accept(fp: fp, promise: validationCompletePromise)
            } else {
                reject(expected: Self.fingerprint(of: pinned), actual: fp, promise: validationCompletePromise)
            }
            return
        }

        // 2) 신뢰 fingerprint (pairing/endpoint, onion·QR 로 전달) — strict 대조.
        let expected = expectedFingerprint.trimmingCharacters(in: .whitespaces)
        if !expected.isEmpty {
            if fp == expected {
                accept(fp: fp, promise: validationCompletePromise)
            } else {
                reject(expected: expected, actual: fp, promise: validationCompletePromise)
            }
            return
        }

        // 3) 순수 TOFU — anchor 없음. 장부에 있으면 대조, 없으면 첫 신뢰로 기록.
        if let stored = knownHosts.fingerprint(forIdentity: identity) {
            if fp == stored {
                validationCompletePromise.succeed(())
            } else {
                reject(expected: stored, actual: fp, promise: validationCompletePromise)
            }
        } else {
            NSLog("[SSH] TOFU 첫 신뢰 — identity=%@ fingerprint=%@", identity, fp)
            knownHosts.record(fp, forIdentity: identity)
            validationCompletePromise.succeed(())
        }
    }

    private func accept(fp: String, promise: EventLoopPromise<Void>) {
        // anchor 검증 통과 → 그 fingerprint 를 TOFU 장부에 (재)기록. 이후 anchor 가 없는
        // 경로(방어용)에서도 같은 키를 신뢰하게 하고, stale 레코드를 권위 있는 값으로 갱신.
        knownHosts.record(fp, forIdentity: identity)
        promise.succeed(())
    }

    private func reject(expected: String, actual: String, promise: EventLoopPromise<Void>) {
        NSLog("[SSH] host key 불일치 — identity=%@ expected=%@ actual=%@", identity, expected, actual)
        verdict.recordMismatch(expected: expected, actual: actual)
        promise.fail(HostKeyMismatchError())
    }

    /// OpenSSH SHA256 fingerprint ("SHA256:<base64-no-pad>").
    ///
    /// NIOSSH 표준 wire 인코딩(`write(to:)` — 키 타입 prefix + 키 데이터)을 SHA256 해 base64
    /// 인코딩 후 padding 을 뗀다. `ssh-keygen -lf` 및 daemon 의 `computeSshFingerprint`
    /// (base64-decode 한 공개키 blob 의 sha256)과 «바이트 단위로» 동일하다.
    static func fingerprint(of key: NIOSSHPublicKey) -> String {
        var buf = ByteBufferAllocator().buffer(capacity: 256)
        key.write(to: &buf)
        let digest = SHA256.hash(data: Data(buf.readableBytesView))
        var b64 = Data(digest).base64EncodedString()
        while b64.hasSuffix("=") { b64.removeLast() }
        return "SHA256:\(b64)"
    }
}

/// host key 검증 실패(불일치) 시 promise 를 fail 시키는 마커 에러. SSHClient 가 verdict 박스로
/// 실제 fingerprint 를 읽어 `SSHError.hostKeyMismatch` 로 매핑하므로 메시지는 진단용.
struct HostKeyMismatchError: Error {}
