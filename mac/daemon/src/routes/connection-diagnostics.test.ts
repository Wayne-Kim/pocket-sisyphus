// `routes/connection-diagnostics` — 연결 진단 엔드포인트 계약 테스트.
//
// 계약:
//  - GET /api/connection-diagnostics (bearer) → 200 + { v:1, generatedAt, overall, subsystems[] },
//    서브시스템 7종(tor/sshd/reachability/agent_cli/disk/logs/network) 포함. bearer 없으면 401.
//  - 재현 시나리오가 정확한 코드를 내보내는지: (a) onion 미게시 → tor_descriptor_missing,
//    (b) LAN 전용 + 후보 0 → lan_blocked_no_public_fallback, (c) 에이전트 CLI 미설치 →
//    agent_cli_missing (+ installHint detail). overall 은 가장 나쁜 심각도.
//
// bearerAuth 만 config 를 읽으므로 config.js 의 readConfig 만 mock (토큰 제공). 스냅샷 신호는
// 전부 deps 주입이라 실제 Tor/sshd/디스크 없이 결정적으로 검증한다.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const TEST_TOKEN = "diag-test-token";
  const tokenHash = crypto.createHash("sha256").update(TEST_TOKEN).digest("hex");
  return { TEST_TOKEN, tokenHash };
});

vi.mock("../config.js", () => ({
  readConfig: () => ({
    port: 7777,
    token: H.TEST_TOKEN,
    tokenHash: H.tokenHash,
    createdAt: 0,
  }),
}));

const { connectionDiagnosticsRoute, buildDiagnosticsSnapshot } = await import(
  "./connection-diagnostics.js"
);
const { invalidateAuthCache } = await import("../auth.js");

/** 주입 deps 타입 — buildDiagnosticsSnapshot 의 첫 인자에서 그대로 끌어온다. */
type Deps = Parameters<typeof buildDiagnosticsSnapshot>[0];

const AUTH = { authorization: `Bearer ${H.TEST_TOKEN}` };
const GiB = 1024 ** 3;

/** 「전부 정상」 기본 deps — 시나리오 테스트는 일부만 override 한다. */
function healthyDeps(over: Partial<Deps> = {}): Deps {
  return {
    getTorProcessAlive: () => true,
    getTorBootstrapPercent: () => 100,
    getOnionAddress: () => "abc123.onion",
    getSshListening: () => true,
    getSshPort: () => 22022,
    getDiskFree: () => ({ freeBytes: 200 * GiB, totalBytes: 500 * GiB }),
    listAgentCli: () => [{ id: "claude_code", displayName: "Claude Code", detected: true }],
    isLanOnly: () => false,
    getLanCandidateCount: () => 2,
    getUnifiedLogBytes: () => 1024,
    getPtyChunkCount: () => 10,
    getExternalIPv4: () => "203.0.113.5",
    getIpFetchedAt: () => 1000,
    getLastIpChangeAt: () => null,
    getLastReconnectAt: () => null,
    now: () => 12345,
    ...over,
  };
}

function buildApp(deps: Deps): Hono {
  const app = new Hono();
  app.route("/api/connection-diagnostics", connectionDiagnosticsRoute(deps));
  return app;
}

beforeEach(() => invalidateAuthCache());

describe("buildDiagnosticsSnapshot — shape", () => {
  it("v:1 + overall + 서브시스템 7종을 모두 포함", () => {
    const snap = buildDiagnosticsSnapshot(healthyDeps());
    expect(snap.v).toBe(1);
    expect(snap.generatedAt).toBe(12345);
    expect(snap.overall).toBe("ok");
    expect(snap.subsystems.map((s) => s.id).sort()).toEqual(
      ["agent_cli", "disk", "logs", "network", "reachability", "sshd", "tor"].sort(),
    );
  });

  it("정상 환경의 모든 서브시스템 level = ok", () => {
    const snap = buildDiagnosticsSnapshot(healthyDeps());
    for (const s of snap.subsystems) expect(s.level).toBe("ok");
  });

  it("외부 IPv4 «값» 은 싣지 않고 존재 여부만 노출", () => {
    const snap = buildDiagnosticsSnapshot(healthyDeps());
    const net = snap.subsystems.find((s) => s.id === "network");
    expect(net?.metrics?.externalIPv4Present).toBe(true);
    expect(JSON.stringify(snap)).not.toContain("203.0.113.5");
  });
});

describe("재현 시나리오 — 정확한 코드", () => {
  it("(a) onion 미게시 → tor_descriptor_missing (error) + overall error", () => {
    const snap = buildDiagnosticsSnapshot(healthyDeps({ getOnionAddress: () => null }));
    const tor = snap.subsystems.find((s) => s.id === "tor");
    expect(tor?.level).toBe("error");
    expect(tor?.code).toBe("tor_descriptor_missing");
    expect(tor?.metrics?.onionPublished).toBe(false);
    expect(snap.overall).toBe("error");
  });

  it("(b) LAN 전용 + 후보 0 → lan_blocked_no_public_fallback (error)", () => {
    const snap = buildDiagnosticsSnapshot(
      healthyDeps({ isLanOnly: () => true, getLanCandidateCount: () => 0 }),
    );
    const reach = snap.subsystems.find((s) => s.id === "reachability");
    expect(reach?.level).toBe("error");
    expect(reach?.code).toBe("lan_blocked_no_public_fallback");
    expect(reach?.metrics?.lanOnly).toBe(true);
    expect(reach?.metrics?.lanCandidateCount).toBe(0);
  });

  it("(c) 에이전트 CLI 미설치 → agent_cli_missing (warning) + installHint detail", () => {
    const snap = buildDiagnosticsSnapshot(
      healthyDeps({
        listAgentCli: () => [
          { id: "claude_code", displayName: "Claude Code", detected: true },
          {
            id: "codex",
            displayName: "Codex",
            detected: false,
            installHint: "npm install -g @openai/codex",
          },
        ],
      }),
    );
    const agent = snap.subsystems.find((s) => s.id === "agent_cli");
    expect(agent?.level).toBe("warning");
    expect(agent?.code).toBe("agent_cli_missing");
    const missing = agent?.items?.find((i) => i.id === "codex");
    expect(missing?.level).toBe("warning");
    expect(missing?.code).toBe("agent_cli_missing");
    expect(missing?.detail).toBe("npm install -g @openai/codex");
    // 설치된 항목엔 detail 이 없다.
    expect(agent?.items?.find((i) => i.id === "claude_code")?.detail).toBeUndefined();
    // 한 서브시스템만 warning → overall warning.
    expect(snap.overall).toBe("warning");
  });
});

describe("HTTP 계약 (bearer)", () => {
  it("bearer 있으면 200 + v:1", async () => {
    const res = await buildApp(healthyDeps()).request("/api/connection-diagnostics", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { v: number; subsystems: unknown[] };
    expect(body.v).toBe(1);
    expect(Array.isArray(body.subsystems)).toBe(true);
  });

  it("bearer 없으면 401", async () => {
    const res = await buildApp(healthyDeps()).request("/api/connection-diagnostics");
    expect(res.status).toBe(401);
  });
});
