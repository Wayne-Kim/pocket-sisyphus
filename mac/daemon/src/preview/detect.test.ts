import { describe, it, expect } from "vitest";
import { parseLsofListeners, detectListeningPorts } from "./detect.js";

describe("parseLsofListeners", () => {
  it("p/c/n 필드를 (pid, command, port) 로 묶는다", () => {
    const out = ["p3000", "cnode", "n*:5173"].join("\n");
    expect(parseLsofListeners(out)).toEqual([
      { pid: 3000, command: "node", port: 5173 },
    ]);
  });

  it("한 프로세스의 여러 소켓(IPv4/IPv6)을 각각 잡는다", () => {
    const out = ["p42", "cvite", "n127.0.0.1:3001", "n[::1]:3001"].join("\n");
    expect(parseLsofListeners(out)).toEqual([
      { pid: 42, command: "vite", port: 3001 },
      { pid: 42, command: "vite", port: 3001 },
    ]);
  });

  it("여러 프로세스 — command 가 다음 p 에서 리셋된다", () => {
    const out = [
      "p10",
      "cnode",
      "n*:3000",
      "p20",
      "cpython3",
      "n*:8080",
    ].join("\n");
    expect(parseLsofListeners(out)).toEqual([
      { pid: 10, command: "node", port: 3000 },
      { pid: 20, command: "python3", port: 8080 },
    ]);
  });

  it("localhost 호스트명 표기에서도 포트를 뽑는다", () => {
    const out = ["p7", "cnext", "nlocalhost:4321"].join("\n");
    expect(parseLsofListeners(out)).toEqual([
      { pid: 7, command: "next", port: 4321 },
    ]);
  });

  it("포트 없는/깨진 주소는 버린다", () => {
    const out = ["p7", "cnode", "nsomething", "n*:0"].join("\n");
    expect(parseLsofListeners(out)).toEqual([]);
  });
});

describe("detectListeningPorts", () => {
  it("PTY 미가동(null/<=1) 이면 빈 배열 — lsof 도 안 부른다", () => {
    expect(detectListeningPorts(null)).toEqual([]);
    expect(detectListeningPorts(0)).toEqual([]);
    expect(detectListeningPorts(1)).toEqual([]);
  });
});
