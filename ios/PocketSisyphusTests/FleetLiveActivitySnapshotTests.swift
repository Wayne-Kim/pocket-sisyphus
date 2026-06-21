import SwiftUI
import Testing
import UIKit

// 「에이전트 함대」 Live Activity 의 «순수 SwiftUI 표현»(FleetLiveActivityViews.swift)을 실제
// 코드 그대로 ImageRenderer 로 PNG 스냅샷 떠서, 시뮬레이터 잠금화면을 띄우지 않고도 «레이아웃을
// 눈으로» 검증한다 (CLAUDE.md 의 레이아웃 변경 검증 절차). 다크/라이트 둘 다 출력해 대비를 확인한다.
//
// iOS 시뮬레이터는 호스트(macOS) 파일시스템을 그대로 보므로, 절대경로 /tmp/fleet-snapshots/ 에
// 쓰면 Mac 에서 바로 읽을 수 있다. 에이전트가 이 PNG 들을 읽어 보고에 첨부한다.
@MainActor
@Suite("FleetLiveActivity 스냅샷 (PNG)")
struct FleetLiveActivitySnapshotTests {

    private static let outDir = "/tmp/fleet-snapshots"

    @Test("잠금화면/다이내믹아일랜드 표현을 라이트·다크 PNG 로 렌더")
    func renderAll() throws {
        try? FileManager.default.createDirectory(
            atPath: Self.outDir, withIntermediateDirectories: true)

        // 1) 혼합 — 대기 2·실행 3·완료 4(오류 1), 시급=대기 세션 한 줄.
        let mixed = FleetActivityAttributes.ContentState(
            waiting: 2, running: 3, done: 4, errors: 1,
            urgentSessionId: "abc", urgentRepoName: "pocket-sisyphus",
            urgentTitle: "Live Activity 구현", urgentIsWaiting: true)

        // 2) 실행만 — 대기 0·실행 2·완료 1, urgent 없음 → «N개 실행 중» 일반 요약 줄.
        let runningOnly = FleetActivityAttributes.ContentState(
            waiting: 0, running: 2, done: 1, errors: 0)

        for dark in [false, true] {
            let suffix = dark ? "dark" : "light"
            try write(FleetLockScreenView(state: mixed), dark: dark, name: "lock-mixed-\(suffix)")
            try write(FleetLockScreenView(state: runningOnly), dark: dark, name: "lock-running-\(suffix)")
            // 다이내믹 아일랜드 compact 한 쌍(대기 accent + 실행 success)을 캡슐 위에 얹어 눈으로 확인.
            try write(compactStrip(mixed), dark: dark, name: "di-compact-\(suffix)")
        }

        // 산출 확인 — 6장.
        let files = try FileManager.default.contentsOfDirectory(atPath: Self.outDir)
            .filter { $0.hasSuffix(".png") }
        #expect(files.count >= 6)
    }

    /// 다이내믹 아일랜드 compact 미리보기 — 검정 알약 위에 leading/trailing 배지.
    private func compactStrip(_ state: FleetActivityAttributes.ContentState) -> some View {
        HStack {
            FleetCompactBadge(kind: .waiting, count: state.waiting)
            Spacer()
            FleetCompactBadge(kind: .running, count: state.running)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(width: 180)
        .background(Capsule().fill(.black))
    }

    private func write(_ view: some View, dark: Bool, name: String) throws {
        let renderer = ImageRenderer(content:
            view
                .frame(width: 320, alignment: .leading)
                .background(dark ? Color.black : Color.white)
                .environment(\.colorScheme, dark ? .dark : .light)
        )
        renderer.scale = 3
        let img = renderer.uiImage
        #expect(img != nil, "ImageRenderer 가 nil (name=\(name))")
        guard let data = img?.pngData() else { return }
        let path = "\(Self.outDir)/\(name).png"
        try data.write(to: URL(fileURLWithPath: path))
    }
}
