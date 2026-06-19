---
name: dev-web
description: >-
  web/ (Next.js) 프로젝트의 dev 서버를 실행한다. 의존성(pnpm)을 필요할 때만 설치하고,
  포트를 고정해 next dev 를 재기동한다(이미 떠 있으면 정리 후 다시). 사용자가 "/dev-web",
  "웹 띄워줘", "웹 dev 서버 실행", "next dev 돌려줘", "로컬 웹 켜줘" 등을 요청할 때 사용.
---

# /dev-web — web/ dev 서버 실행

`web/` Next.js 앱의 개발 서버를 띄운다. 모든 로직은 `scripts/dev-web.sh` 에 있다 — 이
스킬은 그것을 **백그라운드로** 실행하고, 서버가 떴는지 확인한 뒤 URL 을 보고한다.

## 실행

dev 서버는 «오래 사는» 프로세스다 — foreground 로 두면 세션이 멈춘다. 그러니
`run_in_background: true` 로 띄우고, 출력에 `Ready` / `Local: http://localhost:3000`
이 보이면 사용자에게 URL 을 알린다.

```bash
./scripts/dev-web.sh
```

- 다른 포트: `PS_WEB_PORT=4000 ./scripts/dev-web.sh`
- 시작 후 브라우저 자동 열기: `PS_WEB_OPEN=1 ./scripts/dev-web.sh`

띄운 뒤엔 백그라운드 태스크 출력을 한 번 확인해 «Ready» 를 본 다음, 접속 URL
(`http://localhost:<PORT>`)을 한 줄로 보고한다. 빌드/설치형 스킬과 달리 끝나지 않고 계속
서빙하므로, 종료는 사용자가 원할 때 그 백그라운드 태스크를 멈춰 처리한다.

## 동작 요약

1. **install (pnpm)** — `node_modules` 가 없거나 `pnpm-lock.yaml` 이 더 최신일 때만
   `pnpm install` (멱등). pnpm 이 PATH 에 없으면 `corepack enable` 로 한 번 시도.
2. **free port** — `PORT`(기본 3000)를 점유한 프로세스를 종료해 매번 같은 URL 로 뜨게 한다
   (next dev 는 포트가 막히면 다음 포트로 옮겨가 URL 이 흔들리므로 먼저 비운다).
3. **next dev** — `pnpm dev --port <PORT>` 를 foreground 로 exec (스크립트 자체가
   백그라운드라 서버가 살아 있음).

## 전제 / 주의

- pnpm 필요 (`pnpm-lock.yaml` 사용). 없으면 스크립트가 `corepack enable` 을 시도하고,
  그래도 없으면 «pnpm 을 찾을 수 없음» 으로 실패 — `brew install pnpm` 안내.
- **free port 는 그 포트의 «아무» 프로세스나 죽인다.** 3000 번에 다른 서비스가 떠 있으면
  같이 종료되니, 충돌이 우려되면 `PS_WEB_PORT` 로 포트를 바꿔 띄운다.
- Next.js 16 — 이 버전은 학습 데이터와 API/관례가 다를 수 있다(`web/AGENTS.md` 참고).
  코드 수정이 필요하면 `web/node_modules/next/dist/docs/` 의 가이드를 먼저 읽는다.

## 실패 시

- pnpm 미설치 → 위 안내. install 실패(네트워크/lockfile) → 출력 그대로 전달.
- 포트 정리 후에도 다른 포트로 떴다면(드묾) 출력의 실제 `Local:` URL 을 보고한다.
