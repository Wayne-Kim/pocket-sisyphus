---
name: verify-ios
description: >-
  iOS 변경을 에이전트가 시뮬레이터에서 «직접 보고» 검증하는 자가 검증 루프.
  빌드 → 설치 → 개발 페어링 주입 launch → (딥링크 조작) → 스크린샷을 에이전트가 읽어
  눈으로 확인한다. 사용자가 "/verify-ios", "시뮬레이터에서 확인해줘", "iOS 화면 검증",
  "구현한 거 눈으로 확인해라" 등을 요청할 때, 또는 iOS UI 변경을 구현한 뒤 스스로
  검증할 때 사용. 인자로 확인할 화면/딥링크 힌트를 줄 수 있다.
---

[English](SKILL.md) · **한국어**

# /verify-ios — iOS 시뮬레이터 자가 검증 루프

iOS 변경을 만들었으면 「실기기에서 눌러서 확인해 주세요」 로 사람에게 반납하지 말고,
**시뮬레이터에서 직접 보고 판단**한다. 사람 개입 0 이 목표다.

## 한 사이클 실행

```bash
./scripts/verify-ios.sh                                      # 빌드+설치+실행+스크린샷
./scripts/verify-ios.sh -d 'pocketsisyphus://session/<id>'   # launch 후 딥링크로 화면 전이
./scripts/verify-ios.sh -s                                   # 빌드 생략(이미 빌드됨) — 관측만
./scripts/verify-ios.sh -o /tmp/shot.png                     # 스크린샷 경로 지정
```

스크립트가 마지막 줄에 스크린샷 경로를 출력한다 — **그 파일을 Read 로 직접 열어
눈으로 확인**하고, 기대와 다르면 코드를 고쳐 다시 사이클을 돈다.

속도 규율 (사용자 요구):
- **스크린샷은 레포 `attachments/` 폴더에 보관**된다 (이미 gitignore 된 앱 첨부 컨벤션 폴더 —
  dot-폴더는 첨부 미리보기에서 숨겨져 못 쓴다). 결과 보고 시 경로를 알려준다.
- **관측(찍고 확인)은 최대 30초** — 스크립트가 대기를 30s 로 clamp 한다. 코드가 안 바뀌었으면
  반드시 `-s`(빌드 생략, ~20초/사이클)로 돌 것. 10분 타임아웃은 «코드 변경 후 첫 빌드» 에만 허용.

전제: Mac 앱(daemon)이 실행 중이어야 한다 (`http://127.0.0.1:7777/health`). 안 떠 있으면
`/dev-mac` 으로 띄운다.

## 동작 원리 (페어링 부트스트랩)

- 시뮬레이터엔 카메라가 없어 QR 페어링이 불가 → **개발 페어링 주입**
  (`ios/PocketSisyphus/Services/DevPairing.swift`, DEBUG+시뮬레이터 전용)을 쓴다.
- 스크립트가 daemon `config.json` 의 평문 `token` + `localAdminSecret` 을
  `SIMCTL_CHILD_PS_DEV_*` 환경변수로 launch 에 실어 보내면, 앱이 스텁 페어링을 Keychain
  에 심고 SSH/Tor 없이 `127.0.0.1:7777` 로 직행한다.
- 실폰이 attest(Secure Enclave) 등록된 daemon 에서도: HTTP 는 `X-PS-Local` 헤더,
  WS 는 `?local=` query 로 localAdminSecret 게이트를 통과한다.
- **매 launch 마다 env 를 넘겨야 한다** (스크립트가 자동으로 함). env 없이 실행하면
  스텁 onion 으로 진짜 Tor 연결을 시도하다 실패한다.
- WS `?local=` 우회는 daemon 측 `verifyWsAttest` 변경(2026-06-11)이 필요 — 그보다 옛
  daemon 이 떠 있으면 HTTP 폴링은 정상이지만 WS 실시간 push 만 끊긴다 (화면 갱신이
  폴링 주기만큼 늦음). 그 경우 `/dev-mac` 으로 daemon 재빌드.

## 조작 (화면 전이)

