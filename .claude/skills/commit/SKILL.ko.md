---
name: commit
description: >-
  현재 작업 트리의 변경을 이 저장소 컨벤션으로 커밋한다. 한국어 Conventional Commit
  (type(scope): 요약) + 본문 불릿 + Co-Authored-By 트레일러, 기본 브랜치(main) 직접 커밋.
  사용자가 "/commit", "커밋해라", "커밋 해줘", "지금까지 거 커밋" 등을 요청할 때 사용.
  인자로 요약 힌트를 주거나 "push" 를 붙일 수 있다. push 는 사용자가 명시할 때만 한다.
---

[English](SKILL.md) · **한국어**

# /commit — 변경 커밋 (저장소 컨벤션)

현재 변경을 이 저장소 스타일로 커밋한다. 커밋은 «사용자가 요청할 때만» 하는데, 이 스킬이
호출됐다는 것 자체가 그 요청이다.

## 절차

1. **변경 파악** — `git status --short` 와 `git --no-pager diff` (스테이징된 게 있으면
   `git --no-pager diff --staged` 도) 로 무엇이 바뀌었는지 실제로 본다. 메시지는 추측하지
   말고 diff 에 근거해 쓴다. 이번 작업과 무관한 파일이 섞여 있으면 사용자에게 먼저 확인.
2. **스테이징** — 이번 작업과 관련된 파일만 `git add <경로>`. 빌드 산출물 / DerivedData /
   `/tmp` 임시 스크립트 / 비밀값 등 노이즈는 넣지 않는다. 이미 적절히 staged 면 그대로 둔다.
3. **브랜치** — 이 저장소는 단독 작업자라 `main` 직접 커밋이 관례다. 현재 브랜치가 main 이면
   그대로 커밋한다 (별도 브랜치를 새로 파지 않는다). 사용자가 다른 브랜치에 있으면 그 브랜치에.
4. **커밋** — 아래 형식의 메시지를 만들어 `git commit -F -` (heredoc) 로 커밋한다.
5. **보고** — 커밋 해시 + 한 줄 요약 + 변경 파일 수를 알린다. `push` 는 사용자가 명시했을
   때만 (`git push`) 하고, 아니면 하지 않고 "push 는 요청 시 진행" 이라고 한 줄 안내한다.

## 커밋 메시지 형식

```
<type>(<scope>): <한국어 요약 한 줄>

- 변경 핵심 1 (무엇을 / 왜)
- 변경 핵심 2
- …

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

- **type** — 변경 성격: `feat`(기능) / `fix`(버그) / `refactor`(동작 불변 구조 개선) /
  `chore`(빌드·툴·설정) / `test`(테스트) / `docs`(문서) / `perf`(성능).
- **scope** — 변경이 닿은 영역. 이 repo 관례: `ios` / `mac` / `daemon` / `e2e` / `dev` /
  `device` / `deploy` 등. 여러 곳이면 가장 핵심 하나.
- **요약** — 한국어, 요약형, 마침표 없이 50자 안팎. 무엇이 바뀌는지 한눈에.
- **본문** — 한국어 불릿으로 «무엇을·왜». 변경이 사소하면 생략 가능. 긴 설명은 줄 단위로.
- **트레일러** — 마지막 줄에 반드시 `Co-Authored-By` 를 붙인다. 모델 이름은 현재 모델 기준
  (예: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`).

인자(`$ARGUMENTS`)가 있으면 요약/본문의 힌트로 삼는다. 인자에 `push` 가 포함돼 있으면 커밋
뒤 `git push` 까지 한다.

## 예시

```
feat(ios): 채팅 입력바 멀티라인 + 키패드 재배치

- inputBar 를 axis:.vertical 멀티라인 + 전송 버튼으로 교체
- / ↔ 키보드 토글 위치 스왑, Enter/Space 가상 키 추가

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

## 주의

- diff 와 메시지가 어긋나지 않게 한다 — 안 한 일을 적거나, 실패한 걸 «통과» 로 적지 않는다.
- 비밀키 / `.env` / 토큰 / 인증서가 staged 에 섞였는지 확인하고, 있으면 빼거나 사용자에게 경고.
- iOS 사용자 노출 한국어 문자열을 새로 추가했다면 `CLAUDE.md` 의 다국어 규칙대로 카탈로그가
  채워졌는지 확인한 뒤 커밋한다 (미번역 ko 원문만 커밋되지 않게).
- `git commit` 외의 되돌리기 어려운 명령(`push -f`, `reset --hard`, `rebase` 등)은 사용자가
  명시적으로 요청할 때만.
