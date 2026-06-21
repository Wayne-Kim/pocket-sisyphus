import Foundation

/// 사용자가 한 세션에서 보낸 (또는 보내려고 시도한) 메시지 한 건.
///
/// 왜 별도로 저장하는가:
/// - 우리 트래픽은 Tor onion 위에서 흐르는데, 회로가 불안정한 순간엔 send 자체가
///   네트워크 오류로 끝나고 `ChatViewModel.send` 가 낙관적 말풍선을 회수한다.
///   즉 *서버에 도달 못 한 메시지는 화면에서 사라진다.* 사용자가 가장 짜증나는 케이스.
/// - «터미널 강제 재시작» 을 누르면 vm.items 가 비워지고 그동안 친 명령도 함께 증발한다.
///   재사용/복사용 텍스트는 서버 컨텍스트와 별개 가치라 같이 죽으면 안 된다.
///
/// 그래서 send 시도 전에 무조건 디스크에 한 줄 박아두고, echo 가 도착하면 `delivered`
/// 로 승격, 실패하면 `failed` 로 마킹한다. 사용자는 시트나 길게 누르기로 언제든
/// 복사·재전송할 수 있다.
struct SentMessage: Identifiable, Codable, Equatable, Hashable {
    /// 로컬 UUID — 낙관적 말풍선의 id 와 동일하다 (`local-<uuid>` 형식이 아니라 순수 UUID).
    /// echo 시점에 서버 message id 와 매핑하기 위해 `serverId` 를 별도로 둔다.
    let id: String
    let sessionId: String
    let text: String
    /// 로컬 시각(epoch ms). 표시용으로만 쓰고 정렬 키로도 쓴다.
    let sentAt: Int64
    /// 서버가 echo 해준 message row id. 도달 확인되면 채워진다.
    var serverId: String?
    var status: Status

    enum Status: String, Codable {
        /// send POST 가 시작됐고 아직 echo 가 안 옴 — 결과 모름.
        case pending
        /// 서버가 user_message 를 echo 해서 도달이 확인된 상태.
        case delivered
        /// send 자체가 throw — Tor 끊김 / 데몬 응답 X 등. 사용자가 재전송 후보로 쓰기 좋음.
        case failed
        /// 「임시저장」 — 사용자가 채팅방에서 무언가를 쳤지만 보내기 전에 화면을 떠난 경우.
        /// onDisappear 가 input.trimmed 가 비어있지 않으면 store 에 한 건 박는다. 세션당
        /// 1개만 유지 (saveDraft 가 기존 .draft 들을 제거). 사용자는 시트에서 «입력창에
        /// 채우기» 로 다시 가져다 쓸 수 있다.
        case draft
    }
}
