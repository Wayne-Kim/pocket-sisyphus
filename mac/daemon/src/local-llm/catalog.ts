/**
 * 큐레이티드 로컬 LLM 모델 카탈로그 — 순수 데이터, side-effect 0.
 *
 * Qwen Code(qwen CLI)는 OpenAI 호환 tool-calling 위에서 도는 에이전트 CLI 라, 카탈로그는
 * «도구호출이 견고한» 코딩 모델만 에이전트 후보로 담는다. 2026 로컬 코딩 지형에선 Qwen 계열과
 * 나란히 도구호출 특화(Devstral)·장-호라이즌 에이전트(GLM-Air, MIT)가 꼽힌다. 각 엔트리는
 * RAM 티어로 나뉘고, daemon 의 hardware.recommendModel 이 사용자 Mac 의 RAM 예산에 맞춰
 * 하나를 추천한다.
 *
 * ★ 도구호출 가드 (절대 규칙): 로컬 OpenCode/qwen 의 1순위 실패는 «비-tool 모델 + 컨텍스트 4k»
 *   로 도구호출이 «조용히» 깨지는 것 — 초록불(서버 ready)인데 파일이 안 써진다. 그래서:
 *    - toolCallCapable=false 인 모델은 에이전트 세션에서 제외(분석 전용)한다
 *      (hardware.recommendModel 후보 제외 + adapter.prepareBackend no-op).
 *    - 도구호출 모델은 supervisor.effectiveCtxSize 가 minToolCtx(≥16k) «미만으로 절대 기동하지
 *      않게» 컨텍스트 바닥을 보장한다.
 *
 * 모든 facts(hfRepo/fileName/fileSizeBytes/sha256)는 실제 HuggingFace 리스팅으로 검증됨:
 *  - flagship/27B: 실제 다운로드한 파일에서 측정한 sha256/size
 *  - 그 외: huggingface.co/api/models/<repo>/tree/main 의 lfs.oid(=sha256)/lfs.size 확인
 *    (Qwen3 계열 2026-06, Qwen3-Coder/Devstral/GLM-Air 2026-06 재확인)
 *
 * 단일파일 제약: download.ts 는 단일 fileName 만 받는다 → split GGUF(00001-of-000N) 는 못 쓴다.
 *   GLM-4.5-Air 의 양질 양자화(Q4_K_M 등)는 전부 split 이라 «단일파일» UD-Q2_K_XL 을 담는다.
 *
 * MTP(speculative decoding) 는 unsloth 의 `-MTP-GGUF` 빌드에만 들어 있다 → hasMtpHead 가
 * true 인 모델만 supervisor.buildLlamaServerArgs 가 `--spec-type draft-mtp` 를 붙인다.
 */

const GiB = 1024 ** 3;

export type ModelTier = "small" | "mid" | "large" | "flagship";

export type CatalogModel = {
  /** stable id — config.selectedModelId / iOS picker 가 참조. */
  id: string;
  /** 사람용 이름 (비번역 — 모델명은 브랜드). */
  displayName: string;
  /** iOS 카드용 한 줄 설명 (한국어 — iOS 가 카탈로그 표시 시 그대로 쓰거나 자체 로컬라이즈). */
  description: string;
  tier: ModelTier;
  /** HuggingFace repo. download URL = https://huggingface.co/<hfRepo>/resolve/main/<fileName> */
  hfRepo: string;
  fileName: string;
  /** 정확한 파일 크기 (bytes) — 디스크 가드 + 진행률 분모 + 다운로드 완료 판정. */
  fileSizeBytes: number;
  quant: string;
  /** 기대 sha256 (소문자 hex). 다운로드 후 무결성 검증. null 이면 검증 skip. */
  sha256: string | null;
  /** 이 모델을 «제공»할 최소 RAM (이 미만이면 추천 후보에서도 제외). */
  minRamBytes: number;
  /** 예산상 «추천»할 RAM 하한. */
  recommendedRamBytes: number;
  /** 기본 컨텍스트 길이 (메모리 예산 준수 — 32K 캡). */
  ctxDefault: number;
  /** rope 스케일링 없이 안전한 네이티브 컨텍스트 상한. 이를 넘기면 YaRN 플래그가 붙는다. */
  ctxNative: number;
  /** 제공 가능한 최대 컨텍스트 (YaRN 포함). config.ctxSize 는 spawn 시 이 값으로 clamp. */
  ctxMax: number;
  /** MTP draft head 보유 여부 — true 일 때만 MTP serve 플래그를 붙인다. */
  hasMtpHead: boolean;
  /**
   * OpenAI 호환 도구호출이 «견고»한가. false 면 에이전트 세션에서 제외(분석 전용) —
   * 도구호출이 조용히 깨지는 사고를 원천 차단. recommendModel/prepareBackend 가 이 플래그로 거른다.
   */
  toolCallCapable: boolean;
  /**
   * 도구호출이 안정적으로 동작하는 «권장 최소 컨텍스트» (≥16k). supervisor 가 기동 시 컨텍스트를
   * 이 값 이상으로 바닥 보장한다 — 4k 에선 tool-call 시스템 프롬프트+스키마가 잘려 조용히 깨진다.
   */
  minToolCtx: number;
  /** 표시용 추정 디코드 속도 (tok/s, Mac Apple Silicon 기준). */
  estDecodeTokSec: number;
  /** 추정 RSS (bytes) — recommendModel 의 메모리 예산 계산에 사용. */
  estRssBytes: number;
};

