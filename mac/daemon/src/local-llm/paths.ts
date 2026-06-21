/**
 * 로컬 LLM 공용 경로/엔드포인트 상수 — 이 파일이 단일 진실(single source of truth).
 * adapter / download / supervisor / status 가 모두 여기서 가져와 drift 를 막는다.
 */
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR } from "../config.js";

export const LLM_HOST = "127.0.0.1";
export const LLM_PORT = 51100;
export const LLM_BASE_URL = `http://${LLM_HOST}:${LLM_PORT}`;
/** qwen 의 OPENAI_BASE_URL 가 가리킬 OpenAI 호환 엔드포인트. */
export const LLM_OPENAI_BASE_URL = `${LLM_BASE_URL}/v1`;

/** 모델 저장소 — CONFIG_DIR/models. */
export const MODELS_DIR = path.join(CONFIG_DIR, "models");
/** 서버/프라이밍 로그 디렉토리. */
export const LLM_LOG_DIR = path.join(
  os.homedir(),
  "Library",
  "Logs",
  "PocketSisyphus",
  "local-llm",
);

export function modelFilePath(fileName: string): string {
  return path.join(MODELS_DIR, fileName);
}
