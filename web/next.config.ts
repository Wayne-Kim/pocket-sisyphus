import type { NextConfig } from "next";

/**
 * GitHub Pages 정적 배포용 설정.
 *
 * - output: "export" → `out/` 로 완전 정적 추출(서버·함수 0). OG 카드는 라우트가 아니라
 *   정적 PNG(public/og.png, `pnpm gen:og`) 라 확장자 기반 MIME 으로 정상 서빙된다.
 * - images.unoptimized → 정적 호스트엔 이미지 최적화 서버가 없으므로 끈다(next/image 가 평문 img).
 * - basePath/assetPrefix → 프로젝트 페이지는 `/<repo>` 하위경로(`/pocket-claude`)로 서빙된다.
 *   환경변수로 주입해 커스텀 도메인(루트 서빙) 으로 옮길 때 값만 비우면 된다.
 * - trailingSlash → Pages 가 디렉터리 index.html 을 그대로 서빙하게 한다.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
};

export default nextConfig;
