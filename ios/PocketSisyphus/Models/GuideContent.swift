import SwiftUI

/// 한 카테고리(=한 글) 의 데이터.
///
/// LocalizedStringKey 는 SwiftUI Text init 시점에 Bundle.main 의 xcstrings 카탈로그를
/// 조회한다. 여기서는 한국어 원문이 곧 키이므로 String 으로 들고 다니다가 사용 시점에
/// LocalizedStringKey 로 감싸 Text() 에 넣는다.
struct GuideCategory: Identifiable, Equatable {
    let id: String          // deeplink 용 안정적 식별자 ("start", "approval" 등)
    let icon: String        // SF Symbol
    let titleKey: String    // 카테고리 제목 (한국어 원문 = 카탈로그 키)
    let leadKey: String     // 1줄 lead — 카테고리 리스트와 글 상단에 같이 노출
    let sections: [GuideSection]

    static func == (lhs: GuideCategory, rhs: GuideCategory) -> Bool {
        lhs.id == rhs.id
    }
}

/// 글 본문의 한 블록.
/// - paragraph: 보통 단락.
/// - bullets: 글머리 리스트 (불릿 점 + 들여쓰기).
/// - callout: 박스 강조 (정보/주의). systemImage 와 color tint 로 톤 표현.
/// - code: 등폭 코드 블록. 다국어 X — 명령어/경로 그대로 보이는 게 맞다.
enum GuideSection {
    case paragraph(String)
    case bullets([String])
    case callout(systemImage: String, tint: CalloutTint, text: String)
    case code(String)

    enum CalloutTint {
        case info       // 파란색 — 알아두면 좋은 부가 정보
        case warn       // 노란색 — 주의해야 할 동작
        case danger     // 빨간색 — 진짜 위험한 동작
        case accent     // Purple — 앱 메인 컬러 강조
        case pro        // 주황색 — 프로 기능 표시

        var color: Color {
            switch self {
            case .info:   return Theme.info
            case .warn:   return Theme.warning
            case .danger: return Theme.danger
            case .accent: return Theme.accent
            case .pro:    return Theme.pro
            }
        }
    }
}

// MARK: - 콘텐츠

/// 각 카테고리(= 한 글) 의 한국어 원문 콘텐츠.
/// 각 문자열은 그대로 Localizable.xcstrings 의 키 역할도 한다 — 9개 번역은 카탈로그에서.
enum GuideContent {
    static let all: [GuideCategory] = [start, backlog, permissions, session, approval, resume, workflow, mirror, pro, tor, language, security]

    static func find(_ id: String) -> GuideCategory? {
        all.first(where: { $0.id == id })
    }

    /// Mac 데스크탑 앱 «한 줄 설치» 명령. 페어링 화면(PairView)과 «시작하기» 가이드가
    /// 같이 보여주므로 한곳에서만 정의해 드리프트를 막는다. 명령/URL 이라 번역 대상 아님
    /// (Text(verbatim:) 로 노출). install.sh 는 공개 repo 의 raw 경로 (commit a1796db).
    static let macInstallCommand = "curl -fsSL https://raw.githubusercontent.com/Wayne-Kim/pocket-sisyphus/main/install.sh | bash"

