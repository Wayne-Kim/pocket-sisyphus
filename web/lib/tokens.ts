/**
 * 브랜드 디자인 토큰 — iOS `ios/PocketSisyphus/DesignSystem/DesignTokens.swift` 의
 * `Theme` 색상 정책을 미러한 단일 출처(웹 측). 실제 스타일 적용은 Tailwind 유틸
 * (`bg-accent`, `text-muted` 등)로 하고, 이 파일은 JS 에서 색이 필요할 때(예: 다이어그램
 * 인라인 SVG, OG 이미지)와 «정책 주석»의 SSOT 로 쓴다.
 *
 * 색 = 의미. accent=보라(브랜드/선택), success=초록, danger=빨강,
 * warning=노랑(진짜 경고 전용), info=파랑, pro=주황(프리미엄/고급).
 * 장식·강조에 warning/pro 를 빌려쓰지 말 것 (CLAUDE.md 색 정책).
 */
export const colors = {
  accent: "#9a5abf", // iOS Theme.accent — 브랜드 보라
  accentSoft: "#a77cff",
  purpleLt: "#966de2",
  purpleMd: "#6c3fa8",

  success: "#34c759",
  danger: "#ff3b30",
  warning: "#ffcc00",
  info: "#0a84ff",
  pro: "#ff9500",

  nodeStart: "#34c759", // 워크플로우 시작=초록
  nodeTask: "#ff6fae", // 작업=분홍
  nodeEnd: "#0a84ff", // 종료=파랑

  ink: "#ece4fc",
  muted: "#b9a9e0",
  base: "#08060f",
  surface: "#110a1f",
} as const;

export type ColorToken = keyof typeof colors;
