import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { isPortFree, findAvailablePort } from "./ports.js";

const HOST = "127.0.0.1";
const openServers: net.Server[] = [];

function occupy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(port, HOST, () => {
      openServers.push(srv);
      resolve();
    });
  });
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (s) => new Promise<void>((r) => s.close(() => r())),
    ),
  );
});

describe("isPortFree", () => {
  it("점유된 포트는 false, 빈 포트는 true", async () => {
    // OS 가 할당한 빈 포트를 하나 잡아 점유 → 그 포트는 false.
    const probe = net.createServer();
    const port: number = await new Promise((resolve) => {
      probe.listen(0, HOST, () => {
        const a = probe.address();
        resolve(typeof a === "object" && a ? a.port : 0);
      });
    });
    openServers.push(probe);
    expect(await isPortFree(port, HOST)).toBe(false);
    await new Promise<void>((r) => probe.close(() => r()));
    openServers.splice(openServers.indexOf(probe), 1);
    expect(await isPortFree(port, HOST)).toBe(true);
  });
});

describe("findAvailablePort", () => {
  it("선호 포트가 비어 있으면 그대로 (fellBack=false)", async () => {
    const probe = net.createServer();
    const port: number = await new Promise((resolve) => {
      probe.listen(0, HOST, () => {
        const a = probe.address();
        resolve(typeof a === "object" && a ? a.port : 0);
      });
    });
    await new Promise<void>((r) => probe.close(() => r()));
    const r = await findAvailablePort(port, HOST);
    expect(r).toEqual({ port, fellBack: false });
  });

  it("선호 포트가 점유돼 있으면 다른 빈 포트로 폴백 (fellBack=true)", async () => {
    // 50000 대 한 포트를 점유. 그 포트로 findAvailablePort → 다른 포트 반환.
    const base = 50000;
    // 비어 있는 base 를 찾고 점유.
    let p = base;
    while (!(await isPortFree(p, HOST))) p++;
    await occupy(p);
    const r = await findAvailablePort(p, HOST);
    expect(r.fellBack).toBe(true);
    expect(r.port).not.toBe(p);
    expect(await isPortFree(r.port, HOST)).toBe(true);
  });

  it("exclude 에 든 포트는 건너뛴다", async () => {
    let p = 51000;
    while (!(await isPortFree(p, HOST))) p++;
    await occupy(p); // 선호 포트 점유
    const skip = p + 1; // 바로 다음 후보를 exclude
    const r = await findAvailablePort(p, HOST, new Set([skip]));
    expect(r.fellBack).toBe(true);
    expect(r.port).not.toBe(p);
    expect(r.port).not.toBe(skip);
  });
});
