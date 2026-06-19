// 포트 가용성 확인 + 충돌 시 자동 폴백.
//
// daemon HTTP(7777) / endpoint(7778) 는 127.0.0.1 로컬 포트라, 환경에 따라 다른 프로그램이
// 이미 그 포트를 쓰고 있으면 serve() 가 EADDRINUSE 로 실패한다. 우리 stale 인스턴스는
// reclaimStaleDaemon 이 먼저 정리하므로, 그 후에도 남은 점유는 «무관한 프로그램» — 이 경우
// 죽이지 않고 빈 포트로 폴백해 우리 daemon 이 어쨌든 뜨게 한다.
//
// 폴백 포트는 endpoint 응답(daemon_local_port) / sshd_config 의 PermitOpen / tor targetPort
// 로 실제 바인딩 값이 그대로 전달되므로(server.ts 가 info.port 를 사용), 폰은 /endpoint 를
// 다시 받아 새 포트로 자동으로 따라온다.

import net from "node:net";

/** host:port 에 listen 시도해 비어 있는지 확인. 점유/에러면 false. */
export function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => {
      srv.close(() => resolve(true));
    });
    try {
      srv.listen(port, host);
    } catch {
      resolve(false);
    }
  });
}

/** OS 가 할당하는 임시(ephemeral) 포트 하나. listen(0) 후 배정된 포트를 읽고 닫는다. */
function ephemeralPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (p > 0 ? resolve(p) : reject(new Error("ephemeral port 0"))));
    });
  });
}

export type ResolvedPort = { port: number; fellBack: boolean };

/**
 * `preferred` 가 비어 있으면 그대로 사용. 점유돼 있으면 preferred+1..+range 중 첫 빈 포트,
 * 그것도 없으면 OS 할당 임시 포트로 폴백한다. `exclude` 의 포트(동시에 띄울 다른 listener)는
 * 건너뛴다.
 */
export async function findAvailablePort(
  preferred: number,
  host: string,
  exclude: Set<number> = new Set(),
  range = 20,
): Promise<ResolvedPort> {
  if (!exclude.has(preferred) && (await isPortFree(preferred, host))) {
    return { port: preferred, fellBack: false };
  }
  for (let p = preferred + 1; p <= preferred + range && p <= 65535; p++) {
    if (exclude.has(p)) continue;
    if (await isPortFree(p, host)) return { port: p, fellBack: true };
  }
  return { port: await ephemeralPort(host), fellBack: true };
}
