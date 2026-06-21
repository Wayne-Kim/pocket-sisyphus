/**
 * Mac 하드웨어 감지 + RAM 예산 기반 모델 추천.
 *
 * resolve-binary.ts 와 같은 split: 순수 코어(recommendModel) + dep 주입 detector
 * (detectHardware) — 순수 코어는 host-less 단위 테스트 가능.
 *
 * 추천 예산 (메모리 예산 근거):
 *   - «추천»: estRss/totalRam ≤ 0.70  AND  totalRam ≥ recommendedRamBytes
 *   - 추천 후보가 없으면 «허용» fallback: totalRam ≥ minRamBytes AND estRss/totalRam ≤ 0.85
 *   - 둘 다 없으면 null (이 Mac 으로는 어떤 모델도 권장 불가)
 * 항상 가장 큰(estRss 큰) 후보를 우선한다.
 */

import os from "node:os";
import { execFileSync } from "node:child_process";
import { MODEL_CATALOG, type CatalogModel } from "./catalog.js";

export type HardwareSummary = {
  totalRamBytes: number;
  /** machdep.cpu.brand_string — "Apple M4 Pro" 등. 못 읽으면 null. */
  chipBrand: string | null;
  /** hw.model — "Mac16,11" 등. 못 읽으면 null. */
  modelId: string | null;
  /** GPU 코어 수 (system_profiler 파싱, best-effort). 못 읽으면 null. */
  gpuCores: number | null;
};

export interface HardwareDeps {
  totalmem: () => number;
  /** /usr/sbin/sysctl -n <key> 결과 (trim). 실패 시 null. */
  sysctl: (key: string) => string | null;
  /** GPU 코어 수 best-effort. 실패 시 null. */
  gpuCores: () => number | null;
}

function sysctlValue(key: string): string | null {
  try {
    const out = execFileSync("/usr/sbin/sysctl", ["-n", key], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function gpuCoresFromProfiler(): number | null {
  try {
    const out = execFileSync(
      "/usr/sbin/system_profiler",
      ["SPDisplaysDataType"],
      { encoding: "utf8", timeout: 5000 },
    );
    // "Total Number of Cores: 20" 라인 파싱.
    const m = out.match(/Total Number of Cores:\s*(\d+)/);
    return m ? Number.parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

export const defaultHardwareDeps: HardwareDeps = {
  totalmem: () => os.totalmem(),
  sysctl: sysctlValue,
  gpuCores: gpuCoresFromProfiler,
};

export function detectHardware(
  deps: HardwareDeps = defaultHardwareDeps,
): HardwareSummary {
  return {
    totalRamBytes: deps.totalmem(),
    chipBrand: deps.sysctl("machdep.cpu.brand_string"),
    modelId: deps.sysctl("hw.model"),
    gpuCores: deps.gpuCores(),
  };
}

/**
 * RAM 예산에 맞는 최적 모델 id 를 추천. 적합 모델이 없으면 null.
 * 순수 함수 — 단위 테스트가 totalRamBytes 만 바꿔가며 검증.
 */
export function recommendModel(
  totalRamBytes: number,
  catalog: readonly CatalogModel[] = MODEL_CATALOG,
): string | null {
  // 추천 대상은 «에이전트에서 쓸» 모델 — 도구호출 불가(분석 전용) 모델은 후보에서 제외.
  // (4k+비-tool 로 도구호출이 조용히 깨지는 사고를 추천 단계에서부터 차단.)
  const usable = catalog.filter((m) => m.toolCallCapable);
  // estRss 내림차순 — 가장 큰(능력 좋은) 모델 우선.
  const byCapability = [...usable].sort((a, b) => b.estRssBytes - a.estRssBytes);

  // 1차: 「추천」 — 예산 여유 충분 + 권장 RAM 충족.
  for (const m of byCapability) {
    if (m.estRssBytes / totalRamBytes <= 0.7 && totalRamBytes >= m.recommendedRamBytes) {
      return m.id;
    }
  }
  // 2차: 「허용」 fallback — 최소 RAM 충족 + 빠듯하게라도 들어감.
  for (const m of byCapability) {
    if (totalRamBytes >= m.minRamBytes && m.estRssBytes / totalRamBytes <= 0.85) {
      return m.id;
    }
  }
  return null;
}
