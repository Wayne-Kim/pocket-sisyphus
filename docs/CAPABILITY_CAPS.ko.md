[English](CAPABILITY_CAPS.md) · **한국어**

# 능력 캡 — 개인-데이터 경로 가드레일 (lethal trifecta 차단)

> **스코프**: 개인/외부 데이터를 에이전트에 «주입» 하는 모든 경로(향후 기회 브리프 #1 메일·#2 캘린더 등)에
> 적용할 가드레일 명세. 이 문서는 «무엇을» 강제하는지의 정본(spec SSOT)이고, 위협 모델 관점은
> [THREAT_MODEL.ko.md §5.8](THREAT_MODEL.ko.md#58-간접-프롬프트-인젝션--lethal-trifecta--에이전트-경계-b5--자산-a2)
> 가, 실행 평면 구현 맥락은 [ARCHITECTURE.ko.md](ARCHITECTURE.ko.md)(§12 워크플로우/cron, §14 PO 루프)가 묶는다.
>
> **UI 표면 없음** — 이 문서는 daemon·정책 계층 명세다. 디자인 수용 기준(색·간격·토큰)은 비적용.
> 단, 이 캡들이 향후 #1·#2 UI 로 노출하는 «확인 게이트/차단» 문구는 [로케일 요구](#7-로케일-요구-필수)를 따른다.

---

## 1. 왜 — lethal trifecta

세 능력이 «한 세션 안에» 동시에 모이면 제로클릭 데이터 유출(EchoLeak·ShadowLeak 류)이 성립한다:

1. **사적 데이터** — 사용자의 메일·캘린더·파일·repo 내용.
2. **신뢰 못 할 외부 콘텐츠** — 공격자가 본문을 통제하는 메일/초대(간접 프롬프트 인젝션 운반체).
3. **외부 통신 능력** — 메일 send · 임의 HTTP POST/PUT/DELETE · git push · webhook/Discord 임의 payload ·
   외부로 데이터를 내보내는 MCP 도구.

이 앱은 이미 `skip_permissions`·cron·워크플로우로 에이전트를 **무인 자율 실행**하며 shell·파일·네트워크를
준다(ARCHITECTURE §8.5, §12, §14). 여기에 ②(공격자 통제 외부 콘텐츠)를 먹이는 «개인-데이터 입력» 이
붙는 순간 trifecta 가 완성된다. **방어 전략은 «세 다리 중 하나(③ 외부 통신)를 끊는다»** — ①·② 는 기능의
본질이라 없앨 수 없고, ③ 을 캡으로 묶으면 유출 경로가 닫힌다.

---

## 2. 모델 — taint(오염) + 능력 클래스

### 2.1 taint 소스 — «외부-콘텐츠 오염» 표식

개인/외부 데이터를 에이전트 컨텍스트(프롬프트·첨부·도구 결과)에 넣는 모든 경로는 그 세션/실행을
**`external_content_tainted = true`** 로 표시한다. 표식은 **단조(monotonic)** — 한 번 오염되면 그 세션의
남은 수명 내내 유지되고, 그 컨텍스트를 이어받는 후속 세션(cron `session_mode=continue`, 워크플로우 다음
노드, PO worktree)으로 **전파(propagate)** 된다. 해제는 없다.

taint 소스 예(향후 #1·#2 가 추가):
- 메일 본문/헤더/첨부를 컨텍스트에 적재(#1).
- 캘린더 이벤트 제목·메모·초대자 입력을 적재(#2).
- 그 밖에 «제3자가 본문을 통제할 수 있는» 모든 입력(공유 문서, webhook payload, 외부 이슈 코멘트 등).

> **주의**: repo 내부 콘텐츠(README·소스·이슈) 도 이미 «반신뢰»(B5, THREAT_MODEL §5.3)지만, 개인-데이터
> 경로는 ①(사적 데이터)이 함께 모이므로 trifecta 위험이 질적으로 다르다. 이 문서의 캡은 **개인-데이터
> taint 소스에 우선 적용** 하되, 정책 엔진은 모든 taint 소스에 동일 규칙을 쓸 수 있게 설계한다.

### 2.2 능력 클래스

| 클래스 | 정의 | 예 |
|---|---|---|
| **READ** | 외부에 아무것도 내보내지 않는 읽기 | 메일/캘린더 read, 파일 read, `git ls-remote`(폴) |
| **LOCAL** | 로컬에서만 효과, 외부 송신 없음 | 로컬 LLM, 작업트리 내 파일 write, 로컬 빌드/테스트 |
| **EGRESS** | 데이터가 신뢰 경계 밖으로 나감 (③ 통신 다리) | 메일 send · HTTP POST/PUT/DELETE(비-allowlist) · `git push` · webhook/Discord 임의 payload · outbound MCP 도구 |
| **SOURCE-WRITE** | 개인-데이터 소스로의 되쓰기 | 메일 보내기/이동/삭제, 캘린더 생성/수정/삭제 |

EGRESS·SOURCE-WRITE 가 «캡 대상» 이다. READ·LOCAL 은 기본 허용.

---

## 3. 규칙 (a)~(d)

### (a) 오염 세션의 외부 전송 능력 차단 — trifecta 끊기

> 캘린더/메일 유래 컨텍스트가 들어간 세션은 «외부 전송 능력» 을 기본 차단하거나 명시 확인 게이트로 묶는다.

- **T1 — 오염 시 EGRESS 기본 차단**: `external_content_tainted == true` 인 세션에서 EGRESS 클래스 능력은
  **기본 거부(default-deny)**.
- **T2 — 대화형(사람 있음) 경로의 확인 게이트**: 포그라운드 대화 세션이라 사람이 실시간으로 결재할 수
  있으면, EGRESS 는 차단 대신 **per-action 명시 확인 게이트**로 묶는다. 게이트는 **목적지 + payload 요약 +
  «이 세션은 외부 콘텐츠로 오염됨» 경고** 를 보여주고, 사용자가 «이 한 건» 을 승인해야 통과한다(블랭킷
  «항상 허용» 금지 — 매 EGRESS 마다 다시 묻는다).
- **T3 — 무인(사람 없음) 경로의 하드 차단**: cron·워크플로우 무인 노드·`skip_permissions`·PO 무인 구현처럼
  결재할 사람이 없는 자율 경로에서는 게이트가 성립하지 않으므로 EGRESS 를 **하드 차단**(게이트로 미루지
  않음). → 규칙 (c) 와 동일 결론.
- **T4 — allowlist 교집합**: 게이트를 통과하거나 비-오염이어도, 실제 outbound 네트워크 목적지는
  [도메인 allowlist](#4-도메인-allowlist)에 든 것만 허용한다(차단과 allowlist 는 AND).

### (b) 개인-데이터 소스 read-only 우선

> 개인-데이터 소스는 read-only 우선, 쓰기/전송은 사용자 확인 필수.

- **R1 — 기본 read-only**: 개인-데이터 커넥터(메일·캘린더)는 **읽기 스코프만** 으로 연결한다. 가능하면
  OAuth/토큰 스코프 자체를 read-only 로 발급(능력을 «없게» 만드는 게 «막는» 것보다 강하다).
- **R2 — SOURCE-WRITE 는 명시 확인**: 메일 보내기/삭제, 캘린더 생성/수정 등 소스 되쓰기는 **항상 per-action
  사용자 확인** 을 거친다. 자동 승인 금지.
- **R3 — 무인 경로에서 SOURCE-WRITE 금지**: cron/워크플로우/`skip_permissions`/PO 무인 경로에서는
  SOURCE-WRITE 를 **아예 허용하지 않는다**(확인할 사람이 없음).

### (c) 자율 경로에서 개인-데이터 + 외부 통신 조합 금지/격리

> cron·워크플로우·skip_permissions 같은 자율 경로에서는 개인-데이터 컨텍스트 + 외부 통신 조합을
> 금지하거나 격리한다.

- **C1 — 무인 trifecta 금지(불변식)**: 한 자율 실행 단위(cron tick · 워크플로우 run · PO 무인 구현) 안에서
  `external_content_tainted` 와 EGRESS 능력이 **동시에 활성일 수 없다**. 정책 엔진은 실행 *시작 전* 정적
  거부하고(설정 단계 검증), 런타임에 taint 가 번지면 그 세션의 EGRESS 핸들을 즉시 회수한다.
- **C2 — 격리(isolation)**: 개인-데이터를 다루는 자율 작업은 **EGRESS 없는 격리 세션**(전용 worktree·
  공유 자격증명 미주입·outbound MCP 미연결)에서 돌린다. 산출물은 로컬 결과 파일(`.posiworkflow/…`
  result.md, PO 보고서)로만 남기고, «사람이 본 뒤» 별도 비-오염 경로에서 외부로 내보낼지 결정한다.
- **C3 — away-gate 와의 정합**: Discord 알림 등 기존 EGRESS 성격 통지는 **오염 세션 컨텐츠를 payload 에
  싣지 않는다**. 「조용함 N분」·「cron 완료」 같은 메타 신호(제목·상태)만 보내고 본문/결과를 포함하지
  않는다(요약 유출 방지). 이는 ARCHITECTURE §12.6 의 이벤트 정책에 추가 제약으로 얹는다.

### (d) THREAT_MODEL.md 신규 공격면 기록

신규 공격면(간접 프롬프트 인젝션 → shell/파일/네트워크 남용 → 제로클릭 유출)과 완화책을
[THREAT_MODEL.ko.md §5.8](THREAT_MODEL.ko.md#58-간접-프롬프트-인젝션--lethal-trifecta--에이전트-경계-b5--자산-a2),
수용 잔여 위험을 [§6](THREAT_MODEL.ko.md#6-수용된-잔여-위험-accepted-residual-risk)에 기록했다.

---

## 4. 도메인 allowlist

- **기본 deny**: outbound 네트워크(HTTP·git remote·MCP 엔드포인트)는 명시 allowlist 에 든 호스트만 허용.
- **소스(앱이 정함)**: 개인-데이터 커넥터의 공식 API 호스트(예: 메일/캘린더 제공자 엔드포인트)와 사용자
  자신의 git remote 는 기본 allowlist. 그 외는 사용자가 설정에서 추가해야 한다.
- **오염 세션엔 무력**: allowlist 통과 여부와 무관하게, 오염 세션의 EGRESS 는 규칙 (a)(T1/T3) 가 우선
  적용된다 — allowlist 는 «비-오염» 경로의 추가 좁히기일 뿐, trifecta 차단을 대체하지 않는다.
- **로깅**: 차단/허용 결정은 daemon 로그에 목적지·세션 taint 상태와 함께 남긴다(디버그 문자열은 로케일
  대상 아님).

---

## 5. MCP 도구 권한 최소화

- **M1 — 최소 노출**: 세션에 노출되는 MCP 서버/도구는 그 작업에 «필요한 최소 집합» 만. 개인-데이터
  오염 세션에는 READ/LOCAL 도구만 연결하고, EGRESS·SOURCE-WRITE 성격 MCP 도구는 **미연결**.
- **M2 — 도구별 능력 클래스 태깅**: 각 MCP 도구를 §2.2 클래스로 분류한다(외부 송신/되쓰기/순수읽기).
  분류 불명 도구는 보수적으로 EGRESS 로 취급(차단 우선).
- **M3 — 자율 경로 outbound MCP 금지**: 무인 경로(cron/워크플로우/`skip_permissions`/PO)에서는 EGRESS·
  SOURCE-WRITE MCP 도구를 전면 비활성(규칙 C1 의 일부).

---

## 6. 수용 기준 체크리스트

향후 #1·#2(및 다른 개인-데이터 경로) 구현 시 이 캡들이 충족됐는지 검사한다:

- [ ] **taint 표식** — 개인-데이터를 컨텍스트에 넣는 경로가 세션을 `external_content_tainted` 로 표시하고,
      continue/다음 노드/worktree 로 전파하며 해제되지 않는다(§2.1).
- [ ] **(a) EGRESS 차단/게이트** — 오염 대화 세션은 EGRESS per-action 확인 게이트, 오염 무인 경로는 하드
      차단(T1~T3). 게이트는 목적지+payload 요약+오염 경고를 노출, 블랭킷 허용 없음.
- [ ] **(b) read-only 우선** — 커넥터 기본 read-only 스코프, SOURCE-WRITE 는 per-action 확인, 무인 경로
      SOURCE-WRITE 금지(R1~R3).
- [ ] **(c) 무인 trifecta 불변식** — cron/워크플로우/`skip_permissions`/PO 에서 taint+EGRESS 동시 활성
      정적·런타임 거부, 격리 세션 실행, 알림 payload 에 오염 결과 미포함(C1~C3).
- [ ] **(d) 위협 모델 기록** — THREAT_MODEL §5.8/§6 에 공격면·완화·잔여 위험 반영(완료).
- [ ] **allowlist** — outbound 기본 deny + allowlist, 오염 세션엔 (a) 우선(§4).
- [ ] **MCP 최소권한** — 도구 클래스 태깅, 오염/무인 세션에 EGRESS·SOURCE-WRITE MCP 미연결(§5).
- [ ] **로케일** — #1·#2 가 노출하는 확인/차단 문구가 [10개 언어 전부](#7-로케일-요구-필수) 번역됨.

---

## 7. 로케일 요구 (필수)

이 능력 캡들은 향후 #1·#2 UI 에서 «확인 게이트/차단» 문구로 사용자에게 노출된다. 그 문구
(예: «이 세션은 외부 메일/초대 내용으로 오염됨 — 외부 전송이 차단됨», «<목적지> 로 전송을 허용할까요?»,
«무인 자동화에서는 개인-데이터 + 외부 통신을 함께 쓸 수 없습니다» 등)는 이 레포 지원 로케일
**10개 언어 전부** 번역돼야 한다:

> `ar · en · es · fr · hi · ja · ko · pt-BR · ru · zh-Hans` (소스 언어 `ko`, 카탈로그 iOS/Mac `Localizable.xcstrings`).

자동 추출 ≠ 번역 완료 — 모든 언어 `value` 가 실제로 채워졌는지 확인한다(CLAUDE.md «iOS/Mac 다국어» 절).
디버그/로깅 문자열은 대상 아님. 색·토큰 등 시각 디자인 기준은 본 문서엔 비적용이나, #1·#2 가 실제 UI 를
그릴 때는 차단/위험 표현에 **danger(빨강)**, 「설정 필요」류 안내에 **warning(노랑)** 를 쓰고 둘을 혼동하지
않는다(CLAUDE.md 「색상 토큰 정책」).