1. **딥링크 우선** — `pocketsisyphus://session/<id>` 로 특정 세션 채팅 화면 진입.
   세션 id 는 daemon API 로 조회/생성:
   ```bash
   TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/Library/Application Support/PocketSisyphus/config.json'))['token'])")
   LOCAL=$(python3 -c "import json;print(json.load(open('$HOME/Library/Application Support/PocketSisyphus/config.json'))['localAdminSecret'])")
   curl -s -H "Authorization: Bearer $TOKEN" -H "X-PS-Local: $LOCAL" http://127.0.0.1:7777/api/sessions
   # 검증용 세션 생성 (shell agent 가 가볍다):
   curl -s -H "Authorization: Bearer $TOKEN" -H "X-PS-Local: $LOCAL" -H 'Content-Type: application/json' \
     -d '{"repoPath":"/tmp/ps-verify-repo","agent":"shell","title":"VERIFY"}' http://127.0.0.1:7777/api/sessions
   ```
2. **데이터 주입으로 상태 재현** — 같은 API 로 세션/메시지를 만들어 목록·배지 등 상태를
   재현한 뒤 `-s` 로 재실행·재촬영.
3. **터치 시퀀스가 꼭 필요하면** XCUITest (`ios/PocketSisyphusUITests`, `PocketSisyphusE2E`
   스킴) — 딥링크로 안 닿는 모달/제스처 흐름만. 비용이 크니 최후 수단.

## i18n 정적 점검 (스크린샷으로 못 보는 누락)

영어 로케일 스크린샷으로 **보이는** 한글 잔존은 잡지만, 안 보이는 화면·상태의 카탈로그
우회는 놓친다(HEAD 이력: 「ternary Text 번역 누락 12곳」 — 빌드는 통과한 채 비-ko 로케일에
ko 원문이 샜다). 문자열/번역이 닿는 변경이면 **코드 레벨로도** 점검한다:

```bash
./scripts/i18n-lint.sh            # 양갈래 한글 ternary·Text(String변수)·raw 한글 return·중첩 보간 후보
./scripts/i18n-lint.sh --orphans  # 위 + 카탈로그 orphan([O]) 점검(아래) — 죽은 키 유지보수 스윕
./scripts/i18n-lint.sh --coverage # 위 + 완역 커버리지([T]) 점검(아래) — knownRegions 각 로케일이 «실제로» 채워졌나
./scripts/i18n-lint.sh --strict   # CI 게이트(아래): A–D+[T] 차단·[O] 비차단·baseline 차감 (PR 에서 강제)
./scripts/design-lint.sh          # 리터럴 색(.orange/.yellow/.blue) 우회·흑백 하드코딩·전역 .tint() 번짐·아이콘 버튼 a11y 라벨 누락 후보
./scripts/po-agent-lint.sh        # PO 세션 spawn(collect/research/decide/cleanup/restart) 진입점의 agent passthrough 누락 후보 (ARCHITECTURE §14.4)
```

`경로:라인 — 패턴명 — 발췌` 로 후보가 뜬다. 이번 변경(diff)이 **새로 들인** 후보를 우선
본다 — 기존 i18n 부채까지 다 막는 도구는 아니다. 정말 번역 대상이 아니면 `Text(verbatim:)`
로 명시하면 스캔에서 빠진다. 후보가 있으면 종료코드가 비-0(게이트로 쓸지는 호출자 판단,
`--soft` 면 항상 0).

### orphan(죽은 카탈로그 키) — `--orphans` (옵트인 유지보수 스윕)

위 A–D 가 «소스→카탈로그 누수» 라면, `[O]` 는 **반대 방향** — 리팩터가 문자열을 바꾸거나
지워서 카탈로그에 «코드 어디서도 안 쓰이는 ko 키» 가 죽은 채 남는 드리프트를 잡는다. 보이진
않지만 (a) 번역비가 죽은 문자열에 계속 들고 (b) 비슷한 문자열을 다시 넣을 때 stale 번역이
끌려와 엉뚱하게 드리프트한다. 카탈로그 ko 키를 **보간 정규화**(`%@`/`%lld`/`%1$@`/`%.1f`/`%%`
↔ `\(…)`) 한 형태가 앱 소스의 어떤 문자열 리터럴과도 안 맞으면 `카탈로그 — [O] orphan(번역
N/L) — 발췌` 로 띄운다(번역 N/L 이 클수록 죽은 채 굳은 비용 ↑ = 우선 정리). 보간 정규화가
핵심이라, 안 하면 산 키(`변경 %lld개` ↔ 소스 `변경 \(n)개`)가 죄다 오탐 난다.

