// 라이브 프리뷰 — «세션별로 명시 허용» 한 dev 서버 포트 등록부 (preview_proxy_v1).
//
// 보안 모델: sshd direct-tcpip 화이트리스트(PermitOpen)는 프리뷰 리버스 프록시의 «고정
// 포트» 하나만 연다. 실제 dev 포트(localhost:3000 류)는 절대 PermitOpen 에 들어가지 않고,
// 프록시가 이 등록부를 조회해 «등록된 (session, port)» 로만 forward 한다 — 기본 차단(default
// deny). 따라서 사용자가 세션 화면에서 포트를 명시 등록해야만 그 포트가 폰에 노출된다.
//
// 영속: preview_ports 테이블(세션 CASCADE). daemon 재시작/프록시 재기동에도 등록이 유지되고,
// 세션이 지워지면 함께 정리된다.

import { db } from "../db/index.js";

/** 한 세션에 등록된 프리뷰 포트 한 개. */
export type PreviewPortRow = {
  port: number;
  createdAt: number;
};

/** 등록 가능한 포트인지 «형식» 검증 결과. 허용이면 ok:true, 아니면 사유 코드. */
export type PortValidation =
  | { ok: true; port: number }
  | { ok: false; reason: "out_of_range" | "reserved" };

/**
 * dev 포트 등록 형식 검증. (1) 1024..65535 범위 — 시스템/특권 포트(<1024, 예: 22) 차단,
 * (2) daemon 자신이 쓰는 포트(HTTP/endpoint/sshd/프록시) 차단 — 프리뷰 프록시를 통해 daemon
 * 내부 API/SSH 로 우회 접근하는 것을 막는다. reserved 는 호출자(라우트)가 런타임 실제 포트로 채운다.
 */
export function validatePreviewPort(
  raw: unknown,
  reserved: Set<number>,
): PortValidation {
  const port = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return { ok: false, reason: "out_of_range" };
  }
  if (reserved.has(port)) {
    return { ok: false, reason: "reserved" };
  }
  return { ok: true, port };
}

/** 세션에 dev 포트를 등록(idempotent — 이미 있으면 그대로). */
export function registerPreviewPort(sessionId: string, port: number): void {
  db()
    .prepare(
      "INSERT OR IGNORE INTO preview_ports (session_id, port, created_at) VALUES (?, ?, ?)",
    )
    .run(sessionId, port, Date.now());
}

/** 세션의 dev 포트 등록 해제. */
export function unregisterPreviewPort(sessionId: string, port: number): void {
  db()
    .prepare("DELETE FROM preview_ports WHERE session_id = ? AND port = ?")
    .run(sessionId, port);
}

/** 세션에 등록된 프리뷰 포트 목록 (최근 등록 우선). */
export function listPreviewPorts(sessionId: string): PreviewPortRow[] {
  return db()
    .prepare(
      "SELECT port, created_at FROM preview_ports WHERE session_id = ? ORDER BY created_at DESC",
    )
    .all(sessionId)
    .map((r) => {
      const row = r as { port: number; created_at: number };
      return { port: row.port, createdAt: row.created_at };
    });
}

/** 프록시 게이트 — 이 (세션, 포트) 조합이 등록돼 있는가. 기본 차단의 단일 판정점. */
export function isPreviewPortAllowed(sessionId: string, port: number): boolean {
  const row = db()
    .prepare(
      "SELECT 1 FROM preview_ports WHERE session_id = ? AND port = ? LIMIT 1",
    )
    .get(sessionId, port);
  return row !== undefined;
}