    // MARK: 1) 시작하기
    static let start = GuideCategory(
        id: "start",
        icon: "arrow.right.circle.fill",
        titleKey: "시작하기",
        leadKey: "Mac 에서 Pocket Sisyphus 데스크탑 앱을 띄우고 모바일에서 QR 한 번 스캔하면 페어링이 끝납니다.",
        sections: [
            .paragraph("Pocket Sisyphus 는 두 가지 앱으로 구성됩니다: Mac 데스크탑 앱 (실제로 코드 에이전트 CLI 를 실행 — Claude Code / Google Antigravity / OpenAI Codex / GitHub Copilot CLI / OpenCode 등) + iPhone 앱 (이 앱, 원격 조종). 둘 다 설치해야 동작하고, iPhone 앱만으로는 아무것도 할 수 없습니다."),
            .callout(systemImage: "exclamationmark.triangle.fill", tint: .warn,
                     text: "iPhone 앱은 Mac 의 데스크탑 앱을 «원격 조종» 할 뿐, 자체적으로 코드 에이전트를 실행하지 않습니다. Mac 이 켜져 있고 데스크탑 앱이 떠 있어야 모바일에서 명령이 동작합니다."),
            .callout(systemImage: "terminal", tint: .accent,
                     text: "가장 빠른 설치 — Mac 터미널에 아래 한 줄을 붙여넣고 실행하면 최신 데스크탑 앱이 자동으로 내려받아져 설치됩니다. 아래 «1단계» 의 .dmg 수동 설치는 이게 안 될 때만 쓰세요."),
            .code(GuideContent.macInstallCommand),
            .paragraph("Mac 쪽 설치 순서:"),
            .bullets([
                "1단계 — Mac 에 Pocket Sisyphus 데스크탑 앱 (.dmg) 을 다운로드해 설치합니다. https://github.com/Wayne-Kim/pocket-sisyphus 의 Releases 에서 받아 «응용 프로그램» 으로 드래그.",
                "2단계 — 앱을 실행합니다. 메뉴바 우측에 작은 보라색 아이콘이 뜹니다. Dock 에는 안 뜹니다 — 메뉴바 상주 앱입니다.",
                "3단계 — 메뉴바 아이콘 클릭 → «페어링 QR 보기». 화면에 QR 이미지가 뜹니다.",
                "4단계 — iPhone 앱의 페어링 화면에서 그 QR 을 스캔합니다. SSH 가 닿는 환경이면 곧바로 연결, Tor fallback 환경이면 5–30초 회로 빌드 후 마무리됩니다.",
            ]),
            .paragraph("페어링 QR 안에 들어있는 항목:"),
            .bullets([
                "Onion 주소 — Mac 데스크탑 앱이 Tor hidden service 로 노출하는 주소. SSH 가 닿지 않을 때 fallback 경로로 씁니다.",
                "Daemon 토큰 — SSH 채널 안에서 daemon API 호출에 들어가는 Bearer.",
                "Endpoint 토큰 — Tor onion 위 endpoint 조회용 Bearer (control plane).",
                "Tor client-auth 키 — v3 클라이언트 인증 키. 이 키 없이는 onion 주소가 있어도 접근 불가.",
                "SSH host fingerprint — 연결 시 Mac 의 SSH host key 를 대조하는 pin (위변조 차단).",
                "SSH 클라이언트 키 — Mac sshd 에 등록된 공개키와 짝. 매 요청에 인증으로 들어갑니다.",
            ]),
            .callout(systemImage: "info.circle", tint: .info,
                     text: "QR 스캔이 잘 안 되면 Mac 메뉴바에서 «페어링 값 바꾸기» 로 새 QR 을 발급한 뒤 다시 스캔해 주세요. QR 페이로드 (특히 SSH 키와 client-auth) 가 길어 수동 입력은 지원하지 않습니다."),
            .callout(systemImage: "bolt.fill", tint: .accent,
                     text: "한 번 페어링되면 그 뒤로는 Mac 이 켜져 있고 데스크탑 앱이 떠 있는 한 어디서든 (LTE/5G 포함) iPhone 으로 명령을 보낼 수 있습니다."),
        ],
    )

