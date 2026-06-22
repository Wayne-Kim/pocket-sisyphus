/**
 * daemon ↔ iOS 앱 호환성 협상의 single source of truth.
 *
 * # 모델
 *
 * 양쪽(daemon + iOS)이 각자 다음 3가지를 자기 안에 박아 빌드된다:
 *   1. 자기 자신의 버전 (예: daemon 0.2.0, iOS 0.2.4)
 *   2. 상대편의 최소 지원 버전 (peer 가 이보다 낮으면 Hard incompat)
 *   3. 자기가 지원하는 capability 문자열 집합
 *
 * iOS 가 `/api/version` 을 호출해 (1)+(2)+(3) 을 가져가서:
 *   - Hard: 두 minVersion 중 하나라도 위반 → 전체 차단 화면 (어느 쪽 업데이트가
 *     필요한지 사람이 읽을 수 있게 메시지 분기)
 *   - Soft: iOS 가 기대하지만 daemon 에 없는 capability 들 → 부팅 시 배너로 미리
 *     알림 ("일부 기능 사용 불가 — Mac 앱 업데이트 시 활성화")
 *
 * # 누가 알 수 있는가? (정보 비대칭)
 *
 *   Hard incompat              → 양쪽 모두 자기 minPeerVersion 으로 판정 가능
 *   새로 추가된 기능 (신버전)   → 신버전 쪽만 판정 가능 (구버전엔 그 코드가 없음)
 *   제거/Deprecated 된 기능    → 신버전 쪽만 판정 가능
 *
 * 그래서 실무적으로는 "그 기능을 트리거하는 쪽" 이 판정과 안내 책임을 진다.
 * iOS 가 새 기능 버튼을 눌렀을 때 → iOS 가 capability 보고 "Mac 업데이트 필요"
 * 안내. Mac 메뉴에서 새 기능 시작하려는 경우 → Mac 이 같은 패턴.
 *
 * # 버전 올릴 때
 *
 *   - daemon 자체 릴리스: `DAEMON_VERSION` ↑. 보통 그게 끝.
 *   - 호환 깨는 프로토콜 변경: `MIN_SUPPORTED_CLIENT_VERSION` 도 같이 ↑
 *   - 새 기능 도입: `DAEMON_CAPABILITIES` 에 새 string 추가 (소문자_언더스코어).
 *     iOS 쪽도 같은 식별자로 expected 목록에 추가. 둘이 안 맞으면 Soft incompat 으로
 *     사용자한테 한 줄로 보여진다.
 *   - 기능 제거: capability 에서 빼고, 빼는 그 자체가 다시 Soft incompat 신호.
 *     심각한 제거면 `MIN_SUPPORTED_CLIENT_VERSION` ↑.
 */

import { getUpdateStatus, type UpdateStatus } from "./updateStatus.js";

// 버전 bump 시 양쪽 project.yml 과 함께 이 값도 갱신한다.
// daemon 은 Mac 앱 안에 번들로 들어가므로 두 값이 어긋나면 사용자가 «Mac
// 데몬 0.2.1» 같이 옛 버전을 보게 된다 (실제 Mac 앱은 1.0.0).
export const DAEMON_VERSION = "2.22.0";

/**
 * daemon 이 받아들일 수 있는 iOS 앱의 최소 버전. 이보다 낮은 iOS 가 페어된 경우
 * 클라이언트 측 호환성 화면에서 「iOS 앱 업데이트 필요」 로 분기된다.
 *
 * v2 GA (0.2.0) 시점에 두 바이너리 모두 처음으로 capability 핸드셰이크를 갖고
 * 나간다. 그 이전 빌드는 `/api/version` 자체가 없어서 클라이언트가 "구 daemon"
 * 으로 판정 → 같은 경로로 "Mac 앱 업데이트 필요" 안내.
 */
export const MIN_SUPPORTED_CLIENT_VERSION = "0.2.0";

/**
 * daemon 이 현재 빌드에서 지원하는 기능 식별자.
 *
 * 명명 규칙: 소문자_언더스코어 + 끝에 `_v숫자`. 같은 기능의 protocol-broken
 * 버전업이 생기면 `_v2`, `_v3` 식으로 새 식별자를 발급한다 (기존 키를 silently
 * 의미만 바꾸지 말 것 — 양쪽 호환성 판정이 깨진다).
 *
 * 여기 들어가는 것: 클라이언트가 명시적으로 "있다/없다" 를 분기해야 사용자에게
 * 합리적 UX 를 줄 수 있는 기능. 내부 구현 디테일은 capability 가 아니다.
 */
