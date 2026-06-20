---
name: commit
description: >-
  현재 작업 트리의 변경을 이 저장소 컨벤션으로 커밋한다. 한국어 Conventional Commit
  (type(scope): 요약) + 본문 불릿 + Co-Authored-By 트레일러, 기본 브랜치(main) 직접 커밋.
  사용자가 "/commit", "커밋해라", "커밋 해줘", "지금까지 거 커밋" 등을 요청할 때 사용.
  인자로 요약 힌트를 주거나 "push" 를 붙일 수 있다. push 는 사용자가 명시할 때만 한다.
---

**English** · [한국어](SKILL.ko.md)

# /commit — Commit changes (repository convention)

Commit the current changes in this repository's style. Commits are made "only when the user requests it" — and the very fact that this skill was invoked is that request.

## Procedure

1. **Understand the changes** — actually look at what changed with `git status --short` and `git --no-pager diff` (and `git --no-pager diff --staged` too if anything is staged). Don't guess the message; write it based on the diff. If files unrelated to this work are mixed in, confirm with the user first.
2. **Staging** — only `git add <path>` the files relevant to this work. Don't include noise such as build artifacts / DerivedData / `/tmp` temp scripts / secrets. If things are already appropriately staged, leave them as is.
3. **Branch** — since this repository has a single solo worker, committing directly to `main` is the convention. If the current branch is main, commit there as is (don't carve out a new separate branch). If the user is on a different branch, commit to that branch.
4. **Commit** — build a message in the format below and commit with `git commit -F -` (heredoc).
5. **Report** — announce the commit hash + a one-line summary + the number of changed files. Only do `push` (`git push`) when the user explicitly says so; otherwise don't, and give a one-line note that "push will proceed on request".

## Commit message format

```
<type>(<scope>): <one-line Korean summary>

- Change point 1 (what / why)
- Change point 2
- …

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

- **type** — the nature of the change: `feat`(feature) / `fix`(bug) / `refactor`(structural improvement with unchanged behavior) /
  `chore`(build·tooling·config) / `test`(tests) / `docs`(docs) / `perf`(performance).
- **scope** — the area the change touched. This repo's convention: `ios` / `mac` / `daemon` / `e2e` / `dev` /
  `device` / `deploy` etc. If multiple, the single most central one.
- **summary** — Korean, in summary form, no period, around 50 characters. What changes, at a glance.
- **body** — Korean bullets covering "what·why". Can be omitted if the change is trivial. Long explanations go line by line.
- **trailer** — the last line must always include `Co-Authored-By`. The model name is per the current model
  (e.g. `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`).

If there are arguments (`$ARGUMENTS`), use them as hints for the summary/body. If the arguments include `push`, also do `git push` after the commit.

## Example

```
feat(ios): 채팅 입력바 멀티라인 + 키패드 재배치

- inputBar 를 axis:.vertical 멀티라인 + 전송 버튼으로 교체
- / ↔ 키보드 토글 위치 스왑, Enter/Space 가상 키 추가

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

## Cautions

- Don't let the diff and the message diverge — don't write up work you didn't do, or report something that failed as "passed".
- Check whether a secret key / `.env` / token / certificate got mixed into the staged set, and if so, remove it or warn the user.
- If you added new iOS user-facing Korean strings, confirm the catalog is filled per the i18n rules in `CLAUDE.md` before committing (so that untranslated ko source strings don't get committed).
- Hard-to-undo commands other than `git commit` (`push -f`, `reset --hard`, `rebase`, etc.) only when the user explicitly requests them.
