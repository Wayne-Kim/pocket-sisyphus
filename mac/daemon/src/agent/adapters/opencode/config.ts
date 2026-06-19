/**
 * opencode 프로바이더 설정 주입 — 우리가 띄우는 로컬 llama-server(127.0.0.1:51100/v1)를
 * opencode 의 «OpenAI 호환» 프로바이더로 front 한다.
 *
 * # 왜 OPENCODE_CONFIG 인가 (사용자 설정 비파괴)
 *
 * opencode 는 config 를 여러 위치에서 읽는다: 전역(~/.config/opencode/opencode.json),
 * 커스텀(OPENCODE_CONFIG 환경변수 경로), 프로젝트(cwd 의 opencode.json). 전역이나 프로젝트
 * 파일을 우리가 덮어쓰면 사용자가 손수 적은 설정이 날아가거나 repo 에 opencode.json 이 커밋될
 * 위험이 있다. 그래서 daemon 소유의 «별도 파일» 을 만들고 OPENCODE_CONFIG 로 가리킨다 —
 * local-llm 어댑터가 ~/.qwen/settings.json 에 의존하지 않고 OPENAI_* env 로 self-contained
 * 한 것과 같은 정신. 우리 프로바이더는 항상 추가되고, 사용자의 전역/프로젝트 설정과 «병합»
 * 된다(프로젝트가 더 높은 우선순위라 사용자 repo 의 opencode.json 이 모델을 덮어쓸 수 있다 —
 * 의도된 동작).
 *
 * # 프로바이더 형태 (@ai-sdk/openai-compatible)
 *
 * opencode 공식 문서의 로컬 OpenAI 호환 프로바이더 레시피 그대로:
 *   provider.<id>.npm = "@ai-sdk/openai-compatible"
 *   provider.<id>.options.baseURL = http://127.0.0.1:51100/v1
 *   provider.<id>.models.<modelId> = { name }
 *   model = "<id>/<modelId>"  (기본 모델)
 *
 * llama-server 는 단일 모델 서빙이라 modelId 는 라우팅엔 안 쓰이고 표시/요청 echo 용.
 * effectiveModelId() (config.selectedModelId → 하드웨어 추천 → 기본) 를 그대로 박는다.
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../../../config.js";
import { LLM_OPENAI_BASE_URL } from "../../../local-llm/paths.js";

/** opencode.json 안에서 우리 로컬 프로바이더를 식별하는 id (model = "<id>/<modelId>"). */
export const OPENCODE_PROVIDER_ID = "pocket-local";
/** llama-server 는 키를 검증하지 않지만 openai-compatible SDK 는 비어있지 않은 키를 요구. */
export const OPENCODE_API_KEY = "sk-local-dummy";
/** daemon 소유 opencode 설정 파일 — OPENCODE_CONFIG 가 가리킨다. */
export const OPENCODE_CONFIG_PATH = path.join(CONFIG_DIR, "opencode", "opencode.json");

/**
 * opencode.json 본문을 만든다 (순수 — 단위 테스트 대상).
 *
 * 기본은 번들 llama-server(LLM_OPENAI_BASE_URL). `opts.baseUrl` 을 주면 «외부 엔드포인트»
 * 모드 — 사용자가 직접 돌리는 OpenAI 호환 로컬 서버(Ollama 등)를 front 한다 (config.ts 의
 * OpencodeExternalEndpoint). 라우팅의 진실은 항상 이 파일의 provider.options.baseURL.
 *
 * `opts.bypassPermissions` 가 true 면 top-level `permission: "allow"` 를 박아 도구 결재를
 * 전부 자동 승인한다(qwen 의 --approval-mode yolo 와 동등). opencode 엔 권한우회 CLI 플래그가
 * 없어 — 설정 파일이 유일한 경로. false 면 키를 생략해 opencode 기본 정책(TUI 안에서 사람이
 * 결재)을 따른다.
 */
export function buildOpencodeConfig(
  modelId: string,
  opts?: { baseUrl?: string; bypassPermissions?: boolean },
): Record<string, unknown> {
  const baseURL = opts?.baseUrl ?? LLM_OPENAI_BASE_URL;
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Pocket Sisyphus · Local llama-server",
        options: {
          baseURL,
          apiKey: OPENCODE_API_KEY,
        },
        models: {
          [modelId]: { name: modelId },
        },
      },
    },
    // 기본 모델 — 사용자가 repo 에 opencode.json 으로 다른 모델을 지정하면 그쪽이 우선.
    model: `${OPENCODE_PROVIDER_ID}/${modelId}`,
  };
  // YOLO — 모든 도구를 자동 승인 (read/edit/bash/webfetch…). top-level 문자열 형태가
  // opencode 스키마의 PermissionConfig 단축형 (전 도구에 같은 action 적용).
  if (opts?.bypassPermissions) {
    config.permission = "allow";
  }
  return config;
}

/**
 * 설정 파일을 디스크에 materialize 하고 그 경로를 돌려준다. 멱등 — 매 spawn 직전(prewarm)
 * 호출돼 effectiveModelId(또는 외부 엔드포인트 modelId) 변화를 반영한다. 실패해도 throw 하지
 * 않는다(호출부가 감싼다) — 설정이 없으면 opencode 가 연결 에러를 표시하는 게 허용된 UX.
 *
 * `opts.baseUrl` 을 주면 외부 엔드포인트 모드로 그 baseURL 을, `opts.bypassPermissions` 가
 * true 면 permission: "allow" 를 박는다.
 */
export function ensureOpencodeConfig(
  modelId: string,
  opts?: { baseUrl?: string; bypassPermissions?: boolean },
): string {
  fs.mkdirSync(path.dirname(OPENCODE_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(
    OPENCODE_CONFIG_PATH,
    JSON.stringify(buildOpencodeConfig(modelId, opts), null, 2),
  );
  return OPENCODE_CONFIG_PATH;
}