export const DAEMON_CAPABILITIES: readonly string[] = [
  // WebSocket push (hello/subscribe/session events). 0.2.0 GA 기본.
  "ws_v1",
  // 한 번에 messages 를 증분 받는 통합 폴 엔드포인트.
  "session_poll_v1",
  // GET /:id/poll?limit + GET /:id/messages — 콜드 진입 tail 캡 + 역방향 keyset 히스토리.
  // 무한 누적된 pty_chunk 를 전부 내려받던 ~5s 콜드 로드 제거. 옛 daemon 은 limit 을 무시하고
  // 전체를 반환하므로 클라이언트는 이 capability 가 있을 때만 캡/«이전 더보기» UX 를 켠다.
  "session_history_v1",
  // GET /:id/pty/snapshot — 헤드리스 VT(@xterm/headless)로 최근 tail 을 replay 해 «현재 화면
  // +scrollback» 을 한 덩이로 직렬화해 보낸다. 콜드 진입 비용이 O(청크 바이트 총합) → O(화면)
  // 으로 떨어져 긴 PTY 세션 진입이 즉각적이 된다. 옛 daemon 은 404 → 클라이언트가 P1 tail 캡으로 폴백.
  "pty_snapshot_v1",
  // POST /api/sessions/:id/clear — 안의 메시지만 비우고 세션은 유지.
  "session_clear_v1",
  // PATCH /api/sessions/:id — title 변경.
  "session_rename_v1",
  // POST /api/sessions { skipPermissions: true } — 권한 자동 승인 세션.
  "skip_permissions_v1",
  // GET /api/recent-projects — 데스크탑에서 최근 쓰인 cwd 목록.
  "recent_projects_v1",
  // approvals 테이블의 `always_allow` decision — 한 번 허용 후 같은 도구는 이후 자동 통과.
  "approvals_always_allow_v1",
  // WS subscribe payload 의 since (epoch ms) 를 받아 그 이후 pty_chunk 를 즉시 backfill.
  // iOS 가 백그라운드 → 포어그라운드 복귀로 WS 재연결 시 빠진 chunk 를 polling 사이클
  // 기다리지 않고 한 RTT 로 채운다.
  "ws_catchup_v1",
  // GET /api/sessions/:id/git/branch — 세션의 repo_path 에서 현재 git 브랜치를 조회.
  // 모바일 ChatView 의 상태바에 표시: 세션이 어느 브랜치에서 작업 중인지 한눈에.
  "session_git_branch_v1",
  // GET /api/sessions/:id/git/status + GET .../git/diff?path=… — 커밋되지 않은 변경
  // 파일 목록 / 가벼운 통계 + 한 파일 unified diff. 모바일 ChatView 의 상태바 «변경 N»
  // 칩과 Diff 시트가 이 두 endpoint 로 동작.
  "session_git_status_v1",
  // POST /api/sessions { agent: "agy" | "claude_code" | "codex" | … } + GET /api/agents.
  // daemon 이 등록된 코드 에이전트 CLI 목록을 노출하고, 클라이언트가 세션 생성 시
  // 어떤 agent 로 spawn 할지 명시할 수 있다. iOS picker 가 이 capability 보고 동적
  // 노출 vs claude_code 만 default 사용을 분기.
  "multi_agent_v1",
  // POST /api/admin/trigger-update 가 Mac 앱에 «무클릭 사일런트» 강제 업데이트를
  // 트리거한다 (SIGUSR1 → 헤드리스 Sparkle 설치 + relaunch). iOS 가 이 capability 를
  // 보고 «강제 업데이트 중 → 곧 재연결» UX 로 분기하고, 결과를 /api/version 의
  // `lastUpdate` 로 반영한다. 없으면 옛 Mac 앱 → 「Mac 화면에서 Sparkle 확인」 폴백.
  "silent_update_v1",
  // GET/POST /api/notify/config + POST /api/notify/test — Discord incoming webhook 알림.
  // daemon 이 «턴 끝남 / 세션 종료 / 에러» 를 사용자 본인 Discord webhook 으로 보낸다
  // (외부서버 0 — 푸시 전달은 Discord 인프라가 대행). 설정은 Mac 앱 창에서. 클라이언트가
  // 이 capability 보고 알림 설정 UI 노출 여부를 분기.
  "notify_discord_v1",
  // PATCH /api/sessions/:id { notifyMuted } — 세션 단위 알림 음소거. 여러 세션을 동시에
  // 굴릴 때 시끄러운 세션만 골라 끄는 iOS ChatView bell 토글. sessions.notify_muted 컬럼.
  "session_notify_mute_v1",
  // GET /api/sessions/:id/usage — 세션 agent 의 토큰 잔량 (rate limit 윈도우별 사용률
  // + 리셋 시각). claude_code / codex 지원, shell / agy 는 supported:false.
  "agent_usage_v1",
  // /api/local-llm/* — 데몬이 로컬 LLM(llama-server) 수명주기 + 모델 카탈로그/다운로드/
  // 하드웨어 추천을 소유. iOS 가 이 capability 보고 「로컬 LLM 모델 관리」 화면을 노출.
  "local_llm_lifecycle_v1",
  // /api/cron/* — 예약 작업(cron). iOS 가 «어떤 repo 에서 / 어떤 에이전트로 / 어떤 명령을 /
  // 언제» 돌릴지 등록하면 daemon 의 CronScheduler 가 그 시각에 세션을 만들어 한 번 실행한다.
  // iOS 가 이 capability 보고 설정 메뉴에 「예약 작업」 진입점을 노출 (없으면 숨김 — soft).
  "cron_v1",
  // 예약 작업의 kind='terminal' — 에이전트 대신 «쉘 스크립트 파일» 을 정해진 시각에 인터프리터
  // (zsh/bash/sh)로 한 번 실행. cron_jobs.kind/shell 컬럼 + POST/PATCH 의 script 검증. iOS 에디터가
  // 이 capability 보고 «종류: 에이전트/터미널» 선택지를 노출 (없으면 에이전트만 — soft 폴백).
  "cron_terminal_v1",
  // /api/workflows/* — 멀티 에이전트 워크플로우. iOS 캔버스에서 노드(에이전트 작업)를 화살표로
  // 이어 그린 DAG 를 daemon 의 WorkflowEngine 이 노드=세션으로 위상 순서대로 실행한다. 노드 간
  // 결과물 전달은 «Task 폴더» 계약. iOS 가 이 capability 보고 설정 메뉴에 「워크플로우」 진입점을
  // 노출 (없으면 숨김 — soft). Phase 0: 정적 DAG(start/general/end) + 수동 트리거 + 읽기전용 캔버스.
  "workflow_v1",
  // GET /api/sessions/:id/artifacts + /fs/raw — 세션이 만든 «시각적 산출물»(이미지·PDF·동영상·
  // Office·USDZ 등)을 자동 발견해 나열하고, raw 바이트를 스트리밍한다. iOS 가 이 capability 보고
  // «결과» 시트에 «산출물» 세그먼트를 노출하고 QuickLook 으로 렌더. 없으면 숨김 — soft.
  "artifacts_v1",
  // WS capture_start/capture_stop + screen_frame — 번들 Swift 헬퍼(capture-helper)가 CGDisplay
  // 로 화면을 캡처해 JPEG 프레임을 푸시한다. iOS 가 «결과» 시트에 «화면» 세그먼트를 노출.
  // macOS 화면 기록 TCC 권한 필요. 없으면 숨김 — soft.
  "screen_capture_v1",
  // WS input_event — 헬퍼가 CGEvent 로 마우스/키보드를 주입(원격 제어). 세션별 명시적 «제어
  // 허용» 게이트 + 손쉬운 사용 TCC 권한 필요. 폰이 Mac 데스크톱을 조작하는 능력이라 보안상
  // 별도 capability 로 분리 — iOS 가 «제어» 토글을 노출할지 분기. 없으면 보기 전용.
  "remote_control_v1",
  // 화면 캡처를 JPEG 대신 H.264(SCStream + VideoToolbox) 로 인코딩해 «바이너리» WS 로 릴레이한다.
  // 델타 인코딩이라 같은 대역폭에서 fps 가 훨씬 높다(2fps JPEG → 12fps H.264). iOS 가 이 capability
  // 보고 capture_start 에 codec:h264 + 채널별 fps/bitrate 를 요청. 없으면 jpeg 폴백 — soft.
  "screen_h264_v1",
  // GET /api/screen/shot — macOS screencapture(1) 원샷 JPEG. 미러링의 «캡처/녹화 → 채팅 첨부»
  // (버그 재현 전달) 데이터원. 화면 기록 TCC 는 책임 프로세스(메인 앱) 권한을 따른다.
  // 없으면 iOS 가 캡처/녹화 버튼을 숨김 — soft.
  "screen_shot_v1",
  // 창 단위 캡처 대상 — WS capture_set_window/capture_list_windows + capture_windows/
  // capture_target broadcast + /api/screen/shot 의 window 쿼리. 헬퍼가 SCContentFilter
  // (desktopIndependentWindow:)로 선택한 창만 인코딩·송출한다(대역폭·프라이버시 상류 해법).
  // iOS 가 이 capability 보고 미러링 더보기의 «캡처 대상» 피커를 노출 — 없으면 숨김(soft).
  "screen_window_target_v1",
  // /api/po/* — PO 루프 (기회 브리프 백로그). 수집 에이전트가 신호(이슈·레포 todo)를 종합해
  // 브리프를 만들고, iOS 백로그 탭(1번 탭)에서 사람이 승인/보류/기각만 한다. 승인 시 daemon 이
  // 구현 세션을 spawn. iOS 가 이 capability 보고 백로그 탭 노출을 분기 (없으면 숨김 — soft).
  "po_loop_v1",
  // PO 루프 Phase 2 — ① 주기 수집 (po_profiles.schedule + PoScheduler — «매일 아침 수집»
  // 프리셋) ② 출시 후 검증 루프 (running→shipped 자동 전이 + 수집 사이클의 verified/missed
  // 판정 + verify_note). iOS 가 이 capability 보고 수집 시트의 «주기 수집» 섹션 노출을 분기
  // (없으면 숨김 — soft. 옛 daemon 은 PUT /profile 의 schedule 필드를 조용히 버린다).
  "po_schedule_v1",
  // 브리프 승인의 decide body 에 useWorktree — true 면 구현 세션을 새 worktree(`po/<id8>`
  // 브랜치)에서 돌린다 (동시 세션 간 작업트리 충돌 방지). iOS 가 이 capability 보고 승인
  // 최종 확인에 «worktree 에서 시작» 선택지를 노출 — 없으면 기존 단일 버튼 (soft. 옛
  // daemon 은 useWorktree 필드를 조용히 버린다).
  "po_worktree_v1",
  // PO 루프의 에이전트 선택 — POST /collect·/research·/briefs/:id/decide body 의 agent 필드로
  // 어느 코드 에이전트가 수집/리서치/구현을 돌릴지 고른다 (생략 시 claude_code). iOS 가 이
  // capability 보고 백로그의 에이전트 픽커를 노출 — 없으면 숨김 (soft. 옛 daemon 은 agent
  // 필드를 조용히 버려 항상 claude_code 로 돌았다 — 픽커를 보여주면 거짓 UI 가 된다).
  "po_agent_v1",
  // GET /api/po/stats — PO 루프 누적 성적표 (레포별/전체: 제안 수·승인율·verified/missed·결재
  // 중앙값 시간). 설계 문서의 성공 지표를 사용자에게 보여 신뢰 콜드스타트를 데이터로 푼다.
  // iOS 가 이 capability 보고 백로그 상단 성적표 카드 노출을 분기 (없으면 숨김 — soft).
  "po_stats_v1",
  // PO 신호 소스에 App Store 리뷰 — po_profiles.asc_app_id (켠 레포만 수집 시 ASC 고객
  // 리뷰를 fetch 해 프롬프트에 첨부, evidence kind asc_review) + /api/po/asc-key 설정
  // 라우트 (키는 Mac config.json 0600 에만 — 폰/QR 에 안 들어감). iOS 가 이 capability
  // 보고 수집 시트의 «App Store 리뷰» 섹션 노출을 분기 (없으면 숨김 — soft. 옛 daemon
  // 은 PUT /profile 의 ascAppId 필드를 조용히 버린다).
  "po_asc_v1",
  // POST /api/po/briefs/:id/cleanup — 기각된 브리프의 «코드 흔적 정리» 세션 spawn. 기각된
  // 아이디어의 신호원(TODO/FIXME 주석·죽은 코드·문서 할 일)을 지워 다음 수집의 같은 제안
  // 반복을 막는다. po_briefs.cleanup_session_id 가 진입점(«정리 세션 보기»). iOS 가 이
  // capability 보고 기각 다이얼로그의 «기각하고 코드 흔적 정리» 와 기각 브리프 상세의
  // «코드 흔적 정리» 섹션 노출을 분기 (없으면 숨김 — soft).
  "po_cleanup_v1",
  // PO 신호 소스에 출시 앱 크래시 — po_profiles.asc_app_id 가 켜진 레포는 수집 시 ASC
  // Analytics «App Crashes» 보고서(기존 ASC 키 재사용 — 서드파티 SDK 없음)를 집계해
  // 프롬프트에 첨부한다 (evidence kind crash). daemon 단독으로 동작하며, iOS 는 이
  // capability 를 보고 수집 시트의 App Store 섹션 안내문에 «크래시 신호 포함» 표기를
  // 분기할 수 있다 (없어도 동작 — soft).
  "po_crash_v1",
  // 라이브 프리뷰 v2 — 프록시가 (1) HTML/JS 응답의 «동일 호스트 절대 URL»(http(s)/ws(s) loopback)
  // 중 «등록된 포트» 만 프록시 경로로 리라이트하고(WS 는 주입 shim 이 런타임 처리), (2) 한 세션이
  // «여러 dev 포트»(앱 3000 + API 3001 등)를 등록해 포트별로 라우팅한다. iOS 가 이 capability 보고
  // 프리뷰 화면에 «보조 포트 등록» UI 를 노출 — 없으면(옛 daemon) 기존 단일 포트 UX 유지(회귀 없음).
  "preview_v2",
  // 브리프 승인의 decide body 에 mode="workflow" — 설계 에이전트가 브리프 맞춤 워크플로우
  // (스펙 확정→구현→자가검증→사람 승인 게이트)를 만들고 daemon 이 validateDef + 게이트 강제
  // 검증 후 run 으로 실행한다 (실패 시 기본 4노드 템플릿 fallback). 게이트 도달 시 po_gate
  // 알림 + workflow/<runId> 딥링크. iOS 가 이 capability 보고 승인 최종 확인에 «워크플로우로
  // 실행» 선택지를 노출 — 없으면 숨김 (soft. 옛 daemon 은 mode 필드를 조용히 버려 세션
  // 모드로 돌므로, 선택지를 보여주면 거짓 UI 가 된다).
  "po_workflow_v1",
  // POST /api/po/collect 응답에 gh 점검 메타 — 수집의 «GitHub 신호» 가용성을 수집 직전
  // 점검(gh --version 설치 여부 + gh auth status 인증 여부 + 레포가 GitHub 원격인지)해
  // { gh: { githubRemote, installed, authed } } 로 돌려준다. iOS 가 githubRemote && (!installed
  // || !authed) 일 때만 안내 톤으로 «GitHub 신호 없이 수집됨 — gh 설치/로그인하면 더 좋은
  // 브리프» + 명령(brew install gh / gh auth login)을 띄운다. 정상이면 아무 UI 도 안 뜬다.
  // 옛 daemon 은 gh 필드 자체가 없어 iOS 가 조용히 폴백 (거짓 «설정 필요» 표시 금지).
  "po_gh_check_v1",
  // PO 프로필에 GitHub «피드백 repo» 오버라이드 — po_profiles.github_feedback_repo (owner/name).
  // 이 레포의 origin 은 개발용 소스 repo 라 사용자에게 직접 안내하지 않아 글이 안 쌓이고, 실제 피드백(이슈·Discussions)
  // 은 별도 공개 repo 에 모인다. 설정 시 수집 프롬프트의 GitHub 분기가 로컬 origin 대신 그 repo 를
  // `gh -R <repo>` 로 읽고, gh-check 도 그 repo 의 접근성으로 판정한다 (코드·TODO·git·문서 신호는
  // 그대로 로컬 repoPath). iOS 가 이 capability 보고 수집 시트에 «GitHub 피드백 repo» 입력 1줄을
  // 노출 — 없으면 숨김(soft, 옛 daemon 은 PUT /profile 의 githubFeedbackRepo 필드를 조용히 버린다).
  "po_feedback_repo_v1",
  // POST /api/po/collect 응답에 asc 점검 메타 — 수집의 «App Store 신호»(리뷰 po_asc_v1 +
  // 크래시 po_crash_v1) 가용성을 수집 직전 점검한다. 리뷰·크래시는 같은 ASC 키를 공유하므로
  // 한 번의 키 인증 프로브(/v1/apps)로 둘 다 커버: { asc: { enabled, keyConfigured, reachable } }.
  // gh 와 똑같은 silent-degradation 차단 — ASC 키가 «저장 후» 만료·폐기되면 리뷰·크래시가 0이
  // 되는데 섹션이 조용히 생략돼 사용자가 모른다. iOS 가 enabled && (!keyConfigured || !reachable)
  // 일 때만 안내 톤으로 «App Store 신호 없이 수집됨 — Mac 설정에서 ASC 키 확인» 을 띄운다.
  // 네트워크/타임아웃/5xx 불확실과 ASC 신호 꺼짐(asc_app_id 없음)은 침묵. 옛 daemon 은 asc 필드
  // 자체가 없어 iOS 가 조용히 폴백 (거짓 «설정 필요» 표시 금지).
  "po_asc_check_v1",
  // GET /api/po/collect/last?repoPath= — 직전 수집의 «App Store 신호원 실행 상태». po_asc_check_v1 이
  // 수집 «직전» 키 인증만 프로브(off/키미설정/키권한)하던 것과 달리, 이건 fetch «후» 의 실제 1회 결과를
  // 신호원별로 담는다: { store, crash } 각각 used(N)/off/empty/key_missing/auth/app_id/network. iOS 가
  // 수집 시작 후 폴링해 sessionId 일치(=방금 끝난 수집)면 «수집 결과 카드» 로 «스토어/크래시 신호
  // 사용됨(N)/꺼짐/실패(사유)» 를 띄운다 — 켠 신호가 키 만료·app id 오류·네트워크로 조용히 빠졌는데도
  // «반영된 줄» 착각하던 무음 강등을 막는다. 완료 알림(Discord)도 같은 상태를 «Signals» 한 줄로 싣는다.
  // 옛 daemon 은 이 엔드포인트가 없어 iOS 가 조용히 폴백(카드 없음).
  "po_signal_status_v1",
  // GET /api/po/collect/scheduled — 예약(scheduled) 수집의 «마지막 결말» 목록. po_signal_status_v1 이
  // «무엇을 봤나»(신호원 상태)라면 이건 «그래서 무엇이 나왔나» 다: new(새 제안 N≥1)/empty(정상 빈손)/
  // failed(시작 실패·인입 에러)를 repo 별로 담는다. 무인 사용자가 «오늘은 없네» 와 «수집이 깨졌네» 를
  // 혼동하지 않게, 예약 수집의 결말을 알림(po_briefs/po_empty/po_failed) + 백로그 «마지막 예약 수집»
  // 카드로 표면화한다 (수동 «지금 수집» 은 화면 앞 사용자라 대상 아님). iOS 가 이 capability 보고
  // 카드를 노출 — 없으면(옛 daemon, 404) 조용히 숨김 (soft).
  "po_scheduled_status_v1",
  // POST /api/po/collect body 에 persona="designer" — 수집을 «디자이너» 페르소나로 돌린다.
  // 코드/이슈/리뷰/크래시 신호를 «기회» 로 종합하던 기본 수집과 달리, 레포의 UI 표면을 위
  // 「디자인 제약」 이 선언/발견한 디자인 SSOT 대비로 스캔해 토큰 드리프트·접근성·대비·패턴
  // 불일치를 «디자인 부채» 브리프로 발굴한다 (evidence=파일:라인+위반 토큰/패턴명). 산출 스키마/
  // 저장소는 기존과 동일 — 같은 백로그에 나란히 들어간다. «구현 전 발굴» 이라 디자인 리뷰 게이트·
  // 수용 기준(구현 후 검수)과 역할이 겹치지 않는다. iOS 가 이 capability 보고 수집 시트에
  // «수집 관점» 피커(기능/디자인)를 노출 — 없으면 숨김(soft, 옛 daemon 은 persona 를 조용히
  // 버려 기본 수집으로 돌므로 피커를 보여주면 거짓 UI 가 된다).
  "po_designer_v1",
  // POST /api/sessions/:id/pty/control { action: "approve" | "interrupt" } — 세션 목록의
  // 그룹 헤더 일괄 액션(«모두 승인» / «모두 중지»). 채팅방을 열지 않고 그룹 단위로 Enter/ESC
  // 제어 byte 를 PTY 에 흘려 «대기 N건» 결재 병목을 분 단위로 줄인다 (writePtyRaw — 사람이
  // 누르는 키와 동치, PTY 는 죽이지 않음). iOS 가 이 capability 보고 대기/실행중 그룹 헤더의
  // 일괄 버튼 노출을 분기 — 없으면 숨김(soft, 옛 daemon 은 이 라우트가 404).
  "bulk_session_actions_v1",
  // 세션 «보관» (sessions.archived 컬럼). GET /api/sessions 가 archived 쿼리(미지정/'0'=미보관만·
  // '1'=보관분만·'all'=둘 다)를 받고, PATCH /api/sessions/:id { archived } 가 단건 보관/복구,
  // POST /api/sessions/bulk { action:"archive"|"unarchive"|"delete", ids } 가 일괄 처리한다.
  // 완료/오래된 세션을 시야에서 치워 활성 목록을 슬림하게 유지하는 용도 — iOS 가 이 capability
  // 보고 «보관함» 섹션·스와이프 보관·그룹 일괄 보관을 노출한다. 없으면 숨김(soft, 옛 daemon 은
  // archived 컬럼이 없어 PATCH archived 를 무시하고 /bulk 라우트가 404).
  "session_archive_v1",
  // POST /api/workflows/design + GET /api/workflows/design/:id — «한 문장으로 설명» 텍스트를
  // 받아 설계 에이전트(po_workflow_v1 와 같은 «자기 에이전트 CLI → tmp JSON 산출 → ingest» 계약)
  // 가 start/task/end + fail 간선 DAG «초안» 을 만든다. 곧장 실행하지 않고 sanitize + validateDef
  // 통과 후 노드/간선만 돌려주면, iOS 가 캔버스에 «초안» 으로 띄워 사용자가 검토·수정한 뒤에만
  // 저장/실행한다 (Zapier «draft not live»). iOS 가 이 capability 보고 워크플로우 생성 시트의
  // «AI 초안» 액션을 노출 — 없으면 숨김(soft, 옛 daemon 은 이 라우트가 404).
  "workflow_design_v1",
  // POST /api/po/design-directive/bootstrap + approve + DELETE /design-directive/draft — 디자인
  // «부트스트랩». design_directive 가 NULL 이면 「디자인 제약」 이 «자동 발견»(약한 신호)으로
  // 떨어지는데, directive 를 손으로 쓰는 건 채택 장벽이라 대부분 NULL 로 방치된다. 이 capability 는
  // 디자이너 에이전트가 레포 디자인 SSOT(토큰/테마·i18n 카탈로그·디자인 문서)를 스캔해 directive
  // 마크다운 «초안» 을 만들고, 사람이 iOS/Mac 설정 «디자인» 영역에서 검토·승인해야 design_directive
  // (선언된 강신호)로 복사되게 한다(자동 적용 금지). GET /api/po/profile 이 designDirective(승인된
  // 선언)·designDirectiveDraft(검토 대기 초안)·designDirectiveDraftSessionId(non-null=생성 중)를
  // 함께 돌려준다. 클라가 이 capability 보고 설정에 «디자인» 영역(초안 생성·검토·승인)을 노출 —
  // 없으면 숨김(soft, 옛 daemon 은 이 라우트가 404 이고 draft 필드를 안 보낸다).
  "po_design_bootstrap_v1",
  // POST /api/po/briefs/bulk/decide { ids: string[], action: "hold" | "reject" } — 결재 대기
  // 다중 선택을 한 번에 보류/기각하는 «트리아지» 일괄 결재. hold/reject «만» — approve 는
  // 구현 세션/워크플로우를 brief 마다 spawn 하므로 일괄에 부적합(폭주 위험)이라 단건 경로만 둔다.
  // 살아있는(proposed/held) 행만 바꾸고 없는/이미 처리된 id 는 skipped 로 돌려준다(부분 성공 —
  // 200건을 훑는 중 일부가 그새 바뀌어도 나머지는 진행). iOS 백로그 트리아지 시트가 이 capability
  // 보고 일괄 결재를 1콜로 처리 — 없으면(옛 daemon, 이 라우트 404) 단건 decide 를 순차 호출해
  // 폴백한다(느리지만 동작). 트랜잭션 1회라 적용분만 일관 커밋.
  "po_bulk_decide_v1",
  // POST /api/po/research body 에 lens="design"|"bug" — 리서치를 «전문가 관점»(렌즈)으로 돌린다.
  // 일반 PO 프롬프트 하나로만 돌던 리서치에, 분석에 «맞는 전문가»(디자인 / 버그·신뢰성)를 배정해
  // buildPoResearchPrompt 가 «무엇을 우선 조사·어떤 근거를 강조»(디자인=토큰/접근성/대비, 버그=재현/
  // 로그/회귀)하는 머리말을 주입한다. 「design」 렌즈는 수집 designer 페르소나(po_designer_v1)와 같은
  // 렌즈 정의(lens.ts 의 DESIGN_LENS_FOCUS)를 공유 — 의미가 일치한다. 선택한 렌즈는 po_research.lens
  // 에 기록돼 GET /research(:id) 응답의 lens 필드로 나가고, 보고서·브리프 스키마는 동일하게 유지된다.
  // iOS 가 이 capability 보고 리서치 주제 화면에 «전문가 관점» 픽커를 노출하고 보고서 머리에 렌즈 칩을
  // 띄운다 — 없으면 숨김(soft, 옛 daemon 은 lens 를 조용히 버려 전방위로 돌므로 픽커를 보여주면 거짓
  // UI 가 된다. 옛 daemon 은 lens 필드도 안 보내 iOS 가 default=전방위로 폴백).
  "po_research_lens_v1",
  // 리서치 «전문가 관점» 렌즈 집합 확장 — lens="qa" (QA 전문가) 추가 + 「bug」 표시명을 «디버깅» 으로
  // 정렬. lens.ts 가 qa 머리말(테스트·수용 기준·커버리지·회귀 설계)을 주입한다. v1(렌즈 픽커 존재)
  // «위» 의 별도 capability 인 이유: 새 iOS 가 v1-만-아는 옛 daemon 에 qa 를 보내면 parseLens 가
  // 조용히 default(전방위)로 폴백 → «거짓 UI» 가 된다. 그래서 iOS 는 이 capability 가 있을 때만 qa
  // 옵션을 픽커에 넣는다(없으면 전방위·디자인·디버깅 3개만). design/bug 는 v1 그대로라 회귀 0.
  "po_research_lens_v2",
  // 리서치 «전문가 관점» 렌즈 집합 확장 — lens="security" (보안 전문가) 추가. lens.ts 가 보안
  // 머리말(인증·키 취급·네트워크 노출면·자격증명 흐름·위협모델 대비; 레포=파일:라인+신뢰경계,
  // 웹=CVE·보안 모범사례)을 주입한다. 이 제품은 SSH host key·Tor onion·페어링 QR·로컬 자격증명처럼
  // 보안이 1급 관심사라(docs/THREAT_MODEL.md·SECURITY.md) 디자인·디버깅을 깐 같은 기계장치에 가장
  // 중요한 렌즈를 채운 것. v2 «위» 의 별도 capability 인 이유는 qa 와 동일 — 새 iOS 가 v2-만-아는
  // (qa 까진 알아도 security 는 모르는) 옛 daemon 에 security 를 보내면 parseLens 가 조용히
  // default(전방위)로 폴백 → «거짓 UI» 가 된다. 그래서 iOS 는 이 capability 가 있을 때만 security
  // 옵션을 픽커에 넣는다. design/bug/qa 는 이전 capability 그대로라 회귀 0.
  "po_research_lens_v3",
  // 리서치 «전문가 관점» 렌즈 집합 확장 — lens="pm" (기획/제품 전문가) 추가. lens.ts 가 기획
  // 머리말(요구·우선순위·로드맵·범위 트레이드오프·성공 정의; 레포=파일:라인+사용자 문제와의 연결,
  // 웹=시장 수요·제품 전략 사례)을 주입한다. 시장 카탈로그가 표준으로 주는 핵심 직무 중 기획·마케팅·
  // 분석·운영 4개가 비어 있어 디자인·디버깅을 깐 같은 기계장치에 채운 것. v3 «위» 의 별도 capability
  // 인 이유는 이전과 동일 — 새 iOS 가 pm 을 모르는 옛 daemon 에 pm 을 보내면 parseLens 가 조용히
  // default(전방위)로 폴백 → «거짓 UI». 그래서 iOS 는 이 capability 가 있을 때만 pm 옵션을 픽커에
  // 넣는다. design/bug/qa/security 는 이전 capability 그대로라 회귀 0.
  "po_research_lens_v4",
  // 리서치 «전문가 관점» 렌즈 집합 확장 — lens="marketing" (마케팅 전문가) 추가. lens.ts 가 마케팅
  // 머리말(타깃·메시징·포지셔닝·채널·전환; 레포=파일:라인+사용자에게 보이는 카피/가치 전달,
  // 웹=경쟁 포지셔닝·GTM 사례)을 주입한다. v4 «위» 의 별도 capability 인 이유는 위와 동일 — 새 iOS 가
  // marketing 을 모르는 옛 daemon 에 보내면 default 로 폴백 → «거짓 UI». iOS 는 이 capability 가
  // 있을 때만 marketing 옵션을 픽커에 넣는다. 이전 렌즈는 그대로라 회귀 0.
  "po_research_lens_v5",
  // 리서치 «전문가 관점» 렌즈 집합 확장 — lens="analytics" (분석 전문가) 추가. lens.ts 가 분석
  // 머리말(지표·퍼널·계측·코호트·인사이트·실험; 레포=파일:라인+측정 지점·이벤트, 웹=지표 정의·실험
  // 설계 사례)을 주입한다. v5 «위» 의 별도 capability 인 이유는 위와 동일 — analytics 를 모르는 옛
  // daemon 에 보내면 default 로 폴백 → «거짓 UI». iOS 는 이 capability 가 있을 때만 analytics 옵션을
  // 픽커에 넣는다. 이전 렌즈는 그대로라 회귀 0.
  "po_research_lens_v6",
  // 리서치 «전문가 관점» 렌즈 집합 확장 — lens="ops" (운영 전문가) 추가. lens.ts 가 운영
  // 머리말(배포·롤백·신뢰성·모니터링·비용·확장; 레포=파일:라인+배포/스크립트의 운영 영향, 웹=배포
  // 전략·SRE·비용 최적화 사례)을 주입한다. v6 «위» 의 별도 capability 인 이유는 위와 동일 — ops 를
  // 모르는 옛 daemon 에 보내면 default 로 폴백 → «거짓 UI». iOS 는 이 capability 가 있을 때만 ops
  // 옵션을 픽커에 넣는다. 이전 렌즈는 그대로라 회귀 0.
  "po_research_lens_v7",
  // 리서치 «전문가 관점» 렌즈 집합 확장 — lens="logic" (로직/도메인·정합성 전문가) 추가. lens.ts 가
  // 로직 머리말(도메인 규칙·상태 전이·불변식의 정합성, 중복·죽은 코드·과복잡·불명료; 레포=파일:라인+
  // 어떤 규칙/불변식이 어디서 강제/누락·어디가 중복/과복잡, 웹=도메인 주도 설계·리팩토링·코드 단순화
  // 사례)을 주입한다. 기존 9개 렌즈는 «깨짐(bug)·보증(qa)·노출(security)·운영(ops)» 등 직무를 다루지만
  // «정상 동작하지만 복잡·중복·불명료한 비즈니스 로직» 을 전담해 볼 관점이 비어 있었다 — 이 제품은
  // 상태머신(브리프 status·워크플로우 노드·엔타이틀먼트·세션 resume/fork)이 풍부해 도메인 정합성·
  // 불변식 렌즈가 특히 값지다. v7 «위» 의 별도 capability 인 이유는 위와 동일 — logic 을 모르는 옛
  // daemon 에 보내면 parseLens 가 조용히 default(전방위)로 폴백 → «거짓 UI». iOS 는 이 capability 가
  // 있을 때만 logic 옵션을 픽커에 넣는다. 이전 렌즈는 그대로라 회귀 0.
  "po_research_lens_v8",
  // 리서치 «전문가 관점» 렌즈 집합 확장 — lens="ux" (UX·사용성 전문가) 추가. lens.ts 가 UX
  // 머리말(Nielsen 10 휴리스틱 우선; spec 에 위반 휴리스틱+심각도(cosmetic/minor/major/catastrophic)
  // +사용 시나리오/개선안; 레포=파일:라인+막히는 플로우·위반 휴리스틱, 웹=사용성 가이드라인·휴리스틱
  // 평가 사례)을 주입한다. design(시각) 렌즈와 «다른» 렌즈 — design 이 토큰·색·간격이라면 ux 는
  // «플로우 마찰·이해·완수»(업계가 시각 디자인 리뷰와 UX 휴리스틱 평가를 다른 방법론으로 구분). v8
  // «위» 의 별도 capability 인 이유는 위와 동일 — ux 를 모르는 옛 daemon 에 보내면 parseLens 가
  // 조용히 default(전방위)로 폴백 → «거짓 UI». iOS 는 이 capability 가 있을 때만 ux 옵션을 픽커에
  // 넣는다. 이전 렌즈는 그대로라 회귀 0.
  "po_research_lens_v9",
  // 리서치 «전문가 관점» 렌즈 집합 확장 — lens="readability" (가독성·유지보수성 전문가) 추가. lens.ts 가
  // 가독성 머리말(코드 «표면» legibility 우선 — 명명 명확성·일관성, 파일/함수 길이, 구조 분해, 중첩 깊이,
  // 매개변수 수, 매직 넘버, 주석 품질; spec=현재 가독성 문제(위치·왜)/더 읽기 쉬운 형태(동작 보존)/동작
  // 보존 검증/blast-radius; 레포=파일:라인+무엇이 왜 읽기 어려운가, 웹=클린 코드·명명·함수 분해 사례)을
  // 주입한다. logic(도메인·정합성) 렌즈와 «다른» 렌즈 — logic 이 «규칙이 맞는가·일관적인가»(불변식)면
  // readability 는 «코드 표면이 읽기 쉬운가»(사람-가독성)만 본다(도메인 로직 정합·불변식은 logic 에
  // 명시적으로 위임 — 중복 정의 금지). design(시각)↔ux(사용성)를 직교 렌즈로 쪼갠 전례와 동형. v9 «위» 의
  // 별도 capability 인 이유는 위와 동일 — readability 를 모르는 옛 daemon 에 보내면 parseLens 가 조용히
  // default(전방위)로 폴백 → «거짓 UI». iOS 는 이 capability 가 있을 때만 readability 옵션을 픽커에 넣는다.
  // 이전 렌즈는 그대로라 회귀 0. (수집(collect)은 후속 단계 — 이번엔 리서치 우선.)
  "po_research_lens_v10",
  // POST /api/po/research body 에 scope="web_repo" | "repo_only" — 리서치 «조사 범위» 선택.
  // 기본/생략(옛 클라이언트)은 "web_repo" = 기존 웹+레포 조사(회귀 없음). "repo_only" 면
  // buildPoResearchPrompt 가 «웹 조사 (핵심)» 단계를 «레포만 조사 — 웹 검색 금지» 로 치환하고,
  // 보고서 «경쟁/대안» 절을 생략 가능하게 하며, 브리프 근거를 repo 만으로 허용한다 — 가벼운
  // 분석을 웹 검색의 지연·토큰 없이 싸고 빠르게 끝내려는 사용자의 선택. lens 와 직교 — repo_only
  // 는 «어디서»(웹 끄고 레포만)를, lens 는 «무엇을 우선·어떤 근거»를 정해 함께 적용된다. iOS 가
  // 이 capability 보고 리서치 주제 화면에 «조사 범위» 피커를 노출 — 없으면 숨김(soft, 옛 daemon 은
  // scope 필드를 조용히 버려 항상 웹+레포로 돌므로 피커를 보여주면 거짓 UI 가 된다).
  "po_research_scope_v1",
  // POST /api/po/research body 에 screens=true — UX 렌즈 리서치에 «렌더된 화면» 을 입력으로 쓴다.
  // 배경: 휴리스틱 평가는 «화면(스크린샷)» 을 볼 때 코드/텍스트-only 보다 더 많은 사용성 문제를 잡는데
  // (멀티모달 우위), 이 제품 리서치는 코드+웹 텍스트만 입력이라 ux 렌즈가 «실제로 보이는 화면» 을 못 본
  // 채 추론했다. screens=true 면 buildPoResearchPrompt 의 ux 머리말에 «이 레포의 기존 캡처 수단
  // (verify-ios/device·Storybook·웹 헤드리스)으로 화면을 렌더·캡처해 눈으로 보고 Nielsen 휴리스틱을
  // 판정하고, evidence 에 화면 참조(kind:"screenshot")를 남겨라» 블록을 추가한다. 화면을 못 얻는
  // 레포(UI 없음/캡처 불가)면 코드+웹으로 평가하되 그 한계를 보고서에 명시(graceful fallback) — 화면
  // 부재 시에도 정상 동작(회귀 0). ux 외 렌즈·생략/false·옛 클라이언트는 프롬프트가 byte-identical.
  // lens=="ux" 와 직교(함께 보낸다). iOS 가 이 capability + ux 렌즈 선택 시에만 «화면 포함» 토글을
  // 노출 — 없으면 숨김(soft, 옛 daemon 은 screens 를 조용히 버려 코드+웹으로 돌므로 토글을 보여주면
  // 거짓 UI 가 된다). 토글 OFF 는 screens 필드를 생략 → 기존 ux 리서치와 동일.
  "po_research_ux_screens_v1",
  // GET /api/workflows/templates — 워크플로우 «출발 템플릿»(노드/간선 프리셋) 목록. 매번 빈
  // 캔버스에서 역할 파이프라인을 손으로 잇는 마찰을 없앤다: 업계 표준 오케스트레이터-워커
  // (기획→디자인→개발→QA(승인 게이트)→운영)를 결정적 프리셋으로 내려보낸다(AI 초안과 달리
  // 에이전트 spawn 없이 즉시 시드). 노드 종류는 start/task/end 뿐이라 캔버스 종류색은 유지되고,
  // QA 노드의 requires_approval 로 경계 동작(운영) 전 사람 결재 게이트가 끼인다. 노드 제목·템플릿
  // 이름/설명 같은 화면 노출 문자열은 클라이언트가 카탈로그로 지역화한다. iOS·Mac 이 이 capability
  // 보고 워크플로우 생성에 «템플릿으로 시작» 진입점을 노출 — 없으면 숨김(soft, 옛 daemon 은 이
  // 라우트가 404). 빈 캔버스/AI 초안 경로는 그대로라 회귀 0.
  "workflow_templates_v1",
  // POST /api/po/collect body 에 lens="design"|"bug" — 수집을 «전문가 관점»(렌즈)으로 돌린다. 리서치는
  // po_research_lens_v1 로 이미 전문가 관점을 갖췄지만 «주기 수집» 은 default/designer 2개뿐이라 «버그·
  // 신뢰성» 관점으로 신호를 못 모았다 — 이 capability 가 collect 를 같은 lens.ts SSOT 로 일반화해
  // 리서치와 정합시킨다. "design" 은 옛 persona="designer"(po_designer_v1)와 «같은» 동작(designer→design
  // 동치 — UI 디자인 부채 발굴), "bug" 는 일반 수집 경로에 «디버깅·신뢰성» 머리말을 주입해 크래시·실패
  // 로그·재현 버그·회귀를 우선 신호로 모은다. "default"(전방위)·옛 클라이언트는 머리말 없는 기존 수집과
  // byte-identical (회귀 0). po_profiles.lens 컬럼(DEFAULT 'default')에 주기 수집의 렌즈를 저장해 매일
  // 자동 수집을 그 초점으로 고정할 수 있고(scheduler 가 읽음), 수동 수집은 회차 인자가 프로필보다 우선한다
  // (instruction↔directive 와 동형). GET/PUT /api/po/profile 이 lens 필드를 함께 주고받는다. iOS 가 이
  // capability 보고 수집 시트의 «전문가 관점» 픽커(전방위/디자인/디버깅)와 설정의 주기 수집 렌즈 픽커를
  // 노출 — 없으면 숨김(soft, 옛 daemon 은 lens 를 조용히 버려 전방위로 돌므로 픽커를 보여주면 거짓 UI 가
  // 된다. 옛 daemon 은 persona 만 알아 design 만 가능했다). bug 옵션은 이 capability 가 게이트한다.
  "po_collect_lens_v1",
  // 수집 «전문가 관점» 렌즈 집합 확장 — collect 의 lens="security" (보안 전문가) 추가. lens.ts 의
  // collectLensHeadmatter 가 보안 머리말(인증·키 취급·네트워크 노출면·자격증명 흐름·위협모델 대비
  // 신호 우선; evidence=파일:라인+신뢰 경계·시크릿 취급, spec=위협/완화책/검증)을 일반 수집 경로에
  // 주입한다. 리서치의 security 렌즈(po_research_lens_v3)와 같은 SECURITY_LENS_FOCUS 를 «공유» 해 두
  // 경로의 의미가 갈리지 않는다(design/designer 정합과 동형). 이 제품은 SSH host key·Tor onion·페어링
  // QR·로컬 자격증명처럼 보안이 1급 관심사라(docs/THREAT_MODEL.md·SECURITY.md) 리서치에서만 쓰던
  // 보안 렌즈를 «타이핑 없는» 자동·주기(cron) 수집 루프에서도 쓰게 채운 것. v1 «위» 의 별도 capability
  // 인 이유는 research 렌즈 확장(qa/security)과 동일 — 새 iOS 가 v1-만-아는(design/bug 까진 알아도
  // security 는 모르는) 옛 daemon 에 security 를 보내면 collectLensHeadmatter 가 빈 문자열을 돌려
  // parseLens 가 통과시킨 security 가 «머리말 없는 default 수집» 으로 조용히 폴백 → «거짓 UI» 가 된다.
  // 그래서 iOS 는 이 capability 가 있을 때만 수집 픽커(빠른 수집의 일회성 lens + 주기 수집 프로필
  // lens)에 security 옵션을 넣는다. default/design/bug 는 v1 그대로라 회귀 0. (qa/pm/marketing/…은
  // 후속 단계 — 이번엔 security 우선.)
  "po_collect_lens_v2",
  // POST /api/po/briefs/:id/restart { agent? } — 진행 중(running) 브리프의 «구현 다시 시작».
  // 사용자가 구현 세션을 임의로 정지하거나 세션이 깔끔한 정착 신호 없이 죽으면 브리프가 running 에
  // 영원히 남는다(shipped 전이는 세션 정착 시에만). 유일한 수습이 «삭제» 뿐이라 승인 이력·결재 사유·
  // 출처(provenance)가 함께 증발했다 — 이 라우트가 같은 브리프 id·결재 컨텍스트를 보존한 채 새 구현
  // 세션을 spawn 하고 exec_session_id 만 교체한다(상태 running 유지). 에이전트는 body.agent →
  // 브리프에 기록된 exec_agent_id → claude_code 순 폴백(마지막 선택 재사용). 워크플로우 모드
  // (exec_workflow_id != null)·비-running 은 거부. shipped 직전 race 는 가드된 UPDATE 로 멱등 처리해
  // 중복 세션을 막는다. iOS 가 이 capability 보고 「진행 중」 행에 비파괴 «구현 다시 시작» 액션을 노출 —
  // 없으면 숨김(soft, 옛 daemon 은 이 라우트가 404 라 액션을 보여주면 거짓 UI 가 된다). 기존 «삭제»
  // (완전 폐기)는 그대로라 회귀 0.
  "po_exec_restart_v1",
  // MCP «도구» 표면 — 에이전트가 사용자 본인 Calendar/Gmail 등 MCP 서버에 OAuth 로 붙어
  // 메일·일정을 도구로 쓴다. 경계: MCP 전송·OAuth 인가 흐름(OAuth 2.1+PKCE, RFC 9728 PRM
  // 자동발견, RFC 8707 resource indicator, DCR)은 에이전트 CLI 의 네이티브 MCP(.mcp.json)에
  // 위임하고, daemon 은 «서버 등록 + 0600 토큰 custody/취소 + 연결 헬스» 만 소유한다(전체
  // OAuth 클라이언트를 재구현하지 않음). 토큰 평문은 폰/QR 에 절대 안 나가고 config.json(0600)
  // 에만 산다. 권한은 최소권한 — 기본 읽기 전용(calendar.events.readonly 등), 쓰기는 사용자
  // opt-in. iOS 가 이 capability 보고 설정에 「도구」 진입점(MCP 서버 목록·연결 상태·OAuth
  // 트리거)을 노출 — 없으면 숨김(soft. 옛 daemon 은 /api/mcp 가 404 라 보여주면 거짓 UI 가
  // 된다). 자율 실행 경로(cron·워크플로우·skip_permissions)에 도구를 노출하는 건 보안 가드레일이
  // 적용된 뒤에만 — skip_permissions_v1 + 이 capability 로 게이트.
  "mcp_tools_v1",
  // 수집 «전문가 관점» 렌즈를 11종 «전체» 로 확장 — v2(security 추가) 위에 qa/pm/marketing/analytics/
  // ops/logic/ux 7종을 더 얹어 리서치(po_research_lens_v9)와 같은 전문가 집합을 수집에서도 쓰게 한다.
  // lens.ts 의 collectLensHeadmatter 가 7종 머리말을(리서치 같은 렌즈와 의미 일치) 일반 수집 경로에
  // 주입하고, lensPersona 가 각 렌즈의 «정체성» 을 PO 가 아니라 그 전문가로 바꿔 «고른 전문가가 직접
  // 브리프를 쓰게» 한다(수집·리서치·디자인 분기 공통). v2 «위» 의 별도 capability 인 이유는 v2 와 동일 —
  // 새 iOS 가 v2-까지만-아는(security 까진 알아도 qa/… 는 모르는) 옛 daemon 에 그 lens 를 보내면
  // collectLensHeadmatter 가 빈 문자열을 돌려 parseLens 가 통과시킨 값이 «머리말 없는 default 수집» 으로
  // 조용히 폴백 → «거짓 UI». 그래서 iOS 는 이 capability 가 있을 때만 수집 픽커에 7종을 더 넣는다.
  // default/design/bug/security 는 v1/v2 그대로라 회귀 0.
  "po_collect_lens_v3",
  // po_briefs.lens 컬럼 — 이 브리프를 «쓴 전문가» 를 행에 직접 박는다(수집 collectLens / 리서치
  // research.lens). GET /api/po/briefs 가 lens 필드를 함께 돌려주고, iOS 가 백로그 카드에 전문가
  // 배지를 띄운다(default 면 배지 숨김). 옛 row·옛 daemon 은 lens 누락/'default' → 배지 숨김으로
  // 회귀 0. 리서치가 만든 브리프는 po_research.lens 와도 일치(카드는 JOIN 없이 이 컬럼만 읽음).
  "po_brief_lens_v1",
  // GET /api/diagnostics — 로컬 진단 번들(서브시스템 스냅샷 + 최근 crash 마커 + 마스킹된
  // unified.log tail). iOS 「문제 신고/진단」 화면이 «사용자가 직접» 묶어 공유/내보내기 한다.
  // 자동 전송 없음(LAN 전용·무텔레메트리). 비밀(webhook URL·토큰·키)은 마스킹된다. iOS 는 이
  // capability 가 있을 때만 진단 화면 진입점을 노출 — 없으면 숨김(옛 daemon 은 /api/diagnostics
  // 가 404 라 보여주면 거짓 UI 가 된다).
  "diagnostics_v1",
  // GET /api/connection-diagnostics — 서브시스템 «읽기 전용» 연결 진단 스냅샷. Tor(부트스트랩%·
  // onion 게시 여부)·sshd listening·외부 연결성(LAN 전용 정책)·에이전트 CLI 탐지·디스크 여유·
  // unified.log/pty_chunk 크기·마지막 IP변경/재연결 시각을 안정적 코드(connection-diagnostics/
  // codes.ts)로 분류해 내보낸다. 연결 실패가 원인 없는 일반 에러로 떨어지던 걸, iOS 「연결 진단」
  // 화면이 코드→사람이 읽는 localize 문구·권장 조치로 매핑하게 한다. (별개의 `diagnostics_v1` 은
  // «문제 신고/진단 번들» — crash 마커+마스킹 로그 tail — 이라 식별자를 분리한다.) iOS 가 이
  // capability 보고 설정에 「연결 진단」 진입점을 노출 — 없으면 숨김(soft, 옛 daemon 은 이 라우트가 404).
  "connection_diagnostics_v1",
  // GET /api/workflows/attention + POST /api/workflows/runs/:id/ack-attention (workflow_attention_v1).
  // 노드 결과가 «에이전트가 직접 남긴 것»(agent)인지 «터미널 출력 자동 합성본»(synthetic)/«빈 결과»
  // (empty)인지 구분하는 표식(workflow_node_runs.result_kind)을 산출·저장하고, run 마감 시 종합해
  // run 행에 «미해결» 신호(workflow_runs.attention_kind: failed|empty|synthetic)를 박는다. 무인
  // (cron/github) 실행이 «진짜 결과 없이» 끝났는데 정상 «완료» 로 보이던 막다른 길을, 앱이 워크플로우
  // 탭 배너(/attention 집계 — 최근 N건 페이징 너머도 집계)와 실행 기록/캔버스 칩·배지로 표면화한다.
  // 확인하면 ack-attention 으로 attention_ack=1 → 배너에서 사라진다(거짓 경보 방지). iOS 가 이
  // capability 보고 배너/집계 폴링을 켠다 — 없으면 숨김(soft, 옛 daemon 은 /attention 이 404). result_kind
  // 는 GET /runs/:id 의 nodeRuns 와 GET /:id 의 runs 에 함께 실려, 옛 클라이언트는 모르는 키로 무시(회귀 0).
  "workflow_attention_v1",
  // POST /api/repeat + GET /api/repeat/runs(/:id) + cancel — 「반복 실행」(repeat_run_v1). 워크플로우
  // 캔버스를 그리지 않고 (repo·에이전트·목표 스펙·완료 검사·최대 횟수)만 받아, 자기교정 루프
  // (start→실행→점검→end + «점검 실패→실행» fail back-edge)를 즉석 «합성» 해 기존 WorkflowEngine 으로
  // 돌린다. 매 회 새 세션(=새 컨텍스트)으로 같은 스펙을 다시 실행하고, 점검 verdict 가 pass(완료)거나
  // 최대 횟수에 닿으면(실패) 멈춘다. 무인 경로라 worktree 격리(po/워크플로우와 동일)로 돌고
  // no-unattended-trifecta·skip_permissions 방어(prepareUnattendedCwd)를 그대로 준수한다. 합성한
  // 워크플로우는 ephemeral=1 이라 캔버스 목록(GET /api/workflows)엔 안 뜬다. iOS 가 이 capability 보고
  // 자동화 탭에 「반복 실행」 진입점(시작 시트 + 진행 상태)을 노출 — 없으면 숨김(soft, 옛 daemon 은 이
  // 라우트가 404 라 보여주면 거짓 UI). 프로(주황) 기능(.repeatRun)으로 게이트한다.
  "repeat_run_v1",
] as const;

