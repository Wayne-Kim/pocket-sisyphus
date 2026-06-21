import Foundation

/// 통합 로그 — Mac 앱과 daemon 이 같은 unified.log 한 파일에 JSON Lines 로 기록한다.
/// 포맷은 ECS (Elastic Common Schema) — daemon 측 `logging/log.ts` 와 동일.
///
/// 한 줄 ≤ 4 KiB 보장 (POSIX O_APPEND 의 atomic write 경계). daemon (Node.js) 도
/// 같은 파일에 append — 두 writer 가 같은 파일을 안전하게 공유.
///
/// 회전 정책: Mac 앱 launch 시점에 한 번만 `rotateIfNeeded()` 호출. daemon 은 회전
/// 안 함 (Mac 앱이 daemon spawn 직전 — 동기화 지점이 자연스럽게 한 곳).
enum UnifiedLog {

    enum Channel: String {
        case macapp
        case daemonmgr
        case network
        case sparkle
        case pair
        case auth
    }

    enum Level: String {
        case trace, debug, info, warn, error, fatal
    }

    /// `~/Library/Application Support/PocketSisyphus/logs/unified.log`
    static let logFile: URL = {
        let dir = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("PocketSisyphus", isDirectory: true)
            .appendingPathComponent("logs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("unified.log")
    }()

    private static let rotateThresholdBytes: UInt64 = 10 * 1024 * 1024  // 10 MiB
    private static let maxLineBytes: Int = 4096
    private static let messageMaxBytes: Int = 1024

    /// 매 앱 launch 마다 새 6자 — PID 재활용 위험 없는 인스턴스 식별자. daemon 측의
    /// `service.instance.id` 와 같은 의미 (다른 프로세스라 값 자체는 별개).
    private static let instanceId: String = {
        var bytes = [UInt8](repeating: 0, count: 3)
        _ = SecRandomCopyBytes(kSecRandomDefault, 3, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }()

    /// `Bundle.main` 의 `CFBundleShortVersionString+CFBundleVersion` (예: "2.5.0+372").
    /// daemon 의 `service.version` 과 같은 키. 어느 빌드에서 생긴 로그인지 한눈 판정.
    private static let serviceVersion: String = {
        let info = Bundle.main.infoDictionary
        let marketing = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(marketing)+\(build)"
    }()

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// 동시 append 자체는 O_APPEND 가 보장하지만 같은 프로세스 안의 여러 스레드가
    /// 동시 호출할 때 라인 직렬화 / 핸들 캐시 경합을 막기 위해 큐 직렬화.
    private static let writeQueue = DispatchQueue(label: "com.pocketsisyphus.unifiedlog")

    /// 회전: 10 MiB 초과 시 `.1` 로 한 단계만 회전 (백업 1개). Mac 앱 launch 시점에
    /// `DaemonManager` 가 daemon spawn 하기 직전에 한 번 호출하면 충분 — 그 외 시점에는
    /// 두 writer 가 동시 가동 중이라 회전 안 함.
    static func rotateIfNeeded() {
        writeQueue.sync {
            let path = logFile.path
            let attrs = try? FileManager.default.attributesOfItem(atPath: path)
            let size = (attrs?[.size] as? UInt64) ?? 0
            guard size >= rotateThresholdBytes else { return }
            let backup = logFile.deletingLastPathComponent()
                .appendingPathComponent("unified.log.1")
            try? FileManager.default.removeItem(at: backup)
            try? FileManager.default.moveItem(at: logFile, to: backup)
        }
    }

    static func trace(_ channel: Channel, _ message: String, _ fields: [String: Any] = [:]) {
        write(.trace, channel, message, fields)
    }
    static func debug(_ channel: Channel, _ message: String, _ fields: [String: Any] = [:]) {
        write(.debug, channel, message, fields)
    }
    static func info(_ channel: Channel, _ message: String, _ fields: [String: Any] = [:]) {
        write(.info, channel, message, fields)
    }
    static func warn(_ channel: Channel, _ message: String, _ fields: [String: Any] = [:]) {
        write(.warn, channel, message, fields)
    }
    static func error(_ channel: Channel, _ message: String, _ fields: [String: Any] = [:]) {
        write(.error, channel, message, fields)
    }
    static func fatal(_ channel: Channel, _ message: String, _ fields: [String: Any] = [:]) {
        write(.fatal, channel, message, fields)
    }

    private static func write(
        _ level: Level,
        _ channel: Channel,
        _ message: String,
        _ fields: [String: Any]
    ) {
        // ISO 직렬화는 비교적 비싸서 큐 밖에서 — 그래도 동시 호출 시 큰 부담 아니고
        // 정확한 wall-clock timestamp 가 호출 시점에 박혀야 의미가 있어 여기서 만든다.
        let ts = isoFormatter.string(from: Date())
        let truncated = truncateMessage(message)

        var payload: [String: Any] = [
            "@timestamp": ts,
            "log.level": level.rawValue,
            "log.logger": channel.rawValue,
            "process.name": "macapp",
            "process.pid": ProcessInfo.processInfo.processIdentifier,
            "service.version": serviceVersion,
            "service.instance.id": instanceId,
            "message": truncated,
        ]
        for (k, v) in fields {
            payload[k] = v
        }

        writeQueue.async {
            guard let data = serialize(payload) else { return }
            append(data)
        }
    }

    private static func truncateMessage(_ msg: String) -> String {
        if msg.utf8.count > messageMaxBytes {
            // utf8 단위로 자르면서 grapheme 경계 우회 — message 는 사람-가독이지만
            // 한 줄 4 KiB 강제가 더 중요. 끝 마커로 잘림 표시.
            let limited = String(decoding: Array(msg.utf8.prefix(messageMaxBytes)), as: UTF8.self)
            return limited + "...[truncated]"
        }
        return msg
    }

    private static func serialize(_ payload: [String: Any]) -> Data? {
        guard JSONSerialization.isValidJSONObject(payload),
              var data = try? JSONSerialization.data(withJSONObject: payload, options: [])
        else {
            return nil
        }
        // 라인 4 KiB 안전망. 직렬화 결과가 한계 넘으면 fields 영역을 모두 잘라낸 최소
        // payload 로 재시도. daemon 측 enforceLineSize 와 같은 정책.
        if data.count + 1 > maxLineBytes {
            var minimal: [String: Any] = [
                "@timestamp": payload["@timestamp"] ?? "",
                "log.level": payload["log.level"] ?? "info",
                "log.logger": payload["log.logger"] ?? "macapp",
                "process.name": "macapp",
                "message": payload["message"] ?? "",
                "truncated": true,
            ]
            if let pid = payload["process.pid"] { minimal["process.pid"] = pid }
            if JSONSerialization.isValidJSONObject(minimal),
               let retry = try? JSONSerialization.data(withJSONObject: minimal, options: [])
            {
                data = retry
            }
        }
        data.append(0x0A)  // \n — JSON Lines 라인 종결자
        return data
    }

    /// O_APPEND 로 한 번에 < 4 KiB write — POSIX 가 atomic 보장. daemon 과 동시 append
    /// 안전. 핸들은 매 write 마다 열고 닫음 — 단순성 우선. 호출 빈도가 초당 수십 회
    /// 이하라 성능 부담 없음.
    private static func append(_ data: Data) {
        let path = logFile.path
        let fd = path.withCString { open($0, O_WRONLY | O_APPEND | O_CREAT, 0o644) }
        if fd < 0 { return }
        defer { close(fd) }
        _ = data.withUnsafeBytes { rawBuf in
            Darwin.write(fd, rawBuf.baseAddress, data.count)
        }
    }
}
