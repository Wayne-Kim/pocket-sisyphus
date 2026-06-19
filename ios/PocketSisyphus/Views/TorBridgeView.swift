import SwiftUI

/// 「Tor bridge」 설정 화면 — SettingsSheet 의 NavigationLink 와 차단 진단 카드에서 진입.
///
/// 평문 Tor 가 막힌 네트워크(학교·회사·일부 국가)에서 onion fallback 을 살리는 **선택형** 우회.
/// bridge line(특히 obfs4) 을 붙여넣어 저장하면, 평문 Tor 부트스트랩이 정체될 때 `TorManager` 가
/// 자동으로 bridge 경유로 재시도한다. 미설정 사용자에겐 아무 영향이 없다(평문 우선·실패 시에만).
struct TorBridgeView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var tor: TorManager
    @EnvironmentObject var bridges: TorBridgeStore

    /// 진단 카드에서 시트로 띄울 때 «닫기» 를 노출하기 위한 플래그. NavigationLink push 시엔 false.
    var asSheet: Bool = false
    @Environment(\.dismiss) private var dismiss

    @State private var draft: String = ""
    @State private var reconnecting = false

    private var parsed: (valid: [TorBridgeLine], invalid: [String]) { TorBridgeParser.parse(draft) }
    private var dirty: Bool { draft != bridges.linesText }
    private var hasObfs4: Bool { parsed.valid.contains { $0.transportLower == "obfs4" } }

    var body: some View {
        List {
            // 켜기/끄기 — 꺼져 있으면 fallback 자체가 일어나지 않는다.
            Section {
                Toggle(isOn: $bridges.enabled) {
                    Label("Tor bridge 사용", systemImage: "shield.lefthalf.filled")
                }
            } footer: {
                Text("켜면 평문 Tor 연결이 막혔을 때 아래 bridge 를 거쳐 자동으로 다시 시도해요. 평문 Tor 가 잘 되는 환경에선 bridge 를 쓰지 않습니다(평문 우선).")
            }

            // 상태 — bridge 경유 연결 결과.
            Section {
                statusRow
            } header: {
                Text("상태")
            }

            // bridge line 입력.
            Section {
                TextEditor(text: $draft)
                    .font(.system(.footnote, design: .monospaced))
                    .frame(minHeight: 120)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)

                validationRow

                if !TorBridgeStore.builtInObfs4Bridges.isEmpty {
                    Button {
                        let joined = TorBridgeStore.builtInObfs4Bridges.joined(separator: "\n")
                        draft = draft.isEmpty ? joined : draft + "\n" + joined
                    } label: {
                        Label("내장 기본 bridge 추가", systemImage: "plus.rectangle.on.rectangle")
                    }
                }

                if dirty {
                    Button {
                        bridges.linesText = draft
                    } label: {
                        Label("저장", systemImage: "tray.and.arrow.down")
                    }
                }
            } header: {
                Text("bridge 라인")
            } footer: {
                bridgeLineFooter
            }

            // 적용/테스트 — 저장된 bridge 로 다시 연결을 시도한다.
            Section {
                Button {
                    Task { await reconnect() }
                } label: {
                    HStack {
                        Label("저장하고 다시 연결", systemImage: "arrow.clockwise")
                        if reconnecting {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(reconnecting || (!bridges.enabled))
            } footer: {
                Text("평문 Tor 를 먼저 시도하고, 막혀 있으면 bridge 경유로 자동 전환합니다. bridge 경유는 평문 Tor 보다 느릴 수 있어 라이브 프리뷰·미러가 더 거칠 수 있어요.")
            }

            // obfs4 PT 번들 여부 안내 — 미링크 빌드에서는 obfs4 라인이 동작하지 않는다.
            if hasObfs4 && !PluggableTransport.shared.isAvailable {
                Section {
                    Label {
                        Text("이 빌드에는 obfs4 전송이 포함되어 있지 않아요. obfs4 bridge 는 동작하지 않으며, 전송 없는(vanilla) bridge 만 시도됩니다.")
                            .font(.footnote)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.warning)
                    }
                }
            }
        }
        .navigationTitle("Tor bridge")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if asSheet {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("닫기") { dismiss() }
                        .tint(Color.primary)
                }
            }
        }
        .onAppear { if draft.isEmpty { draft = bridges.linesText } }
    }

    // MARK: - 상태 행

    @ViewBuilder
    private var statusRow: some View {
        switch bridges.status {
        case .idle:
            Label {
                (tor.torLikelyBlocked
                     ? Text("Tor 가 막힌 것 같아요 — bridge 설정 후 다시 연결해 보세요")
                     : Text("아직 bridge 를 쓰지 않았어요"))
                    .font(.callout)
            } icon: {
                Image(systemName: tor.torLikelyBlocked ? "wifi.exclamationmark" : "minus.circle")
                    .foregroundStyle(tor.torLikelyBlocked ? Theme.warning : Color.secondary)
            }
        case .connecting:
            Label {
                Text("bridge 경유로 연결 중…").font(.callout)
            } icon: {
                ProgressView().controlSize(.small)
            }
        case .connected:
            Label {
                Text("bridge 경유로 연결됨").font(.callout)
            } icon: {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.success)
            }
        case .failed(let reason):
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text("bridge 연결 실패").font(.callout)
                    Text(verbatim: reason).font(.caption2).foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: "xmark.octagon.fill").foregroundStyle(Theme.danger)
            }
        }
    }

    // MARK: - 검증 표시

    @ViewBuilder
    private var validationRow: some View {
        let valid = parsed.valid.count
        let invalid = parsed.invalid.count
        let unsupported = TorBridgeParser.parse(draft).valid
            .compactMap { $0.transportLower }
            .filter { $0 != "obfs4" }
        HStack(spacing: 10) {
            if valid > 0 {
                Label {
                    Text("유효 \(valid)개").font(.caption)
                } icon: {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.success)
                }
            }
            if invalid > 0 {
                Label {
                    Text("형식 오류 \(invalid)개").font(.caption)
                } icon: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.danger)
                }
            }
            Spacer()
        }
        if !unsupported.isEmpty {
            // obfs4 외 전송은 이번 스코프에서 미지원 — 식별자라 verbatim.
            Text("지원하지 않는 전송: \(unsupported.joined(separator: ", "))")
                .font(.caption2)
                .foregroundStyle(Theme.warning)
        }
    }

    @ViewBuilder
    private var bridgeLineFooter: some View {
        // 예시는 식별자/문법이라 번역 대상 아님 → verbatim.
        VStack(alignment: .leading, spacing: 4) {
            Text("한 줄에 하나씩 붙여넣으세요. obfs4 또는 전송 없는(vanilla) 형식을 지원합니다. bridge 는 Tor Browser 설정이나 bridges.torproject.org 에서 받을 수 있어요.")
            Text(verbatim: "obfs4 192.0.2.1:443 FINGERPRINT cert=… iat-mode=0")
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.tertiary)
        }
    }

    // MARK: - 동작

    @MainActor
    private func reconnect() async {
        if dirty { bridges.linesText = draft }
        reconnecting = true
        defer { reconnecting = false }
        // 페어 전(차단 진단 카드 → 페어링 흐름)이면 Tor 자체를 다시 띄우고, 페어된 상태면
        // happy eyeballs 재실행(직접 채널 우선, 막히면 Tor→bridge fallback).
        if auth.config == nil {
            await tor.recoverFromFailure()
        } else {
            await conn.reconnect()
        }
    }
}

