import SwiftUI
import UniformTypeIdentifiers

/// 「App Store」 탭 — App Store Connect API 키 설정. PO 수집이 이 키로 스토어 고객 리뷰를
/// 읽어 «스토어 리뷰 신호» 로 쓴다. 키(issuer/key id/.p8)는 daemon config.json(0600) 에만
/// 저장되고 폰/QR 에는 절대 들어가지 않는다 (외부서버 0 원칙 — daemon 이 직접 ASC 호출).
/// reloadToken 이 바뀌면(설정 창 재오픈) 서버 상태를 다시 읽는다.
struct AscSettingsView: View {
    let reloadToken: UUID

    @State private var keyId = ""
    @State private var issuerId = ""
    /// 선택한 .p8 파일 내용 — 저장 후 비운다 (평문을 화면/메모리에 안 남김).
    @State private var privateKeyPem = ""
    @State private var pemFileName: String?
    @State private var showFileImporter = false
    /// 검증용 앱 식별자 (선택) — 앱 ID(숫자) 또는 번들 ID. 리뷰 읽기 권한까지 확인.
    @State private var verifyAppId = ""

    @State private var isConfigured = false
    @State private var configuredKeyId: String?

    @State private var isWorking = false
    @State private var statusText: String?
    @State private var statusIsError = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                statusBlock
                guideBox
                form
                actions
                if let statusText {
                    Text(statusText)
                        .font(.callout)
                        .foregroundStyle(statusIsError ? Color.red : Color.green)
                        .fixedSize(horizontal: false, vertical: true)
                }
                securityNote
            }
            .padding(20)
        }
        .frame(minWidth: 520, minHeight: 560)
        .onAppear { load() }
        .onChange(of: reloadToken) { _ in load() }
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [UTType(filenameExtension: "p8") ?? .data, .text],
            allowsMultipleSelection: false
        ) { result in
            guard case .success(let urls) = result, let url = urls.first else { return }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            if let content = try? String(contentsOf: url, encoding: .utf8),
               content.contains("PRIVATE KEY") {
                privateKeyPem = content
                pemFileName = url.lastPathComponent
                statusText = nil
            } else {
                setStatus(String(localized: "비밀키(.p8) 파일이 아니에요 — AuthKey_XXXX.p8 을 선택하세요"), isError: true)
            }
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "star.bubble")
                .font(.largeTitle)
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 4) {
                Text("App Store 리뷰 연동")
                    .font(.title2.weight(.semibold))
                Text("출시한 앱의 스토어 리뷰를 PO 수집이 읽어 사용자 불만·요청을 브리프 근거로 가져와요.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Text("외부 서버 없이, 이 Mac 이 App Store Connect API 를 직접 호출합니다.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
        }
    }

    @ViewBuilder
    private var statusBlock: some View {
        HStack(spacing: 8) {
            Image(systemName: isConfigured ? "checkmark.circle.fill" : "circle.dashed")
                .foregroundStyle(isConfigured ? Color.green : Color.secondary)
            if isConfigured {
                if let configuredKeyId {
                    Text("현재 설정됨: Key ID \(configuredKeyId)")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                } else {
                    Text("현재 설정됨")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("아직 설정되지 않았어요")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(10)
        .background(Color.secondary.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private var guideBox: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("설정 방법")
                .font(.headline)
            step(1, "App Store Connect → 「사용자 및 액세스」 → 「통합」 → 「App Store Connect API」 에서 키를 만드세요 (역할: App Manager)")
            step(2, "생성 직후 한 번만 받을 수 있는 .p8 키 파일을 다운로드하세요")
            step(3, "아래에 Key ID·Issuer ID 를 적고 .p8 파일을 선택한 뒤 「저장」 → 「검증」 으로 확인하세요")
            Link(destination: URL(string: "https://appstoreconnect.apple.com/access/integrations/api")!) {
                Label("App Store Connect API 키 페이지 열기", systemImage: "arrow.up.right.square")
                    .font(.callout)
            }
            .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.accentColor.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func step(_ n: Int, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("\(n)")
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(.white)  // design-lint: allow — accent 배경 위 단계 번호, Mac 은 onAccent 토큰 부재라 흰색 고정 정상
                .frame(width: 18, height: 18)
                .background(Circle().fill(Color.accentColor))
            Text(text)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Key ID")
                    .font(.subheadline.weight(.medium))
                // placeholder 는 «예시» 임이 분명해야 한다 — 「예:」 접두로 명시하고,
                // 실제 키처럼 보이지 않게 일반 더미 값을 쓴다 (실제 프로젝트 값 노출 금지).
                TextField("예: ABCDE12345", text: $keyId)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
                    .disableAutocorrection(true)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Issuer ID")
                    .font(.subheadline.weight(.medium))
                TextField("예: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", text: $issuerId)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
                    .disableAutocorrection(true)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("비밀키 (.p8)")
                    .font(.subheadline.weight(.medium))
                HStack(spacing: 8) {
                    Button {
                        showFileImporter = true
                    } label: {
                        Label("p8 파일 선택…", systemImage: "key")
                    }
                    if let pemFileName {
                        Text(verbatim: pemFileName)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    } else if isConfigured {
                        Text("저장된 키 사용 중 — 바꿀 때만 선택하세요")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("검증용 앱 (선택)")
                    .font(.subheadline.weight(.medium))
                TextField("앱 ID 또는 번들 ID (예: com.example.MyApp)", text: $verifyAppId)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
                    .disableAutocorrection(true)
                Text("적어두면 「검증」 이 이 앱의 리뷰 읽기 권한까지 확인해요.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var actions: some View {
        HStack(spacing: 10) {
            Button {
                Task { await save() }
            } label: {
                Label("저장", systemImage: "tray.and.arrow.down")
            }
            .keyboardShortcut("s")
            .disabled(isWorking)

            Button {
                Task { await verify() }
            } label: {
                Label("검증", systemImage: "checkmark.seal")
            }
            .disabled(isWorking || (!isConfigured && privateKeyPem.isEmpty))

            if isConfigured {
                Button(role: .destructive) {
                    Task { await clear() }
                } label: {
                    Label("키 삭제", systemImage: "trash")
                }
                .disabled(isWorking)
            }

            Spacer()
            if isWorking {
                ProgressView().controlSize(.small)
            }
        }
    }

    private var securityNote: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "lock.fill")
                .foregroundStyle(.secondary)
            Text("API 키는 비밀이에요 — 이 Mac 의 config.json(0600)에만 저장되고, 폰이나 QR 페어링에는 절대 들어가지 않아요.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 4)
    }

    // MARK: - Actions

    private func load() {
        statusText = nil
        Task {
            do {
                let status = try await DaemonAPI.getAscKey()
                isConfigured = status.configured
                configuredKeyId = status.keyId
                if keyId.isEmpty { keyId = status.keyId ?? "" }
                if issuerId.isEmpty { issuerId = status.issuerId ?? "" }
            } catch {
                setStatus(String(localized: "daemon 이 실행 중인지 확인하세요 (메뉴바 → 시작)"), isError: true)
            }
        }
    }

    private func save() async {
        let kid = keyId.trimmingCharacters(in: .whitespaces)
        let iss = issuerId.trimmingCharacters(in: .whitespaces)
        guard !kid.isEmpty, !iss.isEmpty else {
            setStatus(String(localized: "Key ID 와 Issuer ID 를 입력하세요"), isError: true)
            return
        }
        guard !privateKeyPem.isEmpty else {
            setStatus(String(localized: "p8 파일을 선택하세요"), isError: true)
            return
        }
        isWorking = true
        defer { isWorking = false }
        do {
            try await DaemonAPI.setAscKey(keyId: kid, issuerId: iss, privateKeyPem: privateKeyPem)
            // 평문 키를 화면/메모리에 안 남김 — 저장 후 비움 (재저장 시 다시 선택).
            privateKeyPem = ""
            pemFileName = nil
            setStatus(String(localized: "저장됐어요 — 「검증」 으로 실제 호출을 확인하세요"), isError: false)
            load()
        } catch {
            setStatus((error as? LocalizedError)?.errorDescription ?? "\(error)", isError: true)
        }
    }

    private func verify() async {
        isWorking = true
        defer { isWorking = false }
        do {
            // 파일을 새로 골라뒀으면 저장 전 그 키 후보로 검증, 아니면 저장된 키로.
            let result = try await DaemonAPI.verifyAscKey(
                appId: verifyAppId.trimmingCharacters(in: .whitespaces),
                keyId: privateKeyPem.isEmpty ? nil : keyId.trimmingCharacters(in: .whitespaces),
                issuerId: privateKeyPem.isEmpty ? nil : issuerId.trimmingCharacters(in: .whitespaces),
                privateKeyPem: privateKeyPem.isEmpty ? nil : privateKeyPem
            )
            if let appName = result.appName, let count = result.reviewCount {
                setStatus(String(localized: "검증 성공 — \(appName) 리뷰 \(count)개 읽기 가능"), isError: false)
            } else {
                setStatus(String(localized: "검증 성공 — ASC API 호출이 정상이에요"), isError: false)
            }
        } catch {
            setStatus((error as? LocalizedError)?.errorDescription ?? "\(error)", isError: true)
        }
    }

    private func clear() async {
        isWorking = true
        defer { isWorking = false }
        do {
            try await DaemonAPI.deleteAscKey()
            privateKeyPem = ""
            pemFileName = nil
            keyId = ""
            issuerId = ""
            setStatus(String(localized: "키를 삭제했어요 — 스토어 리뷰 수집이 중단돼요"), isError: false)
            load()
        } catch {
            setStatus((error as? LocalizedError)?.errorDescription ?? "\(error)", isError: true)
        }
    }

    private func setStatus(_ text: String, isError: Bool) {
        statusText = text
        statusIsError = isError
    }
}