/**
 * `/api/version` 응답 형식. iOS 클라이언트는 이 shape 에 맞춰 디코드한다.
 *
 * Codable 호환성 메모: 필드를 *추가* 하는 것은 안전 (구 클라이언트가 ignore).
 * 기존 필드를 제거하거나 타입을 바꾸면 호환성 깨짐 — 그 변경은 capabilities 새
 * 식별자 + minSupportedClientVersion ↑ 으로 명시한다.
 */
export type VersionResponse = {
  /** daemon 자체 버전. */
  daemonVersion: string;
  /** daemon 이 받아들이는 iOS 앱의 최소 버전. */
  minSupportedClientVersion: string;
  /** daemon 이 현재 빌드에서 제공하는 기능 식별자 집합. */
  capabilities: string[];
  /**
   * 마지막 사일런트 업데이트 결과 (있을 때만). 프로세스가 살아남는 경우 (새 버전 없음 /
   * 에러) 만 담긴다 — 설치 성공은 relaunch 로 daemon 이 재시작되어 daemonVersion ↑ 자체가
   * 신호다. 구 클라이언트는 모르는 키라 무시 (additive 안전).
   */
  lastUpdate?: UpdateStatus;
};

export function buildVersionResponse(): VersionResponse {
  const lastUpdate = getUpdateStatus();
  return {
    daemonVersion: DAEMON_VERSION,
    minSupportedClientVersion: MIN_SUPPORTED_CLIENT_VERSION,
    capabilities: [...DAEMON_CAPABILITIES],
    ...(lastUpdate ? { lastUpdate } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 클라이언트 버전 강제 미들웨어 — 두 번째 안전망.
//
// 동기: `/api/version` 핸드셰이크는 클라이언트가 호출해 줘야 동작한다. 그래서 이
// 안전장치가 들어가기 *전에* 빌드된 iOS 는 핸드셰이크 자체를 안 한다. 그런
// 옛 iOS 가 미래의 신 daemon 에 연결하면 — daemon 이 MIN_SUPPORTED_CLIENT_VERSION
// 을 올린 뒤에도 — 그냥 연결되어 API 호환 깨진 부분에서 generic 에러로 떨어진다.
// 사용자는 영문을 모름.
//
// 이를 막기 위해 **모든** `/api/*` 요청에서 `X-Client-Version` 헤더를 본다.
//   - 헤더 없음        → 통과. 매우 옛 클라이언트 (헤더 추가 전 빌드) 또는 외부 도구.
//                       지금 시점에 enforce 할 근거가 없어서 강제 차단하지 않는다.
//                       이 미들웨어가 들어간 후 *부터* 빌드된 모든 iOS 는 헤더를 단다.
//   - 헤더 < min      → 426 Upgrade Required + 구조화 에러 응답. iOS 클라이언트는
//                       이걸 catch 해서 호환성 화면으로 전환한다.
//   - 헤더 ≥ min      → 통과.
//
// /api/version 만은 헤더 검증을 건너뛴다 — 옛 클라이언트가 자기가 너무 옛버전임을
// "학습" 할 수 있는 유일한 채널을 막아버리면 안 된다.
// ─────────────────────────────────────────────────────────────────────────────

import type { MiddlewareHandler } from "hono";

/**
 * 단순 dot-separated semver 비교. pre-release 태그(-beta.x)는 자르고 숫자만 본다.
 *
 * export 인 이유: 426 게이트의 «순서/경계» 판정(예: 1.9.0 < 1.10.0 을 문자열이 아니라
 * 숫자로 본다)을 version.test.ts 에서 표로 직접 고정하기 위함. 런타임 동작 불변.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const l = pa[i] ?? 0;
    const r = pb[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}
function parts(s: string): number[] {
  const trimmed = s.split("-")[0] ?? s;
  return trimmed.split(".").map((p) => parseInt(p, 10) || 0);
}

/**
 * `/api/*` 에 붙여 쓰는 미들웨어. version.ts 안에 둔 이유는 MIN_SUPPORTED_CLIENT_VERSION
 * 과 같은 파일에 있어야 둘이 어긋날 일이 없기 때문 (단일 source of truth).
 */
export const requireClientVersion: MiddlewareHandler = async (c, next) => {
  // 호환성 학습 채널 — 너무 옛 클라이언트도 이건 자유롭게 호출할 수 있어야 한다.
  // c.req.path 는 Hono 에서 mount prefix 가 적용된 full path 가 나온다.
  if (c.req.path === "/api/version") return next();

  const headerVersion = c.req.header("x-client-version");
  if (!headerVersion) {
    // 헤더 미전송 — 매우 옛 빌드 또는 비표준 호출자. 현재 정책: 통과.
    // 옛 클라이언트를 enforce 할 시점이 오면 여기서 거부로 전환한다.
    return next();
  }

  if (compareSemver(headerVersion, MIN_SUPPORTED_CLIENT_VERSION) < 0) {
    // 426 Upgrade Required — HTTP 표준상 "protocol upgrade 필요" 시그널이지만,
    // 클라이언트 앱 업그레이드 의미로도 종종 쓰인다. 401/403 과 분명히 구분돼서
    // iOS 측 catch 가 명료해진다.
    return c.json(
      {
        error: "client_too_old",
        minSupportedClientVersion: MIN_SUPPORTED_CLIENT_VERSION,
        clientVersion: headerVersion,
      },
      426,
    );
  }

  return next();
};