/// 「Tor 가 차단된 것 같아요」 진단 카드 — 평문 Tor 부트스트랩이 정체돼 `tor.torLikelyBlocked`
/// 가 켜졌을 때 ErrorView 에 붙는다. «Tor bridge 설정하기» 로 곧장 진입한다.
///
/// (브리프 1 의 `torLikelyBlocked` 진단 카드와 같은 진입점 — 브리프 1 이 별도 진단 UI 를
/// 도입하면 `tor.torLikelyBlocked` 시그널을 그대로 재사용하면 된다.)
struct TorBlockedDiagnosticCard: View {
    @EnvironmentObject var bridges: TorBridgeStore
    @State private var showBridges = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "wifi.exclamationmark")
                    .foregroundStyle(Theme.warning)
                Text("Tor 가 차단된 것 같아요")
                    .font(.subheadline.weight(.semibold))
            }
            Text("이 네트워크가 Tor 연결을 막고 있을 수 있어요. 학교·회사·일부 국가 네트워크에서 흔한 일이에요. Tor bridge 를 설정하면 우회할 수 있습니다.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                showBridges = true
            } label: {
                Label {
                    bridges.enabled ? Text("Tor bridge 다시 시도") : Text("Tor bridge 설정하기")
                } icon: {
                    Image(systemName: "shield.lefthalf.filled")
                }
                .font(.callout.weight(.semibold))
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .controlSize(.regular)
            .padding(.top, 2)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.l, style: .continuous)
                .fill(Theme.warning.opacity(Theme.Opacity.fill))
        )
        .padding(.horizontal, 24)
        .sheet(isPresented: $showBridges) {
            NavigationStack { TorBridgeView(asSheet: true) }
        }
    }
}