기본 실행엔 **포함 안 됨**(매 diff 게이트가 아니라 가끔 도는 청소). 「번역 닿는 큰 리팩터/
문자열 삭제」 뒤에 한 번 돌려 죽은 키를 회수한다. 단, **자동 삭제 안 함** — `Text(LocalizedStringKey(변수))`
처럼 키를 런타임에 동적 조회하는 자리는 정적으로 못 풀어 거짓 양성이 날 수 있다. 카탈로그에서
지우기 «전» 에 그 키가 정말 안 쓰이는지(런타임/백엔드 문자열 포함) 사람이 확인하고 지운다.

### 미완역(완역 커버리지) — `--coverage` (옵트인 미완역 게이트)

`[O]` 가 «코드가 안 쓰는 죽은 키» 라면, `[T]` 는 **그 반대** — 코드가 «쓰는»(=orphan 아닌) ko 키인데
`knownRegions`(각 앱 `project.yml` 의 SSOT, `Base`·source 제외)의 일부/전체 로케일이 (a) `stringUnit`/
`variations` 누락, (b) `value` 빈 문자열, (c) `state∈{new,needs_review}` 면 `카탈로그 — [T] 미완역(누락
N: 로케일들) — 발췌` 로 띄운다. CLAUDE.md 가 못박은 «자동 추출 ≠ 번역 완료» 회귀 — 영어 로케일에서
ko 가 새는 — 를 빌드 «전» 에 정적으로 막는다(Mac 신규 화면에서 «ko 만 보이던» 사고 이력). 로케일은
**하드코딩하지 않고** project.yml `knownRegions` 에서 읽는다. 비번역 의도(`shouldTranslate:false`,
또는 present 로케일이 모두 원문=식별자/단위)는 [O] 가 쓰는 휴리스틱을 재사용해 억제한다. `localizations`
가 «통째로 빈»(`{}`) 키는 추출만 되고 안 채워진 미완역이라 orphan 이어도 보고한다(그 외 «부분» 누락은
non-orphan 만 — orphan 부분누락은 [O] 소관).

기본 실행엔 **포함 안 됨**(옵트인). 새 문자열을 추가한 뒤 «10개 로케일이 다 채워졌는지» 를 한 번 돌려
확인한다. 약은 «번역 채움»(사람/번역 패치 스크립트)이지 자동 생성이 아니다 — 비번역 의도면
`Text(verbatim:)`·`shouldTranslate:false`·모든 로케일=원문 으로 명시하면 빠진다. 종료코드 규약 동일
(후보≥1→비-0, `--soft`→항상 0, `--quiet` 지원).

### CI 게이트 — `--strict` (PR 에서 강제)

`--coverage`/`--orphans` 가 옵트인이라 기본 실행에서 빠지고 CI 강제도 없어, 새 노출 문자열이
«번역 없이» 머지될 수 있었다. `--strict` 가 그 구멍을 막는 게이트다 — **A–D + [T] 를 차단**,
**[O] 를 비차단** 으로 묶는다([O] orphan 은 동적 조회로 거짓 양성이 날 수 있어 «사람 판정» 용
후보로만 표면화하고 게이트는 막지 않는다). 로케일은 `knownRegions`(SSOT)에서 읽고 **하드코딩하지
않는다**. 기존 부채로 CI 가 처음부터 빨개지지 않도록, **baseline**(`scripts/i18n-lint-baseline.tsv`,
`--baseline=PATH`·`I18N_LINT_BASELINE` 로 교체)에 등재된 차단 후보는 게이트에서 **차감** 한다 —
«새»(미등재) 차단 후보만 PR 을 막는다(레포의 «이 diff 가 새로 들인 후보에 집중» 래칫). 게이트가
막으면 후보의 fingerprint 를 `### BASELINE-PASTE-BEGIN..END` 블록으로 찍어 준다 — 알려진/의도된
부채면 그 줄을 그대로 baseline 에 붙이고, 진짜 누락이면 번역을 채우거나(카탈로그 우회를 고치거나)
한다. CI 는 매 PR 에서 `.github/workflows/i18n.yml` 로 `./scripts/i18n-lint.sh --strict` +
`./scripts/test-i18n-lint.sh`(검출 로직 self-test)를 돌린다.

