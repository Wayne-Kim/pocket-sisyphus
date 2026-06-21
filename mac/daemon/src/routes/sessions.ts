import { Hono } from "hono";
import { bearerAuth } from "../auth.js";
import { registerCoreRoutes } from "./sessions.core.js";
import { registerGitRoutes } from "./sessions.git.js";
import { registerFsRoutes } from "./sessions.fs.js";
import { registerPtyRoutes } from "./sessions.pty.js";
import { registerMessagesRoutes } from "./sessions.messages.js";

// 세션 라우트는 책임별 서브-모듈로 분리돼 있다 (동작 보존 리팩터링):
//   - sessions.core     : 세션 CRUD (목록·생성·조회·수정·삭제·clear·usage)
//   - sessions.git      : 코드 변경 이력 (branch/status/diff/blob/commits/checkout/worktrees/checkpoint/rollback)
//   - sessions.fs       : 파일시스템 (list/file/raw/artifacts/attachments)
//   - sessions.pty      : 터미널 PTY (resize/key/control/restart/snapshot/notify-next-stop)
//   - sessions.messages : 메시지·폴링 (messages POST/GET·poll)
// 공용 헬퍼(createSession·resolveAndEnsureRepoDir·getSession·attentionFields·resolveRepoRelative)
// 는 sessions-shared 에 모인다. 경로·미들웨어·핸들러 본문은 분리 전과 1:1 동일.
//
// 외부(cron/executor·workflow·persona·po 등)가 import 하는 진입점이라
// createSession·resolveAndEnsureRepoDir 를 그대로 재-export 한다.
export { createSession, resolveAndEnsureRepoDir } from "./sessions-shared.js";

export const sessions = new Hono();

sessions.use("*", bearerAuth);

registerCoreRoutes(sessions);
registerGitRoutes(sessions);
registerFsRoutes(sessions);
registerPtyRoutes(sessions);
registerMessagesRoutes(sessions);
