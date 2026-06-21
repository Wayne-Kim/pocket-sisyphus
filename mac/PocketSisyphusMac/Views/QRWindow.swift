import SwiftUI
import AppKit

/// 별도 NSWindow로 QR을 큰 화면에 표시. 메뉴바 popover와 별개로 떠 있어야
/// 폰 카메라로 스캔하기 편함.
@MainActor
final class QRWindowController: ObservableObject {
    private var window: NSWindow?
    /// 외부에서 QR 다시 읽도록 강제하는 신호. 회전 직후 / show() 시 bump.
    /// QRWindowContent 가 .onChange 로 구독해 NSImage 를 재로드한다.
    /// 메모리에 캐시된 옛 NSImage 가 그대로 남는 문제 — 회전 후 daemon 이 같은
    /// 경로(pair-qr.png) 에 새 PNG 를 덮어쓰지만 SwiftUI 가 자동 재로드하지 않음.
    @Published var reloadToken = UUID()

    func show() {
        // 이미 떠 있어도, 새로 열어도 항상 신선한 QR 이 보이도록 reload 신호.
        reloadToken = UUID()
        if let w = window {
            w.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let content = QRWindowContent(controller: self)
        let host = NSHostingController(rootView: content)
        let w = NSWindow(contentViewController: host)
        w.title = String(localized: "Pocket Sisyphus — 페어링 QR")
        w.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        w.setContentSize(NSSize(width: 480, height: 580))
        w.center()
        w.isReleasedWhenClosed = false
        window = w
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// 페어링 회전 등 외부 트리거로 QR PNG 가 바뀌었을 때 호출.
    /// 창이 열려 있으면 즉시 재로드, 닫혀 있으면 다음 show() 에서 어차피 새로 읽음.
    func reload() {
        reloadToken = UUID()
    }

    func close() {
        window?.close()
    }
}

private struct QRWindowContent: View {
    @ObservedObject var controller: QRWindowController
    @State private var image: NSImage?
    @State private var error: String?
    // 페어링 값 회전 진행 중 — 버튼 중복 클릭 방지. confirm/result 는 NSAlert (이 창은
    // 진짜 NSWindow 라 popover 자동닫힘 문제는 없지만 메뉴 회전과 동일 UX 유지).
    @State private var rotateInProgress = false

    var body: some View {
        VStack(spacing: 16) {
            Text("페어링 QR")
                .font(.title2.weight(.semibold))
            Text("iPhone PocketSisyphus 앱 → QR 스캔으로 페어링")
                .font(.callout)
                .foregroundStyle(.secondary)

            // 기기 슬롯 안내 — 기본은 1대만 등록 가능. 기기를 더 연결하려면 설정 「기기」
            // 탭에서 «추가 기기 허용» 을 켜야 한다. 안 켜진 상태에서 두 번째 폰이 스캔하면
            // 폰 쪽이 «연결 준비 중» 에서 멈춘 것처럼 보여 혼란스럽다 — 스캔 «전» 에 미리 알린다.
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "iphone")
                Text("기본은 한 대만 연결돼요. 기기를 더 연결하려면 설정 → 「기기」 탭에서 «추가 기기 허용» 을 먼저 켜세요. (기기는 최대 세 대까지.)")
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.1)))

            ZStack {
                Color.white
                if let img = image {
                    Image(nsImage: img)
                        .resizable()
                        .interpolation(.none)
                        .scaledToFit()
                        .padding(8)
                } else if let err = error {
                    Text(err).foregroundStyle(.red).padding()
                } else {
                    ProgressView()
                }
            }
            .frame(width: 400, height: 400)
            .cornerRadius(12)

            Divider().padding(.vertical, 2)

            // 페어링 값 회전 — 옛 QR 즉시 무효 + 이 창의 QR 을 새 값으로 교체. QR 가 외부에
            // 노출됐다고 의심될 때 사용. (옛 메뉴바의 「페어링 값 바꾸기」 를 여기로 통합.)
            Button {
                Task { @MainActor in
                    guard confirmRotate() else { return }
                    await performRotate()
                }
            } label: {
                Label("페어링 값 바꾸기…", systemImage: "arrow.triangle.2.circlepath")
            }
            .disabled(rotateInProgress)

            Text("새 onion·토큰·client-auth 키를 발급하고 이 QR 을 교체합니다. 옛 QR 로 페어링된 기기는 다시 스캔해야 해요.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(20)
        .onAppear { refresh() }
        // macOS 13 호환: 단일 파라미터 onChange. macOS 14+ 의 2-param 형태와
        // 다르지만 동작은 동일 — token 이 바뀔 때 refresh.
        .onChange(of: controller.reloadToken) { _ in refresh() }
    }

    private func refresh() {
        let path = DaemonPaths.pairQRFile
        if let img = NSImage(contentsOf: path) {
            image = img
            error = nil
        } else {
            image = nil
            error = String(localized: "QR 파일 없음 — daemon이 부팅을 마쳤는지 확인하세요\n(\(path.path))")
        }
    }

    // MARK: - 페어링 값 회전 (옛 MenuContent 에서 이전)

    @MainActor
    private func confirmRotate() -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = String(localized: "페어링 값을 바꿀까요?")
        alert.informativeText = String(localized: "새 onion 주소 + 새 token + 새 client-auth 키가 발급됩니다. 옛 QR 은 즉시 무효 — 폰 앱에서 새 QR 을 다시 스캔해야 합니다. 다른 모든 클라이언트 연결도 끊깁니다.")
        alert.alertStyle = .warning
        alert.addButton(withTitle: String(localized: "바꾸기"))
        alert.addButton(withTitle: String(localized: "취소"))
        return alert.runModal() == .alertFirstButtonReturn
    }

    @MainActor
    private func performRotate() async {
        rotateInProgress = true
        defer { rotateInProgress = false }
        do {
            let onion = try await DaemonAPI.rotatePairing()
            // 새 pair-qr.png 를 이 창에 즉시 재로드.
            controller.reload()
            showRotateSuccess(onion: onion)
        } catch {
            let msg = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            showRotateFailure(message: msg)
        }
    }

    @MainActor
    private func showRotateSuccess(onion: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = String(localized: "페어링 값 교체 완료")
        alert.informativeText = String(localized: "새 onion: \(onion.prefix(20))…\n페어링 QR 창에서 새 QR 을 스캔하세요.")
        alert.alertStyle = .informational
        alert.addButton(withTitle: String(localized: "닫기"))
        _ = alert.runModal()
    }

    @MainActor
    private func showRotateFailure(message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = String(localized: "교체 실패")
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: String(localized: "닫기"))
        _ = alert.runModal()
    }
}
