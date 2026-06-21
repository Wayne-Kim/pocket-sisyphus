---
name: dev-web
description: >-
  web/ (Next.js) 프로젝트의 dev 서버를 실행한다. 의존성(pnpm)을 필요할 때만 설치하고,
  포트를 고정해 next dev 를 재기동한다(이미 떠 있으면 정리 후 다시). 사용자가 "/dev-web",
  "웹 띄워줘", "웹 dev 서버 실행", "next dev 돌려줘", "로컬 웹 켜줘" 등을 요청할 때 사용.
---

**English** · [한국어](SKILL.ko.md)

# /dev-web — run the web/ dev server

Brings up the development server for the `web/` Next.js app. All the logic lives in
`scripts/dev-web.sh` — this skill runs it **in the background**, confirms the server
came up, and reports the URL.

## Running

The dev server is a **long-lived** process — leaving it in the foreground will stall the
session. So launch it with `run_in_background: true`, and once the output shows
`Ready` / `Local: http://localhost:3000`, tell the user the URL.

```bash
./scripts/dev-web.sh
```

- Different port: `PS_WEB_PORT=4000 ./scripts/dev-web.sh`
- Auto-open the browser after start: `PS_WEB_OPEN=1 ./scripts/dev-web.sh`

After launching, check the background task output once to see «Ready», then report the
access URL (`http://localhost:<PORT>`) in a single line. Unlike build/install skills, it
doesn't finish but keeps serving, so handle shutdown by stopping that background task when
the user wants to.

## What it does

1. **install (pnpm)** — runs `pnpm install` (idempotent) only when `node_modules` is
   missing or `pnpm-lock.yaml` is newer. If pnpm isn't on PATH, tries `corepack enable`
   once.
2. **free port** — kills the process holding `PORT` (default 3000) so it always comes up
   at the same URL (next dev moves to the next port when the port is blocked, which makes
   the URL drift, so it frees it first).
3. **next dev** — execs `pnpm dev --port <PORT>` in the foreground (the script itself runs
   in the background, so the server stays alive).

## Prerequisites / caveats

- pnpm required (`pnpm-lock.yaml` is used). If absent, the script tries `corepack enable`,
  and if it's still missing it fails with «cannot find pnpm» — point the user to
  `brew install pnpm`.
- **free port kills «any» process on that port.** If another service is running on 3000 it
  will be killed too, so if a conflict is a concern, bring it up on a different port with
  `PS_WEB_PORT`.
- Next.js 16 — this version may differ from training data in its API/conventions (see
  `web/AGENTS.md`). If a code change is needed, read the guides under
  `web/node_modules/next/dist/docs/` first.

## On failure

- pnpm not installed → see the guidance above. install failure (network/lockfile) → pass
  the output through as-is.
- If it came up on a different port even after freeing the port (rare), report the actual
  `Local:` URL from the output.
