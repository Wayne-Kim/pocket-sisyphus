import type { ComponentPropsWithoutRef, ReactNode } from "react";

/**
 * 모든 최상위 섹션의 공통 래퍼. `name` 하나로 «요소 → 소스» 계약의 핵심인
 * `data-section` / `id` / `data-testid` 마커를 일괄 부여한다.
 *
 * iOS 프리뷰 화면 피드백이 가리킨 DOM 의 selector·id·data-testid 를 추출하므로,
 * 사용자가 "여기" 하고 짚으면 `section[data-section="hero"]` 처럼 잡혀
 * 곧장 `components/Hero.tsx` 한 파일로 환원된다 (한 섹션 = 한 파일).
 */
export function Section({
  name,
  children,
  className = "",
  ...rest
}: {
  name: string;
  children: ReactNode;
  className?: string;
} & ComponentPropsWithoutRef<"section">) {
  return (
    <section
      id={name}
      data-section={name}
      data-testid={`section-${name}`}
      className={`scroll-mt-16 ${className}`}
      {...rest}
    >
      {children}
    </section>
  );
}