    // MARK: 1-b) 백로그 (PO 루프)
    static let backlog = GuideCategory(
        id: "backlog",
        icon: "list.clipboard.fill",
        titleKey: "백로그 (PO 루프)",
        leadKey: "에이전트가 레포 신호를 모아 «기회 브리프» 를 올리고, 당신은 폰에서 승인·보류·기각만 하면 됩니다.",
        sections: [
            .paragraph("백로그는 하단 «백로그» 탭(주황)이자 이 앱이 가장 다른 점이에요. PO(프로덕트 오너) 에이전트가 레포의 신호 — 이슈·TODO 주석·문서·최근 변경 같은 — 를 스스로 모아 «다음에 뭘 하면 좋을지» 를 기회 브리프 카드로 제안하고, 당신은 그 카드를 읽고 결정만 내려요. 무엇을 만들지 일일이 적지 않아도, 에이전트가 신호를 모아 올리고 사람은 결재만 하는 흐름이에요."),
            .paragraph("브리프를 만드는 두 가지 길 — 우상단 + (만들기) 메뉴에서 고릅니다:"),
            .bullets([
                "레포 신호 수집 — 에이전트가 레포 안의 이슈·TODO·문서·변경 이력을 훑어 기회를 브리프로 모아 와요. «지금 수집» 한 번이면 끝이에요.",
                "리서치 요청 — 레포 밖 «시장 조사». 무엇을 알아볼지 주제를 적어 주면 에이전트가 조사해 브리프로 정리해요.",
            ]),
            .paragraph("전문가 관점(렌즈) — 수집·리서치를 맡길 때 «어떤 전문가의 눈으로 볼지» 를 골라, 그 관점에 맞는 기회만 모으게 할 수 있어요. 전방위(기본)로 두면 가리지 않고 두루 보고, 디자인·디버깅 같은 특정 관점을 고르면 그쪽에 집중해요. 고를 수 있는 관점은 Mac 데스크탑 앱 버전에 따라 늘어나요."),
            .paragraph("브리프 카드를 열면 문제·근거·스코프·스펙이 한눈에 정리돼 있어, 폰에서 30초 안에 판단할 수 있어요. 카드 하단에서 내릴 수 있는 결정은 네 가지예요:"),
            .bullets([
                "승인 — 곧바로 에이전트가 구현을 시작하고 세션 탭으로 이어져요. 그 자리에서 진행을 지켜볼 수 있어요.",
                "보류 — 지금은 아니지만 버리긴 아까운 제안을 잠시 미뤄 둬요.",
                "기각 — 이 제안은 종결해요. 남은 TODO 주석·죽은 코드 같은 흔적을 함께 정리하게 할 수도 있어요.",
                "수정 지시 — 티켓에 코멘트 달듯 한 줄로 방향을 일러 주면, 에이전트가 그 의견을 반영해 브리프를 다시 다듬어요. 승인 전에 끼어드는 통로예요.",
            ]),
            .callout(systemImage: "crown.fill", tint: .pro,
                     text: "백로그 탭이 주황으로 표시되는 건 «프로(고급)» 기능이라는 뜻이에요. 승인할 때 «새 worktree(별도 작업 폴더)에서 구현» 이나 «워크플로우로 구현 (자가검증 + 머지 승인)» 같은 고급 경로는 멤버십이나 영구 이용권으로 열려요 — 자세한 건 «프로 기능» 안내를 보세요."),
            .paragraph("출시 후 검증 — 승인한 제안이 구현돼 출시되면 거기서 끝이 아니라, «정말 효과가 있었는지» 를 다음 수집이 되짚어요. 같은 레포에 «레포 신호 수집» 을 다시 돌리면 에이전트가 그때 세운 가설을 신호와 대조해 결말을 매겨요. 카드의 작은 배지로 어디까지 왔는지 보여줘요:"),
            .bullets([
                "출시됨 — 구현·출시는 끝났고 검증을 기다리는 단계예요 (파란 배지, 정보 신호).",
                "검증됨 — 다음 수집이 가설이 맞았다고 확인했어요 (초록 배지, 성공 신호).",
                "빗나감 — 구현은 됐지만 노린 신호가 풀리지 않았어요 (빨간 배지, 다음 판단의 근거).",
            ]),
            .paragraph("주기 수집 — 매번 손으로 «지금 수집» 을 누르지 않아도, 수집을 정해진 주기로 자동 실행하게 둘 수 있어요 (Mac 데스크탑 앱이 지원할 때 «수집» 화면에 옵션이 나와요). 자는 동안 에이전트가 신호를 모아 두면, 아침에 폰에서 결재만 하면 돼요."),
            .callout(systemImage: "info.circle", tint: .info,
                     text: "백로그 탭은 Mac 데스크탑 앱이 PO 루프를 지원할 때만 첫 번째 탭으로 나타나요. 탭이 안 보이면 Mac 앱을 최신으로 업데이트하면 돼요. 일부 관점·옵션도 데스크탑 앱 버전에 따라 늘어나요."),
        ],
    )

    // MARK: 2) 세션
    static let session = GuideCategory(
        id: "session",
        icon: "bubble.left.and.bubble.right.fill",
        titleKey: "세션",
        leadKey: "세션은 코드 에이전트 CLI 와의 대화 단위입니다. 만들기 / 이름 변경 / 삭제.",
        sections: [
            .paragraph("한 세션은 하나의 레포 폴더와 그 안의 대화 기록(모델 컨텍스트)을 묶습니다. 새 세션을 만들 때 어느 레포에서 작업할지 골라두면, 이후 대화는 그 레포 기준으로 도구가 동작합니다."),
            .paragraph("새 세션 만들기: 우상단 + 버튼. 제목은 비워둬도 됩니다(나중에 바꿀 수 있어요). 레포 경로는 Mac 의 최근 사용 프로젝트에서 고르거나 «경로 직접 입력» 으로 적습니다."),
            .callout(systemImage: "terminal", tint: .accent,
                     text: "세션마다 사용할 코드 에이전트 CLI 를 골라둘 수 있습니다 (현재 Claude Code, Google Antigravity, OpenAI Codex, GitHub Copilot CLI, OpenCode 지원). 데스크탑 앱의 daemon 에 새 어댑터가 등록되면 픽커에 자동으로 노출돼 iOS 앱 업데이트 없이도 늘어납니다."),
            .paragraph("이름 변경: 세션 리스트에서 스와이프 → «이름 변경», 또는 채팅 화면 우상단 점 메뉴에서 «이름 변경»."),
        ],
    )