export const MODEL_CATALOG: readonly CatalogModel[] = [
  {
    id: "glm-4.5-air-q2kxl",
    displayName: "GLM-4.5-Air (UD-Q2_K_XL)",
    description: "MoE 106B-A12B, 장-호라이즌 에이전트(MIT). 64GB+ Mac, 단일파일 Q2 양자화.",
    tier: "flagship",
    hfRepo: "unsloth/GLM-4.5-Air-GGUF",
    fileName: "GLM-4.5-Air-UD-Q2_K_XL.gguf",
    fileSizeBytes: 47_444_888_640,
    quant: "UD-Q2_K_XL",
    sha256: "609fe51f04b1a17941fb3549de50b6fa4137a32641ca23d88e7f1f12ad5deaef",
    minRamBytes: 48 * GiB,
    recommendedRamBytes: 64 * GiB,
    ctxDefault: 32768,
    // GLM-4.5-Air 네이티브 131,072 (128K).
    ctxNative: 131_072,
    ctxMax: 131_072,
    hasMtpHead: false,
    toolCallCapable: true,
    minToolCtx: 16384,
    estDecodeTokSec: 22,
    estRssBytes: 50_000_000_000,
  },
  {
    id: "qwen3.6-35b-a3b-q8",
    displayName: "Qwen3.6 35B-A3B (Q8)",
    description: "MoE, 활성 3.6B. 64GB Mac 권장. MTP 로 디코드 ~44 tok/s, Q8 품질.",
    tier: "flagship",
    hfRepo: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF",
    fileName: "Qwen3.6-35B-A3B-Q8_0.gguf",
    fileSizeBytes: 37_801_097_504,
    quant: "Q8_0",
    sha256: "c1283d8b80c3e38b2735ddbc9766d3b3126f44d6c484be419d4e101d09a76131",
    minRamBytes: 48 * GiB,
    recommendedRamBytes: 64 * GiB,
    ctxDefault: 32768,
    // Qwen3.6 은 네이티브 262,144 — 256K 까지 YaRN 불필요 (vLLM recipe/모델 카드 2026-06 확인).
    ctxNative: 262_144,
    ctxMax: 262_144,
    hasMtpHead: true,
    toolCallCapable: true,
    minToolCtx: 16384,
    estDecodeTokSec: 44,
    estRssBytes: 39_800_000_000,
  },
  {
    id: "qwen3-30b-a3b-q4",
    displayName: "Qwen3 30B-A3B (Q4_K_M)",
    description: "MoE, 활성 3B. ~32GB Mac. Q4 로 메모리 절반, 속도 우수.",
    tier: "mid",
    hfRepo: "unsloth/Qwen3-30B-A3B-GGUF",
    fileName: "Qwen3-30B-A3B-Q4_K_M.gguf",
    fileSizeBytes: 18_556_686_912,
    quant: "Q4_K_M",
    sha256: "9f1a24700a339b09c06009b729b5c809e0b64c213b8af5b711b3dbdfd0c5ba48",
    minRamBytes: 24 * GiB,
    recommendedRamBytes: 32 * GiB,
    ctxDefault: 32768,
    // Qwen3 계열 네이티브 32,768 — 그 이상은 YaRN(rope-scale ≤4) 으로 131,072 까지 (Qwen 공식 가이드).
    ctxNative: 32_768,
    ctxMax: 131_072,
    hasMtpHead: false,
    toolCallCapable: true,
    minToolCtx: 16384,
    estDecodeTokSec: 35,
    estRssBytes: 22_000_000_000,
  },
  {
    id: "qwen3-coder-30b-a3b-q4",
    displayName: "Qwen3-Coder 30B-A3B (Q4_K_M)",
    description: "MoE 코딩 특화, 활성 3B. 도구호출이 견고해 에이전트에 적합. ~32GB Mac, 빠른 디코드.",
    tier: "mid",
    hfRepo: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
    fileName: "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",
    fileSizeBytes: 18_556_689_568,
    quant: "Q4_K_M",
    sha256: "fadc3e5f8d42bf7e894a785b05082e47daee4df26680389817e2093056f088ad",
    minRamBytes: 24 * GiB,
    recommendedRamBytes: 32 * GiB,
    ctxDefault: 32768,
    // Qwen3-Coder 는 네이티브 262,144 (256K) — YaRN 없이 길게 간다.
    ctxNative: 262_144,
    ctxMax: 262_144,
    hasMtpHead: false,
    toolCallCapable: true,
    minToolCtx: 16384,
    estDecodeTokSec: 34,
    estRssBytes: 21_900_000_000,
  },
  {
    id: "devstral-small-2507-q4",
    displayName: "Devstral Small 2507 (Q4_K_M)",
    description: "Mistral 24B dense, 에이전트·도구호출 특화(Apache 2.0). 32GB+ Mac 권장.",
    tier: "mid",
    hfRepo: "unsloth/Devstral-Small-2507-GGUF",
    fileName: "Devstral-Small-2507-Q4_K_M.gguf",
    fileSizeBytes: 14_333_918_432,
    quant: "Q4_K_M",
    sha256: "5578b1cd0733b496cdb2d309d9a275de2ea31681793c8f05f70f3adfa65a26c4",
    minRamBytes: 32 * GiB,
    recommendedRamBytes: 32 * GiB,
    ctxDefault: 32768,
    // Devstral Small 2507 네이티브 131,072 (128K).
    ctxNative: 131_072,
    ctxMax: 131_072,
    hasMtpHead: false,
    toolCallCapable: true,
    minToolCtx: 16384,
    estDecodeTokSec: 18,
    estRssBytes: 21_500_000_000,
  },
  {
    id: "qwen3-14b-q4",
    displayName: "Qwen3 14B (Q4_K_M)",
    description: "Dense 14B. ~24GB Mac. 중간 코딩 보조, 균형형.",
    tier: "mid",
    hfRepo: "unsloth/Qwen3-14B-GGUF",
    fileName: "Qwen3-14B-Q4_K_M.gguf",
    fileSizeBytes: 9_001_753_984,
    quant: "Q4_K_M",
    sha256: "5eaa0870bd81ed3b58a630a271234cfa604e43ffb3a19cd68e54a80dd9d52a66",
    minRamBytes: 16 * GiB,
    recommendedRamBytes: 24 * GiB,
    ctxDefault: 32768,
    // Qwen3 계열 네이티브 32,768 — 그 이상은 YaRN(rope-scale ≤4) 으로 131,072 까지 (Qwen 공식 가이드).
    ctxNative: 32_768,
    ctxMax: 131_072,
    hasMtpHead: false,
    toolCallCapable: true,
    minToolCtx: 16384,
    estDecodeTokSec: 28,
    estRssBytes: 12_000_000_000,
  },
  {
    id: "qwen3-8b-q4",
    displayName: "Qwen3 8B (Q4_K_M)",
    description: "Dense 8B. ~16GB Mac 진입 모델. 가벼운 코딩 보조.",
    tier: "small",
    hfRepo: "unsloth/Qwen3-8B-GGUF",
    fileName: "Qwen3-8B-Q4_K_M.gguf",
    fileSizeBytes: 5_027_784_512,
    quant: "Q4_K_M",
    sha256: "120307ba529eb2439d6c430d94104dabd578497bc7bfe7e322b5d9933b449bd4",
    minRamBytes: 12 * GiB,
    recommendedRamBytes: 16 * GiB,
    ctxDefault: 32768,
    // Qwen3 계열 네이티브 32,768 — 그 이상은 YaRN(rope-scale ≤4) 으로 131,072 까지 (Qwen 공식 가이드).
    ctxNative: 32_768,
    ctxMax: 131_072,
    hasMtpHead: false,
    toolCallCapable: true,
    minToolCtx: 16384,
    estDecodeTokSec: 25,
    estRssBytes: 7_000_000_000,
  },
];

/** 카탈로그 기본 모델 — 추천이 null 일 때의 안전한 fallback (가장 가벼운 모델). */
export const DEFAULT_MODEL_ID = "qwen3-8b-q4";

export function getCatalogModel(id: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}
