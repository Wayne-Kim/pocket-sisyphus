import { defineConfig } from "vitest/config";

// 테스트는 src 의 TypeScript 만 돈다. `npm run build`(tsc) 가 만든 dist/**/*.test.js 는
// 컴파일 산출물(자산 미복사로 깨질 수 있는 중복)이라 수집 대상에서 제외한다.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // include 를 명시하면 «테스트가 건드린 파일» 뿐 아니라 매칭되는 모든 src 소스가
      // 0% 라도 리포트에 들어온다. tor/·nat/ 처럼 테스트가 아예 import 하지 않는
      // 무테스트 공백이 비로소 가시화된다(기존엔 표에서 통째로 사라져 게이트가 못 잡았다).
      include: ["src/**/*.ts"],
      exclude: [
        "**/*.test.ts", // 테스트 자체는 커버리지 대상이 아님(=src 비-테스트 .ts 만)
        "**/*.d.ts", // 타입 선언(런타임 코드 없음)
        "src/types/**", // 앰비언트 타입 정의 디렉터리
        "dist/**", // tsc 산출물
        "node_modules/**",
      ],
      // 회귀 방지 floor — «하향만» 막는다(자동 래칫 금지: autoUpdate 미사용).
      // 베이스라인(전 src .ts 포함, 측정 2026-06-20):
      //   stmts 46.07% · branch 43.24% · funcs 47.02% · lines 47.47%.
      // 임계값은 그 베이스라인보다 ~1pt 낮게 잡는다 — 측정/환경 편차나 «작은 헬퍼 1개»엔
      // 안 터지되, 무테스트 «모듈»(수백 줄, 예: tor/sidecar.ts 564줄) 하나가 통째로 들어오면
      // 집계가 floor 아래로 떨어져 실패한다. vitest 는 coverage < threshold 일 때만 실패하므로
      // «정확히 임계값»은 통과한다(>=).
      thresholds: {
        statements: 45,
        branches: 42,
        functions: 46,
        lines: 46,
      },
    },
  },
});