    // MARK: 3) 도구 승인
    static let approval = GuideCategory(
        id: "approval",
        icon: "checkmark.shield.fill",
        titleKey: "도구 승인",
        leadKey: "에이전트가 파일을 쓰거나 명령을 실행하기 전, 사용자에게 한 번 묻습니다.",
        sections: [
            .paragraph("모델이 Bash·Write·Edit 같은 도구를 호출하려 할 때 모바일에 승인 카드가 뜹니다. 카드에는 어떤 명령을 실행할지 / 어떤 파일을 어떻게 바꿀지 미리 보기로 보여줍니다."),
            .paragraph("선택지 세 가지:"),
            .bullets([
                "승인 — 이번 호출만 허용. 같은 도구를 또 부르면 다시 묻습니다.",
                "거부 — 이번 호출을 막습니다. 모델은 다른 방법을 모색하거나 사용자에게 다시 물어봅니다.",
                "이 세션에서 항상 승인 — 이 세션이 끝날 때까지 같은 도구는 자동 승인. 세션 범위만이라 다른 세션에는 영향이 없습니다.",
            ]),
            .paragraph("톱니바퀴 메뉴의 «도구 자동 승인» 을 켜면 모든 도구 호출이 묻지 않고 통과됩니다. 빠르지만 위험합니다."),
            .callout(systemImage: "exclamationmark.octagon.fill", tint: .danger,
                     text: "«자동 승인» 은 에이전트가 의도와 다른 파일을 쓰거나 위험한 명령을 실행해도 막지 못합니다. 모르는 레포 / 큰 변경 시엔 끄세요. 익숙한 작은 작업에만 권장합니다."),
        ],
    )

    // MARK: 4) 데스크탑 이어 받기
    static let resume = GuideCategory(
        id: "resume",
        icon: "desktopcomputer.and.arrow.down",
        titleKey: "데스크탑 이어 받기",
        leadKey: "데스크탑에서 진행 중이던 코드 에이전트 세션을 모바일로 이어 받습니다.",
        sections: [
            .paragraph("새 세션을 만들 때 레포 경로를 고르면 그 경로의 데스크탑 세션 후보가 자동으로 같이 뜹니다. 거기서 «이어 받기» 로 그 컨텍스트를 그대로 가져와 모바일에서 입력을 이어갈 수 있어요. 후보는 새 세션 시트에서 고른 CLI 도구 (예: Claude Code, Google Antigravity, OpenAI Codex, GitHub Copilot CLI, OpenCode) 기준으로 채워집니다."),
            .callout(systemImage: "info.circle", tint: .accent,
                     text: "이어 받은 뒤엔 그 세션 컨텍스트가 모바일에 묶입니다. 데스크탑에서 계속 작업할 거면 새 세션을 시작하세요."),
        ],
    )

    // MARK: 4-b) 워크플로우 (프로)
    static let workflow = GuideCategory(
        id: "workflow",
        icon: "point.3.connected.trianglepath.dotted",
        titleKey: "워크플로우",
        leadKey: "여러 에이전트 작업을 노드로 잇고 한 번에 자동 실행하는 작업 흐름입니다.",
        sections: [
            .paragraph("하단 «자동화» 탭(주황)의 «워크플로우» 세그먼트에서 캔버스에 노드를 놓고 선으로 이어 작업 흐름을 만듭니다. 시작 노드에서 출발해 작업 노드들을 거쳐 종료 노드로 끝나며, 각 작업 노드는 골라 둔 코드 에이전트가 프롬프트대로 수행합니다."),
            .bullets([
                "시작 노드(초록) — 흐름의 출발점. 수동으로 실행하거나 크론 예약 트리거를 붙일 수 있어요.",
                "작업 노드(분홍) — 에이전트가 프롬프트를 수행하는 단계. 도구와 승인 여부를 노드마다 정합니다.",
                "종료 노드(파랑) — 흐름의 끝.",
            ]),
            .paragraph("편집 — 캔버스 빈 곳을 길게 누르면 그 자리에 노드를 추가하고, 노드를 탭하면 제목·프롬프트·도구를 설정합니다. 노드 아래 출력 포트를 드래그해 다른 노드 위에 놓으면 연결돼요."),
            .paragraph("실행 — 「실행」 을 누르면 결과 보기 화면으로 바뀌어 노드별 진행 상태(실행 중·완료·실패)가 색으로 표시됩니다. 노드를 탭하면 그 노드가 만든 세션 대화로 들어가고, 승인이 필요한 노드는 탭해서 승인하거나 거부합니다."),
            .callout(systemImage: "crown.fill", tint: .pro,
                     text: "워크플로우는 프로(고급) 기능이에요. 멤버십이나 영구 이용권으로 잠금 해제하고, 처음이라면 무료 체험으로 써 볼 수 있어요 — 자세한 건 «프로 기능» 안내를 보세요."),
        ],
    )