스크린샷은 «보이는» 색만 본다 — 안 보이는 화면·상태의 색 정책 위반(CLAUDE.md 「색상 토큰 정책」 이
«어겨서 사고난 이력 있음» 이라 한 그 드리프트)은 `design-lint.sh` 가 텍스트로 잡는다. 같은 톤·계약:
`경로:라인  발췌  ← 위반 종류·권장 토큰` 후보가 뜨고, 이번 변경(diff)이 **새로 들인** 후보를 우선
보며(기존 색 부채까지 다 막진 않는다), 의도적이면 해당 라인에 `// design-lint: allow` 로 명시하면
빠진다. 종료코드 규약은 i18n-lint.sh 와 동일(후보≥1→비-0, `--soft`→항상 0). 단 «실제 대비비·
warning↔pro 의미 판별» 같이 렌더링이 필요한 점검은 이 린트가 아니라 위 스크린샷 «판정 기준» 의 몫이다.

스크린샷은 «도구가 무시되는» silent 회귀도 못 본다 — 사용자가 픽커로 고른 코드 에이전트가
PO 세션 spawn 진입점에서 daemon 으로 안 실리면 화면엔 토스트·에러 없이 항상 claude_code 로
폴백한다(ARCHITECTURE §14.4 «3회+ 반복된 버그»). `po-agent-lint.sh` 가 그 입구를 텍스트로
잡는다: **P1** iOS spawn 호출(startPoCollection/…/decidePoBrief)에 `agent:` 인자 누락,
**P2** 픽커(PoAgentSection)를 쓰는 화면에서 상태(shipped/rejected)별 액션에 픽커 미커버,
**P3** daemon `routes/po.ts` 핸들러가 `body.agent` 를 안 읽거나 세션 spawn 에 안 넘김. 같은
톤·계약(후보≥1→비-0, `--soft`→항상 0)이고, 정당한 «의도적 nil»(픽커 미노출/옛 daemon)은
호출에 `agent:` 라벨이 그대로라 후보가 아니다. 진짜 예외는 `// po-agent-lint: allow` 로 명시한다.
새 진입점은 스크립트 안 화이트리스트(메서드·라우트·spawn 헬퍼 이름) 한 곳에만 더하면 따라잡는다.

## 판정 기준

- 스크린샷에서 **변경한 UI 가 기대대로 그려졌는지** 를 본다 — 색 토큰(보라=accent,
  주황=pro, 노랑=warning), 레이아웃, 문자열(영어 로케일이면 한글 잔존 여부)까지.
- 연결 실패 화면/PairView 가 보이면 주입이 깨진 것: daemon 가동 여부 → env 전달 여부 →
  `xcrun simctl spawn booted log show --last 2m --predicate 'process == "PocketSisyphus"'`
  의 `[DevPairing]`/`[ConnMgr]` 로그 순으로 진단.
- 다른 로케일 확인: `xcrun simctl spawn booted defaults write pe.wayne.pocketsisyphus AppleLanguages '(en)'`
  후 `-s` 재실행 (검증 끝나면 `defaults delete` 로 원복).

## 시뮬레이터로 검증 불가능한 잔여면 — 이때만 사용자 검증 요청

- **햅틱/진동**, **카메라 QR 페어링 흐름 자체** (DevPairing 이 우회하는 그 경로),
- **Secure Enclave attest / Face ID 잠금(LockView)** — 시뮬레이터엔 SE 가 없다,
- **셀룰러/실네트워크/Tor 채널 품질** (시뮬레이터는 loopback 직행이라 happy eyeballs·
  Tor fallback 경로가 아예 실행되지 않음), **SSH 채널 연결 흐름** 동일,
- **실기기 성능/발열/백그라운드 suspend 동작**, **푸시/Discord 알림 → 딥링크 콜드런치**.

위 항목을 건드린 변경이면 그 부분만 명시해 사용자에게 실기기 확인을 요청하고,
나머지는 이 루프로 끝까지 스스로 검증한다.
