---
name: dev-mac
description: >-
  macOS 에서 실행 중인 Pocket Sisyphus Mac 앱을 (GUI 앱 + 자식 daemon/tor/sshd + 과거 dev
  빌드 orphan 까지) 완전히 종료하고, Debug dev 빌드를 새로 빌드해 재실행한다. daemon 코드를
  바꾼 뒤 stale daemon 없이 실기 검증할 때 쓴다. 사용자가 "/dev-mac", "맥 앱 완전 종료하고
  재실행", "포켓 맥 재시작", "dev 맥 다시 띄워", "Mac 앱 깨끗하게 재실행" 등을 요청할 때 사용.
---

**English** · [한국어](SKILL.ko.md)

# /dev-mac — Fully terminate the Mac app + dev re-launch

Terminates the running `PocketSisyphusMac` along with its child processes (daemon node / tor / sshd) and any
orphans left behind by past dev builds, then builds and runs a fresh Debug dev build. All the logic lives in
`scripts/dev-mac.sh` — this skill runs it and reports the result.

## Why this is separate, not `/dev mac`

`/dev mac` kills **only the GUI process** with `pkill -x PocketSisyphusMac` → the
daemon(node)/tor/sshd children the app launched survive as orphans. If you verify after changing daemon code,
the "old daemon" keeps serving so the new code appears not to run (it's actually been confirmed that
daemon/tor/sshd orphans left by past dev runs pile up in `ps`). `/dev-mac` cleans up even the children tied to
the bundle path (`PocketSisyphusMac.app/Contents`), leaving **only the new build's daemon**.

## Run

No arguments. The build can take several minutes, so run it in the foreground with a generous timeout and relay
the output directly to the user.

```bash
./scripts/dev-mac.sh
```

If you changed `project.yml`, also regenerate via xcodegen with `PS_DEV_REGEN=1 ./scripts/dev-mac.sh`.

## Behavior summary

1. **build (Debug, macOS)** — during the build, the old app stays up so downtime is deferred until the build ends.
2. **full termination** — `pkill -f 'PocketSisyphusMac.app/Contents'` (SIGTERM → recheck → SIGKILL)
   for the GUI app + daemon/tor/sshd children + DerivedData dev orphans. The build itself
   (`xcodebuild -scheme PocketSisyphusMac`) has a non-overlapping cmdline, so there's no risk of killing the build.
   Reports the process count before/after termination in one line.
3. **re-launch** — `open` the new Debug `.app`.

## Prerequisites / cautions

- During re-launch the daemon is restarted, so a connected phone briefly disconnects and reconnects to the new daemon.
- Being a Debug build, it includes nested daemon/tor/sshd signing — if there's no signing identity, it fails at the build step.
- If processes remain even after termination ("N still remaining"), it may be a permission/zombie issue — relay it as is to the user.

## Safety protocol (confirm "before" running — violating it causes incidents)

`/dev-mac` force-terminates and restarts the daemon, and the new build takes over the port/configDir. So it doesn't
end with just "connection briefly drops and reconnects" — if you don't observe the following, **in-progress work
gets lost or the phone can't connect at all**. Before running, confirm the following in order:

1. **If there's an in-progress agent session, finish it first.** On daemon restart, an "in-progress turn" is not
   recovered — if the model is mid-write of a response or mid-tool-execution, that whole turn is lost. If a session
   is running, wait for it to finish, or run only after getting explicit confirmation from the user ("is it OK to
   cut off the in-progress session?").
2. **If the Release (/Applications) app is up, terminate one of them first.** The dev build and Release
   **share the same configDir and port 7777** — if both are up at once, the port collides so the **phone cannot
   connect** and the configDir can get tangled. To verify with dev, terminate the Release app first
   (`/dev-mac`'s KILL pattern does "not" kill Release — terminate it yourself), and vice versa.
3. **"Right after" launch, visually confirm two things in the Mac menu.** (a) that there is "no" port-collision
   warning, and (b) that the phone "reconnected" to the new daemon. If either is off, recheck 1~2 above.

> Preflight guard: once `scripts/dev-mac.sh` auto-checks 1~2 above (detect in-progress session · Release
> co-running, then abort/confirm), document in this section what the guard blocks and how to bypass it (`--force`
> etc.). The current script has no guard, so the checks above are "manual".

## On failure

The script fails fast and prints the last 40 lines on build failure. Relay it as is, and flag if a code/signing
config fix is needed.