    // MARK: 4-c) 모니터 미러링 (프로)
    static let mirror = GuideCategory(
        id: "mirror",
        icon: "display",
        titleKey: "모니터 미러링",
        leadKey: "iPhone 으로 Mac 화면을 실시간으로 보고, 탭·드래그·키보드로 직접 조작합니다.",
        sections: [
            .paragraph("채팅 화면 우상단의 «화면» 버튼을 누르면 Mac 데스크톱이 폰에 실시간으로 미러링됩니다. 화면을 보기만 할 수도 있고, Mac 이 허용하면 폰에서 그대로 클릭·스크롤·드래그·키보드 입력까지 할 수 있어요."),
            .callout(systemImage: "crown.fill", tint: .pro,
                     text: "모니터 미러링은 프로(고급) 기능이라 버튼이 주황으로 표시돼요. 멤버십이나 영구 이용권으로 잠금 해제하고, 처음이라면 무료 체험으로 써 볼 수 있어요 — 자세한 건 «프로 기능» 안내를 보세요."),
            .paragraph("제어 방법:"),
            .bullets([
                "포인터 — 한 손가락 탭은 클릭, 길게 눌렀다 떼면 우클릭. 두 손가락으로 핀치하면 그 부분을 확대해 정밀하게 누를 수 있어요.",
                "스크롤 / 드래그 — 좌측 모드 버튼으로 한 손가락 제스처를 스크롤 또는 드래그로 바꿉니다.",
                "키보드 — 우측 가상 키(ESC·Tab·화살표·Enter 등)와 입력창으로 글자를 보냅니다. 자주 쓰는 단축키 8개도 등록해 둘 수 있어요.",
                "줌 즐겨찾기 — 자주 보는 영역을 슬롯에 저장해 두고 한 번에 그 위치로 점프합니다 (모니터별로 따로 기억).",
            ]),
            .paragraph("화면 구석의 눈 모양 버튼(FAB)을 누르면 헤더와 컨트롤을 잠시 숨겨 미러 화면을 더 넓게 볼 수 있어요. 이 버튼은 설정 → «화면 넓게 보기» 에서 가로·세로 모드별로 켜고 끌 수 있고, 채팅 화면에서도 똑같이 동작합니다."),
            .callout(systemImage: "checkmark.shield.fill", tint: .warn,
                     text: "처음 켤 때 Mac 에서 «화면 기록» 권한(보기)과 «손쉬운 사용» 권한(제어)을 한 번 허용해야 합니다. 권한이 없으면 검은 화면이거나 조작이 먹지 않아요 — Mac 시스템 설정에서 허용해 주세요."),
        ],
    )

    // MARK: 4-d) 프로 기능
    static let pro = GuideCategory(
        id: "pro",
        icon: "crown.fill",
        titleKey: "프로 기능",
        leadKey: "주황색으로 표시된 기능은 멤버십이나 영구 이용권으로 쓰는 프로 기능이에요. 처음이라면 무료 체험으로 먼저 써 볼 수 있어요.",
        sections: [
            .paragraph("이 앱에서 주황색은 «프로(고급)» 기능을 뜻해요. 월·년 멤버십 또는 한 번 구매로 평생 쓰는 영구 이용권으로 이용할 수 있어요."),
            .paragraph("지금 주황색으로 표시되는 프로 기능:"),
            .bullets([
                "워크플로우 — 여러 에이전트를 잇는 멀티 에이전트 작업 흐름 (하단 «자동화» 탭).",
                "예약 작업 — 세션을 정해진 시각에 자동 실행 (하단 «자동화» 탭의 «예약» 세그먼트).",
                "모니터 미러링 — 폰에서 Mac 화면을 실시간으로 보고 원격 제어 (채팅 화면 우상단 주황 «화면» 버튼).",
                "터미널·로컬 LLM 도구 — 새 세션을 만들 때 고를 수 있는 고급 도구.",
                "세션 알림 음소거와 채팅 도구 모음 — 채팅 화면의 주황 버튼들.",
            ]),
            .callout(systemImage: "paintpalette", tint: .info,
                     text: "노랑(주의·경고)과 주황(프로)은 서로 다른 색이에요 — 노랑은 경고, 주황은 프로 기능 표시입니다."),
            .paragraph("구매와 무료 체험은 세션 화면 우상단 «프로 구독·구매» 버튼, 또는 프로 기능을 처음 탭할 때 뜨는 화면에서 할 수 있어요."),
        ],
    )

