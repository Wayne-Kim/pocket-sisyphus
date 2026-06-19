"use client";

import { useEffect } from "react";

/**
 * 개발 전용 소스 추적 보조 (LocatorJS).
 *
 * dev 모드에서만 마운트되어 브라우저에서 Option(⌥)+클릭으로 가리킨 요소의
 * 컴포넌트/소스를 에디터로 열어준다. 프로덕션 번들에는 들어가지 않는다
 * (`process.env.NODE_ENV` 가드 + dev 에서만 layout 이 렌더).
 *
 * 단, «요소 → 소스» 의 1차 계약은 이 라이브러리가 아니라 컴포넌트마다 박는
 * `data-section`/`data-block`/`data-testid` 마커 + 「한 섹션=한 파일」 규율이다.
 * (iOS 프리뷰 probe 가 selector·testid 를 추출하므로 마커만으로 항상 환원된다.)
 */
export default function DevLocator() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    let cancelled = false;
    void import("@locator/runtime").then((mod) => {
      if (cancelled) return;
      const setup = mod.default ?? mod;
      try {
        setup({ adapter: "react" });
      } catch {
        /* 소스 메타가 없으면 조용히 패스 — 마커가 계약을 보장한다 */
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
