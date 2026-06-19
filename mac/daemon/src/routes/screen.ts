/**
 * /api/screen — 화면 «원샷» 스크린샷 (screen_shot_v1).
 *
 * 미러링의 «캡처/녹화 → 채팅 첨부» (버그 재현 전달) 데이터원. 라이브 미러링(WS, H.264)은
 * GPU 레이어로 직행해 iOS 쪽에서 정지 프레임을 뽑을 수 없으므로, 정지 컷은 daemon 이
 * macOS `screencapture(1)` 로 따로 떠서 HTTP 로 돌려준다. iOS 의 «녹화» 도 이 엔드포인트를
 * 주기 폴링해 시간순 프레임을 모은다 (영상 인코딩/전송 없이 단계 이미지들로 충분).
 *
 * TCC: 화면 기록 권한은 책임 프로세스(메인 Mac 앱)에 귀속된다 — 미러링(capture-helper)이
 * 동작하는 환경이면 screencapture 도 같은 권한으로 동작한다. 미승인이면 macOS 가 데스크탑
 * 배경만 찍거나 실패시킨다 (크래시 아님).
 *
 * Query:
 *  - display: 1-기반 디스플레이 번호 (screencapture -D 그대로). 생략 시 1 (주 모니터).
 *  - window: CGWindowID (screencapture -l 그대로, screen_window_target_v1). 지정 시 그 창만
 *    찍는다(display 무시) — 미러링이 창 스코프일 때 캡처/녹화도 같은 창만 담기게.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { bearerAuth } from "../auth.js";

const execFileAsync = promisify(execFile);

export const screen = new Hono();
screen.use("*", bearerAuth);

screen.get("/shot", async (c) => {
  const dRaw = c.req.query("display");
  // 상한 16 — 비정상 입력 가드 (실사용 멀티모니터는 2~3).
  const display = Math.min(16, Math.max(1, dRaw ? parseInt(dRaw, 10) || 1 : 1));
  const wRaw = c.req.query("window");
  const windowId = Math.max(0, wRaw ? parseInt(wRaw, 10) || 0 : 0);
  const tmp = path.join(os.tmpdir(), `ps-shot-${randomUUID()}.jpg`);
  try {
    // -x: 셔터음 없음, -C: 커서 포함 (버그 재현에서 «어디를 가리키는지» 가 정보다).
    // 창 스코프(-l)는 그 창만 — 커서는 전체 화면 합성이라 -C 가 안 먹지만 무해.
    const target = windowId > 0 ? ["-l", String(windowId)] : ["-D", String(display)];
    await execFileAsync(
      "/usr/sbin/screencapture",
      ["-x", "-C", "-t", "jpg", ...target, tmp],
      { timeout: 10_000 },
    );
    const buf = fs.readFileSync(tmp);
    if (buf.length === 0) return c.json({ error: "screenshot_empty" }, 500);
    return c.body(buf, 200, { "Content-Type": "image/jpeg" });
  } catch (e) {
    // 권한 미승인 / 디스플레이 번호 범위 밖 등 — 사유를 그대로 싣되 500 한 종류로.
    return c.json({ error: "screenshot_failed", message: (e as Error).message }, 500);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});