    // MARK: 5) 연결 / 듀얼 채널
    static let tor = GuideCategory(
        id: "tor",
        icon: "network",
        titleKey: "연결 / 듀얼 채널",
        leadKey: "iPhone↔Mac 직접 SSH 가 1차, Tor 회로가 백업입니다. 환경에 따라 빠른 쪽이 자동 선택됩니다.",
        sections: [
            .paragraph("v2.0.0 부터 데이터는 두 채널 중 하나로 흐릅니다 — 1) iPhone 에서 Mac 으로 직접 SSH (시판 공유기 + IPv6 활성 / UPnP 환경), 2) Tor onion 회로 안에서 SSH (CGNAT / UPnP 막힌 환경). 클라우드 중계나 외부 서버는 양쪽 모두 끼지 않습니다."),
            .paragraph("채택 방식: 앱이 두 경로를 동시에 시도하다 (happy eyeballs) 먼저 SSH 핸드셰이크가 성공한 쪽을 채택합니다. 직접 SSH 가 닿는 환경에선 latency 10–50ms, Tor fallback 일 땐 보통 200–600ms 입니다."),
            .paragraph("초기 연결 시간: 첫 부팅 / 백그라운드 복귀 시 Tor 회로 빌드까지 보통 5–30초 걸립니다. 이 시간 동안 «연결 준비 중…» 표시가 보입니다. 직접 SSH 가 잡히면 그 즉시 사용 가능 — Tor 빌드 완료를 기다리지 않습니다."),
            .paragraph("백그라운드 끊김: iOS 는 백그라운드에서 일정 시간이 지나면 앱의 소켓을 닫습니다. 돌아왔을 때 «연결이 끊겼어요» 가 뜨면 정상 동작이고, 한 번 회복해주면 됩니다."),
            .paragraph("회복 방식:"),
            .bullets([
                "자동 — 폴링이 끊김을 감지하면 두 채널을 다시 시도하고 세션을 새로고침합니다. 보통 잠시 기다리면 알아서 회복됩니다.",
                "수동 — 자동 회복이 끝까지 실패하면 «앱 다시 시작». fresh Tor 인스턴스 + 새 SSH 세션 — 가장 확실한 회복.",
            ]),
            .callout(systemImage: "bolt.fill", tint: .info,
                     text: "Tor 회로 빌드를 미리 데우기 위해 백그라운드에서 health 한 번 호출해 둡니다. 그래서 직접 SSH 가 안 잡히는 환경에서도 세션 화면 첫 진입이 빠르게 느껴집니다."),
            .callout(systemImage: "antenna.radiowaves.left.and.right", tint: .accent,
                     text: "Tor fallback 으로 붙은 경우엔 세션 목록 위에 띠 형태 안내가 뜹니다. 띠가 없으면 직접 SSH 로 붙은 상태입니다.")
        ],
    )

    // MARK: 6) 언어 설정
    static let language = GuideCategory(
        id: "language",
        icon: "globe",
        titleKey: "언어 설정",
        leadKey: "앱 표시 언어를 시스템 기본과 다르게 바꿀 수 있습니다.",
        sections: [
            .paragraph("톱니바퀴 메뉴 → «언어» 에서 10개 언어 중 고를 수 있습니다. 각 언어는 자기 모국어로 표시되므로 (한국어 / English / 日本語 / العربية ...) 모르는 언어로 빠져버려도 자기 언어 줄을 보고 다시 돌아올 수 있어요."),
            .paragraph("재시작이 필요한 이유: iOS 의 다국어 시스템은 앱이 부팅할 때 한 번 결정되고 그 뒤로는 바뀌지 않습니다. 그래서 언어를 새로 고르면 앱을 닫았다 다시 열어야 적용됩니다."),
            .paragraph("시스템으로 되돌리기: «시스템 언어 사용» 을 고르면 앱 전용 override 가 해제되고 iOS 설정의 언어 우선순위를 그대로 따라갑니다."),
        ],
    )

