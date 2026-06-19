import SwiftUI
import UIKit

/// 세션을 «외부로 자랑/공유» 하는 동선의 부속들.
///
/// 경쟁 바이브코딩 도구의 성장 레버는 인앱 피드가 아니라 «만든 결과를 즉시 외부로 공유» 하는
/// 흐름이다. 우리는 커뮤니티를 자체 구축하지 않고, 사용자가 이미 모여 있는 외부 채널
/// (X·Reddit·Discord·메신저) 로 내보낸다 — 채널을 «소유» 하지 않으므로 «두 앱 외부 인프라 0»
/// (서버·릴레이 0) 원칙을 깨지 않는다. 전적으로 OS 의 공유시트 인프라만 쓴다.

/// 시스템 공유시트(`UIActivityViewController`) 의 SwiftUI 래퍼.
/// 프리뷰 스크린샷(UIImage) + 세션 요약 텍스트(String) 를 한 번에 `activityItems` 로 실어,
/// 사용자가 고른 외부 앱으로 내보낸다. 스냅샷 캡처가 비동기(takeSnapshot 콜백)라 캡처가 끝난 뒤
/// payload 를 만들어 `.sheet(item:)` 으로 띄우는 패턴과 맞물린다.
struct ActivityShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// 공유시트에 실을 묶음 — 캡처된 프리뷰 스크린샷 + 동봉 카피. `.sheet(item:)` 용 Identifiable.
struct SessionSharePayload: Identifiable {
    let id = UUID()
    let text: String
    let image: UIImage
}

/// 세션을 외부 앱에 자랑/공유할 때 동봉하는 기본 카피.
/// - 세션 제목(있으면) → 받는 사람이 «무엇을 만들었는지» 한 줄로 본다 (사용자 콘텐츠라 비번역).
/// - 제품명 + App Store 링크 → 성장 레버. 받은 사람이 곧장 앱으로 올 수 있다.
///
/// 자체 백엔드/로그인/피드 없음 — 이 문자열은 OS 공유시트로만 나간다.
func sessionShareCopy(for session: SessionSummary) -> String {
    var lines: [String] = []
    if let title = session.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
        lines.append(title)
        lines.append("")
    }
    lines.append(String(localized: "Pocket Sisyphus 로 폰에서 코딩 에이전트로 만들었어요."))
    lines.append("https://apps.apple.com/app/pocket-sisyphus/id6772206998")
    return lines.joined(separator: "\n")
}
