import SwiftUI

/// 설정 → 「기기」. 이 Mac 에 인증된 기기들을 폰에서 직접 보고 관리한다 — Mac 앱 설정 「기기」
/// 탭과 «같은» daemon 라우트(`/api/admin/*`)를 X-PS-Attest 토큰으로 호출한다.
///
/// ## 왜 폰에도 있나 (외부서버 0 모델)
/// '폰이 곧 제어판' 인데 기기 신뢰 관리만 Mac 전용이면 비대칭이다. 이 화면이 그 둘을 메운다:
///   ① 추가 기기를 등록하려다 slot_unavailable 에 막혀도 — 여기 「추가 기기 허용」 을
///      폰에서 바로 켜고 다시 스캔하면 된다 (옛 «Mac 으로 가라» 막다른 길 제거).
///   ② 기기를 분실하면 — 남은 폰에서 그 기기를 즉시 해제(revoke)해 보안 대응을 폰에서 끝낸다.
///
/// ## «이 기기» 판정
/// daemon `attestKeyFingerprint` 와 `DeviceAttestor.publicKeyFingerprint()` 가 같은 포맷
/// ("SHA256:...") 이라 1:1 비교로 현재 폰을 가려내 「이 기기」 배지를 단다. 자기 자신을
/// 해제하면 이 폰의 페어링이 풀리므로 — daemon revoke 직후 로컬 `auth.clear()` 로 즉시
/// 잠금/스캔 화면으로 보낸다.
///
/// ## 일괄 해제(rotate-pairing)는 폰에 두지 않는다
/// Mac 의 «모든 기기 해제 + 새 QR» 은 토큰·onion·SSH 키까지 회전해 이 폰 자신이 즉시 끊기고,
/// 재연결하려면 Mac 화면의 새 QR 을 다시 스캔해야 한다 — '폰만으로 끝낸다' 는 전제와 충돌한다.
/// 폰에서는 개별 해제 + 슬롯 토글만 제공한다.
struct DevicesView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker

    @State private var info: ApiClient.DeviceInfoResponse?
    @State private var loadError: String?
    @State private var loading = true
    /// 토글의 표시 상태 — info 로드 시 동기화, 사용자가 만지면 낙관적 갱신 후 실패 시 되돌림.
    @State private var extraSlotOn = false
    @State private var slotBusy = false
    @State private var busy = false
    /// 해제 확인 중인 기기 (nil = 확인 알럿 닫힘).
    @State private var revokeTarget: ApiClient.DeviceInfoResponse.Device?
    @State private var actionResult: String?
    /// 이 폰의 SE 공개키 지문 — load() 에서 한 번 캐시(키체인 접근 최소화). 시뮬레이터(SE 없음)는 nil.
    @State private var myFingerprint: String?

    var body: some View {
        List {
            if loading {
                Section {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("불러오는 중…").foregroundStyle(.secondary)
                    }
                }
            } else if let loadError {
                Section {
                    Text(loadError)
                        .font(.callout)
                        .foregroundStyle(Theme.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else if let info {
                if info.enrolled {
                    ForEach(Array(info.devices.enumerated()), id: \.element.id) { idx, device in
                        deviceSection(device, index: idx, sshFingerprint: info.sshClientKeyFingerprint)
                    }
                    slotSection(info)
                } else {
                    notEnrolledSection
                }
            }

            if let actionResult {
                Section {
                    Text(actionResult)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .navigationTitle("기기")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        // 해제 확인 — 제목은 공통, 본문이 «이 기기» / 다른 기기에 따라 달라진다.
        .alert(
            "기기를 해제할까요?",
            isPresented: revokeAlertPresented,
            presenting: revokeTarget
        ) { device in
            Button("기기 해제", role: .destructive) { Task { await revoke(device) } }
            Button("취소", role: .cancel) { revokeTarget = nil }
        } message: { device in
            if isCurrent(device) {
                Text("이 폰의 페어링이 풀려 잠금 화면(QR 스캔)으로 돌아갑니다. 다시 연결하려면 Mac의 페어링 QR을 다시 스캔하세요. 다른 기기는 그대로 유지돼요.")
            } else {
                Text("해제하면 그 기기의 인증만 무효화돼요. 이 폰은 그대로 유지됩니다. 그 기기를 다시 쓰려면 거기서 다시 페어링해야 해요.")
            }
        }
    }

    private var revokeAlertPresented: Binding<Bool> {
        Binding(
            get: { revokeTarget != nil },
            set: { if !$0 { revokeTarget = nil } })
    }

    private func isCurrent(_ device: ApiClient.DeviceInfoResponse.Device) -> Bool {
        guard let mine = myFingerprint, let fp = device.attestKeyFingerprint else { return false }
        return mine == fp
    }

    /// 등록된 기기 1대 — 등록/마지막 접속/지문 + 해제 버튼. 헤더에 「이 기기」/「인증됨」 배지.
    @ViewBuilder
    private func deviceSection(
        _ device: ApiClient.DeviceInfoResponse.Device, index: Int, sshFingerprint: String?
    ) -> some View {
        let current = isCurrent(device)
        Section {
            infoRow(label: Text("등록"), value: Self.formatDate(device.registeredAt))
            infoRow(
                label: Text("마지막 접속"),
                value: device.lastSeen != nil
                    ? Self.formatDate(device.lastSeen)
                    : String(localized: "이번 부팅 후 기록 없음"))
            if let fp = device.attestKeyFingerprint {
                fingerprintRow(label: Text("기기 키 지문"), value: fp)
            }
            if let fp = sshFingerprint {
                fingerprintRow(label: Text("SSH 키 지문"), value: fp)
            }
            Button(role: .destructive) {
                revokeTarget = device
            } label: {
                if current {
                    Label("이 폰 연결 해제", systemImage: "lock.open")
                } else {
                    Label("이 기기 해제", systemImage: "xmark.shield")
                }
            }
            .disabled(busy || slotBusy || device.attestKeyFingerprint == nil)
        } header: {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.seal.fill").foregroundStyle(Theme.success)
                Text("기기 \(index + 1)")
                if current {
                    Text("이 기기")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Theme.accent.opacity(0.18))
                        .foregroundStyle(Theme.accent)
                        .clipShape(Capsule())
                        .textCase(nil)
                }
                Spacer()
                Text("인증됨")
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Theme.success.opacity(0.18))
                    .foregroundStyle(Theme.success)
                    .clipShape(Capsule())
                    .textCase(nil)
            }
        }
    }

    /// «추가 기기 허용» 토글 — 기본 꺼짐. 켜야 1대를 넘는 기기가 페어링 가능(slot_unavailable 해소).
    @ViewBuilder
    private func slotSection(_ info: ApiClient.DeviceInfoResponse) -> some View {
        Section {
            Toggle(isOn: slotBinding) {
                Label("추가 기기 허용", systemImage: "iphone.badge.plus")
            }
            .disabled(slotBusy || busy)
        } footer: {
            Text("켜면 기기를 최대 \(info.maxSlots)대까지 연결할 수 있어요. 현재 \(info.devices.count)대 연결됨. 끄려면 먼저 기기를 한 대만 남겨 두세요.")
        }
    }

    /// 토글 바인딩 — 사용자가 만지면 낙관적으로 갱신하고 daemon 에 반영, 실패 시 되돌림.
    private var slotBinding: Binding<Bool> {
        Binding(
            get: { extraSlotOn },
            set: { newValue in
                let previous = extraSlotOn
                extraSlotOn = newValue
                Task { await applySlot(newValue, previous: previous) }
            })
    }

    /// 아직 기기 인증이 등록되지 않은 상태(시뮬레이터 dev 페어링 / 옛 폰 / 미등록) 안내.
    private var notEnrolledSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.shield").foregroundStyle(.secondary)
                    Text("아직 기기 인증이 설정되지 않았어요").font(.headline)
                }
                Text("이 폰을 최신 버전으로 업데이트하고 다시 페어링하면, 인증된 기기만 이 Mac 에 접근하도록 잠겨요. 그 전까지는 페어링 정보를 가진 기기가 접근할 수 있어요.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 4)
        }
    }

    private func infoRow(label: Text, value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            label.foregroundStyle(.secondary)
            Spacer()
            Text(verbatim: value)
                .font(.callout.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }

    private func fingerprintRow(label: Text, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            label.font(.caption).foregroundStyle(.secondary)
            Text(verbatim: value)
                .font(.caption2.monospaced())
                .textSelection(.enabled)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @MainActor
    private func load() async {
        loading = true
        loadError = nil
        defer { loading = false }
        myFingerprint = DeviceAttestor.publicKeyFingerprint()
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            let fetched = try await api.deviceInfo()
            info = fetched
            extraSlotOn = fetched.extraSlotAllowed
        } catch {
            if ApiError.isCancellation(error) { return }
            loadError = String(localized: "기기 정보를 불러오지 못했어요 — Mac 앱이 실행 중인지 확인하세요")
        }
    }

    /// 추가 기기 슬롯 토글 적용. 1대를 넘게 등록된 상태에서 끄려 하면 daemon 이 거절 → 표시 되돌림.
    @MainActor
    private func applySlot(_ allowed: Bool, previous: Bool) async {
        slotBusy = true
        actionResult = nil
        defer { slotBusy = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            try await api.setExtraDeviceSlot(allowed: allowed)
            await load()
        } catch ApiError.httpStatus(409, let body) where body.contains("remove_extra_device_first") {
            extraSlotOn = previous  // 되돌림
            actionResult = String(localized: "끄기 전에 먼저 기기를 한 대만 남겨 두세요.")
        } catch {
            extraSlotOn = previous
            let detail = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            actionResult = String(localized: "설정 변경 실패: \(detail)")
        }
    }

    /// 기기 1대 해제(revoke). 다른 기기면 나머지는 유지하고 목록 갱신. 자기 자신이면 로컬
    /// 페어링까지 정리해(`auth.clear()`) 즉시 잠금/스캔 화면으로 — 현재 토큰은 호출 시점엔
    /// 아직 유효해 revoke 가 성공하고, 그 직후 무효화되므로 로컬도 같이 비워 어긋남을 막는다.
    @MainActor
    private func revoke(_ device: ApiClient.DeviceInfoResponse.Device) async {
        revokeTarget = nil
        guard let fp = device.attestKeyFingerprint else { return }
        let current = isCurrent(device)
        busy = true
        actionResult = nil
        defer { busy = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            try await api.revokeDevice(fingerprint: fp)
            if current {
                // 이 폰 자신을 해제 — 로컬 페어링 정리 → AppRoot 가 auth.config==nil 을 감지해
                // PairView(QR 스캐너)로 재라우팅하며 이 설정 시트도 함께 사라진다.
                auth.clear()
                return
            }
            actionResult = String(localized: "기기를 해제했어요.")
            await load()
        } catch ApiError.httpStatus(404, let body) where body.contains("device_not_found") {
            // 이미 해제된 지문 — 목록만 새로 고쳐 동기화.
            actionResult = String(localized: "이미 해제된 기기예요.")
            await load()
        } catch {
            let detail = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            actionResult = String(localized: "해제 실패: \(detail)")
        }
    }

    /// epoch ms → 사용자 로케일 medium 날짜+시각. nil 이면 "—".
    private static func formatDate(_ ms: Int64?) -> String {
        guard let ms else { return "—" }
        let date = Date(timeIntervalSince1970: Double(ms) / 1000.0)
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f.string(from: date)
    }
}