    // MARK: 2) macOS 권한 안내
    // 권한 프롬프트는 Mac 화면에 뜨지만 사용자는 보통 iPhone 앞에 있으므로 — iOS 가이드에도
    // 같은 글을 둔다 (Mac GuideContent 와 원문 동일 = 카탈로그 키 공유). Mac 이 «외부 서버 0,
    // 내 Mac 이 직접 서버» 구조라 일반 앱보다 권한 프롬프트가 많은 이유를 권한별로 정리.
    static let permissions = GuideCategory(
        id: "permissions",
        icon: "checkmark.shield.fill",
        titleKey: "macOS 권한 안내",
        leadKey: "Mac 에서 뜨는 권한 프롬프트들 — 각각 왜 필요하고, 거부하면 무엇이 안 되는지.",
        sections: [
            .paragraph("Pocket Sisyphus 는 외부 서버 없이 «내 Mac 이 직접 서버» 가 되는 구조라, 일반 앱보다 시스템 권한 프롬프트를 몇 개 더 만나게 됩니다. 전부 iPhone ↔ Mac 직접 연결과 repo 파일 작업에 필요한 것들입니다."),
            .paragraph("① 네트워크 수신 허용 (방화벽) — macOS 방화벽이 켜져 있으면 첫 실행 때 «들어오는 네트워크 연결을 허용하시겠습니까?» 가 뜹니다."),
            .bullets([
                "왜: iPhone 이 이 Mac 에 SSH 로 직접 접속하는 게 기본 경로 — 내장 sshd 가 그 연결을 받아야 합니다.",
                "거부하면: 직접 연결이 막혀 모든 통신이 Tor 우회로만 갑니다 — 동작은 하지만 눈에 띄게 느려집니다.",
            ]),
            .paragraph("② 로컬 네트워크 — macOS 15 이후 «로컬 네트워크의 장비를 찾고 연결하도록 허용» 프롬프트가 뜰 수 있습니다."),
            .bullets([
                "왜: 공유기에 포트를 자동으로 열어 (NAT-PMP/UPnP) 집 밖에서도 iPhone 이 직접 닿게 합니다.",
                "거부하면: 외부망에서 직접 연결이 안 될 수 있고, 그 경우 Tor 로 자동 폴백합니다.",
            ]),
            .paragraph("③ 폴더 접근 (문서·데스크탑·다운로드) — 그 폴더 안의 repo 로 세션을 만들면 «…폴더에 있는 파일에 접근하려고 합니다» 가 뜹니다."),
            .bullets([
                "왜: 코드 에이전트가 그 repo 의 파일을 읽고 써야 작업할 수 있습니다.",
                "거부하면: 그 폴더 안 repo 세션이 파일을 읽지 못해 동작하지 않습니다.",
                "팁: 메뉴바 → «전체 디스크 접근 권한…» 으로 한 번 켜 두면 폴더마다 다시 묻지 않습니다.",
            ]),
            .paragraph("④ 키체인 접근 (Claude Code-credentials) — iPhone 채팅방 메뉴에서 토큰 잔량을 처음 조회할 때 «키체인 항목을 사용하려고 합니다» 가 뜰 수 있습니다."),
            .bullets([
                "왜: Claude Code 가 저장해 둔 본인 로그인 토큰으로 공식 사용량 API 를 호출해 잔량/리셋 시간을 보여줍니다. 토큰은 Anthropic API 호출에만 쓰이고 그 외로 나가지 않습니다.",
                "«항상 허용» 을 누르면 다시 묻지 않습니다.",
                "거부하면: 잔량 표시만 «조회 불가» 가 되고, 다른 기능에는 영향이 없습니다.",
            ]),
            .paragraph("⑤ 관리자 암호 (가끔) — 자동 업데이트가 /Applications 의 앱을 교체할 때 계정 환경에 따라 암호를 한 번 물을 수 있습니다."),
            .bullets([
                "왜: macOS 정책상 관리자가 아닌 계정은 /Applications 교체에 승인이 필요합니다.",
                "거부하면: 그 업데이트만 건너뜁니다 — 다음 업데이트 때 다시 시도됩니다.",
            ]),
            .callout(systemImage: "hand.raised.fill", tint: .accent,
                     text: "이 앱이 쓰지 않는 것: 카메라 · 마이크 · 사진 · 연락처 · 위치 · 화면 기록에는 일절 접근하지 않습니다. 위 권한들은 모두 iPhone ↔ Mac 직접 통신과 repo 파일 작업에만 쓰입니다."),
        ],
    )

