import { defineConfig } from "vitest/config";

// 테스트는 src 의 TypeScript 만 돈다. `npm run build`(tsc) 가 만든 dist/**/*.test.js 는
// 컴파일 산출물(자산 미복사로 깨질 수 있는 중복)이라 수집 대상에서 제외한다.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
