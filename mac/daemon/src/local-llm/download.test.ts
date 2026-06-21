/**
 * 다운로드 매니저 — 동기 가드/판정 로직 단위 테스트 (dep 주입). byte 스트리밍 자체는
 * e2e 로 검증하고, 여기선 디스크 가드 / 완료판정 / 삭제 가드를 회귀 차단.
 */
import { describe, it, expect } from "vitest";
import {
  hasEnoughDisk,
  diskNeedBytes,
  isModelDownloaded,
  listDownloaded,
  deleteDownloadedModel,
  startDownload,
  getDownloadProgress,
  type DownloadDeps,
} from "./download.js";
import { getCatalogModel } from "./catalog.js";

const GiB = 1024 ** 3;
const small = getCatalogModel("qwen3-8b-q4")!; // 5_027_784_512

function deps(over: Partial<DownloadDeps>): DownloadDeps {
  return {
    existsSync: () => false,
    statSizeBytes: () => {
      throw new Error("nofile");
    },
    freeBytes: () => 0,
    mkdirp: () => {},
    unlink: () => {},
    hashFile: async () => "",
    resolveAria2: () => null,
    spawn: (() => {
      throw new Error("no spawn");
    }) as unknown as DownloadDeps["spawn"],
    fetch: (async () => {
      throw new Error("no fetch");
    }) as unknown as DownloadDeps["fetch"],
    modelsDir: "/fake/models",
    ...over,
  };
}

describe("disk guard", () => {
  it("need = 남은량 + 10GB", () => {
    expect(diskNeedBytes(small, 0)).toBe(small.fileSizeBytes + 10 * GiB);
  });
  it("resume 시 이미 받은 만큼 필요량이 줄어든다", () => {
    expect(diskNeedBytes(small, small.fileSizeBytes)).toBe(10 * GiB);
  });
  it("여유 < 필요 → 거부", () => {
    expect(hasEnoughDisk(small, 0, 4 * GiB)).toBe(false);
  });
  it("여유 ≥ 필요 → 허용", () => {
    expect(hasEnoughDisk(small, 0, small.fileSizeBytes + 11 * GiB)).toBe(true);
  });
});

describe("isModelDownloaded / listDownloaded", () => {
  it("크기 정확 일치해야 다운로드됨으로 본다", () => {
    const d = deps({
      modelsDir: "/fake/models",
      existsSync: () => true,
      statSizeBytes: () => small.fileSizeBytes,
    });
    expect(isModelDownloaded(small, d)).toBe(true);
    expect(listDownloaded(d)).toContain(small.id);
  });
  it("partial(작은 크기) 은 다운로드 안 됨으로 본다", () => {
    const d = deps({
      modelsDir: "/fake/models",
      existsSync: () => true,
      statSizeBytes: () => 100,
    });
    expect(isModelDownloaded(small, d)).toBe(false);
  });
  it("파일 없으면 false", () => {
    expect(isModelDownloaded(small, deps({ existsSync: () => false }))).toBe(false);
  });
});

describe("deleteDownloadedModel", () => {
  it("존재하면 unlink 호출하고 ok", () => {
    let unlinked = "";
    const d = deps({ existsSync: () => true, unlink: (p) => (unlinked = p) });
    expect(deleteDownloadedModel(small, d).ok).toBe(true);
    expect(unlinked).toContain(small.fileName);
  });
});

describe("startDownload — fresh Mac (models 디렉토리 부재)", () => {
  it("디스크 여유를 재기 «전에» modelsDir 를 만든다 (statfs ENOENT 즉사 회귀 차단)", async () => {
    // statfs(=freeBytes) 는 존재하는 경로만 잴 수 있다는 현실을 모사: mkdirp 전에 부르면 throw.
    const order: string[] = [];
    let dirMade = false;
    const fakeProc = {
      on(ev: string, cb: (...a: unknown[]) => void) {
        if (ev === "exit") queueMicrotask(() => cb(0, null)); // aria2c 즉시 성공 종료
        return fakeProc;
      },
      kill() {},
    };
    const d = deps({
      existsSync: () => false, // dest 파일 없음 → 정상 다운로드 경로
      statSizeBytes: () => {
        throw new Error("nofile");
      },
      mkdirp: () => {
        dirMade = true;
        order.push("mkdirp");
      },
      freeBytes: () => {
        order.push("freeBytes");
        if (!dirMade) throw new Error("ENOENT: statfs on missing dir");
        return small.fileSizeBytes + 11 * GiB; // 충분
      },
      resolveAria2: () => "/fake/aria2c",
      spawn: (() => fakeProc) as unknown as DownloadDeps["spawn"],
      hashFile: async () => small.sha256!, // 무결성 통과 → ready
    });

    // 옛 순서(freeBytes→mkdirp)였다면 여기서 download_failed 로 즉사하며 throw 했다.
    await expect(startDownload(small, d)).resolves.toBeUndefined();
    expect(order).toEqual(["mkdirp", "freeBytes"]);

    // fire-and-forget 본체(aria 종료→검증→ready) 가 끝날 때까지 한 틱 양보.
    await new Promise((r) => setTimeout(r, 0));
    expect(getDownloadProgress().state).toBe("ready");
  });
});