    // MARK: 7) 보안 / 프라이버시
    static let security = GuideCategory(
        id: "security",
        icon: "lock.shield.fill",
        titleKey: "보안 / 프라이버시",
        leadKey: "어떤 외부 서비스에도 의존하지 않고, 데이터가 어떻게 흐르는지.",
        sections: [
            .paragraph("데이터 흐름은 채택된 채널에 따라 두 가지입니다."),
            .bullets([
                "직접 SSH (1차) — iPhone Pocket Sisyphus → 디바이스 → 공유기 → Mac 의 임베디드 sshd (포트 22022) → Mac Pocket Sisyphus 데스크탑 앱 → 코드 에이전트 CLI → 각 에이전트의 모델 제공자 API.",
                "Tor fallback — iPhone Pocket Sisyphus → 디바이스 내 Tor → 인터넷 (onion routing 3-hop) → Mac 의 Tor hidden service → Mac 의 임베디드 sshd → Mac Pocket Sisyphus 데스크탑 앱 → 코드 에이전트 CLI → 각 에이전트의 모델 제공자 API.",
            ]),
            .paragraph("두 경우 모두 데이터 plane 은 SSH 입니다. Tor 가 동작할 때도 SSH 가 한 겹 더 감싸기 때문에 onion + SSH 두 겹 암호화가 됩니다. 중간에 작성자의 서버, 클라우드 중계, 분석 서비스는 전혀 끼지 않습니다."),
            .paragraph("암호학적 신원 이중 확인:"),
            .bullets([
                "Tor v3 onion 주소 — Ed25519 공개키 해시 그 자체라 위변조 불가.",
                "SSH host key fingerprint — 페어링 QR 에 박혀 있어 매 연결마다 대조. fingerprint 불일치면 연결을 거부합니다.",
            ]),
            .paragraph("저장 위치:"),
            .bullets([
                "Daemon bearer 토큰 — iPhone 의 Keychain.",
                "Tor client-auth 키 — iPhone 의 Keychain (Tor 가 onion 회로를 짤 때 사용).",
                "SSH 클라이언트 키페어 — iPhone 의 Keychain (Mac sshd 에 등록된 공개키와 짝).",
                "대화 기록 — Mac 측 데스크탑 앱의 sqlite. 모바일은 매번 fetch 만 하고 영구 저장은 안 합니다.",
            ]),
            .paragraph("모델 API 호출: 모델 추론 자체는 각 에이전트가 자기 제공자 (Anthropic Claude / Google Gemini / OpenAI 등) 에 직접 보내는 정상 트래픽입니다. 이 부분은 사용 중인 에이전트와 제공자의 정책을 따릅니다."),
            .callout(systemImage: "exclamationmark.triangle.fill", tint: .warn,
                     text: "페어링 QR 은 daemon 토큰 / client-auth 키 / SSH 클라이언트 키 / host fingerprint 를 모두 담고 있어 누설되면 그 Mac 데스크탑 앱에 누구든 접근할 수 있습니다. QR 이미지가 노출되었다면 Mac 에서 데스크탑 앱을 끄거나 새 페어링으로 갱신하세요."),
            .callout(systemImage: "shield.lefthalf.filled", tint: .info,
                     text: "Mac 의 임베디드 sshd 는 direct-tcpip 한 가지만 받도록 잠겨 있습니다 — 셸 / PTY / 파일 전송 / 에이전트 / X11 모두 거부. 즉, 페어링된 iPhone 도 그 Mac 에서 임의 셸을 열 수 없습니다."),
            .paragraph("기기 등록 — 폰을 페어링하면 그 기기의 Secure Enclave 키가 Mac 에 등록되고, 생체 인증 + 하드웨어 키로 보호되므로 QR 만 가로채도 다른 기기는 가장할 수 없어요. 기본은 한 대만 연결되지만, Mac 의 Pocket Sisyphus 설정 → 「기기」 탭에서 «추가 기기 허용» 을 켜면 최대 세 대(예: iPhone + iPad + 두 번째 폰)까지 함께 쓸 수 있어요. 다른 기기로 «바꾸려면» 같은 「기기」 탭에서 기존 기기를 해제한 뒤 새 기기로 QR 을 다시 스캔하세요."),
            .callout(systemImage: "ipad.and.iphone", tint: .info,
                     text: "추가 기기 연결하기 — ① Mac 의 Pocket Sisyphus 설정 → 「기기」 탭을 엽니다. ② «추가 기기 허용» 을 켭니다. ③ 새 기기(iPad 나 두 번째 폰)에서 같은 페어링 QR 을 다시 스캔합니다. 토글이 꺼진 채 새 기기가 스캔하면 «추가 기기 허용을 먼저 켜 달라» 는 안내가 뜨니, Mac 에서 토글을 켠 뒤 다시 스캔하면 돼요."),
            .callout(systemImage: "iphone", tint: .info,
                     text: "기본은 기기 한 대만 연결돼요. Mac 에서 «추가 기기 허용» 을 켜면 최대 세 대까지 함께 쓸 수 있어요. (Mac 앱에 이 토글이 안 보이면 Mac 의 Pocket Sisyphus 를 업데이트해 주세요.)")
        ],
    )
}
