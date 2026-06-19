import SwiftUI

/// 모니터 미러링 시트 — Mac 데스크톱을 폰에서 라이브로 보고(screen_capture_v1), 제어
/// (remote_control_v1)한다. 세션 무관(캡처는 Mac 화면 전체)이라 세션 목록·채팅방 양쪽에서 연다.
/// (옛 «결과» 시트의 웹 미리보기는 폐지, 산출물은 파일 탐색기로 분리 — 이제 미러링 단일.)
/// NavigationStack/닫기 는 여기서 제공하고 본문은 RemoteScreenView 가 채운다.
struct MonitorMirrorView: View {
    /// 세션과 무관한 진입(세션 목록 등)에서 쓰는 합성 세션 id. 캡처는 Mac 화면 전체라 세션이
    /// 필요 없고, daemon 은 sessionId 를 라우팅 키로만 쓰므로(존재 검증 안 함) 고정 키 하나면
    /// 충분하다 — UUID 와 충돌하지 않는 값.
    static let desktopSessionId = "__desktop__"

    let sessionId: String
    let api: ApiClient
    let conn: ConnectionManager
    /// 원격 제어(remote_control_v1) 지원 — «제어» 토글 노출 게이트.
    let canControl: Bool
    /// H.264 화면 릴레이(screen_h264_v1) 지원 — 미러링 코덱 협상(없으면 jpeg 폴백).
    let supportsH264: Bool
    /// 창 단위 캡처 대상(screen_window_target_v1) 지원 — «캡처 대상» 피커 노출 게이트.
    var supportsWindowTarget: Bool = false
    /// «캡처/녹화 → 채팅 첨부» 수신자 — 채팅방에서 열었을 때만 non-nil (ChatView 가 첨부에
    /// 누적하고 미러링이 닫히면 첨부 시트를 연다). 세션 목록 진입/구 daemon 은 nil → 버튼 숨김.
    var onCaptured: (([AttachmentDraft]) -> Void)? = nil
    /// «단발 캡처 → 마크업 → 화면 피드백 첨부» 수신자 — onCaptured 와 함께 주입된다(채팅방 진입).
    var onFeedback: ((FileReferenceDraft) -> Void)? = nil

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            RemoteScreenView(sessionId: sessionId, api: api, conn: conn, canControl: canControl, supportsH264: supportsH264, supportsWindowTarget: supportsWindowTarget, onCaptured: onCaptured, onFeedback: onFeedback)
                .navigationTitle("모니터 미러링")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("닫기") { dismiss() }
                    }
                }
        }
    }
}
