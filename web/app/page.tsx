import Hero from "@/components/Hero";
import Differentiators from "@/components/Differentiators";
import Comparison from "@/components/Comparison";
import Principles from "@/components/Principles";
import Agents from "@/components/Agents";
import Architecture from "@/components/Architecture";
import Features from "@/components/Features";
import Install from "@/components/Install";
import Cost from "@/components/Cost";
import Footer from "@/components/Footer";

/**
 * 랜딩 페이지 — 섹션 컴포넌트 조립만 한다. 카피는 content/, 스타일은 각 컴포넌트.
 * 한 섹션 = 한 파일 → 폰 프리뷰에서 가리킨 요소가 곧장 그 파일로 환원된다.
 */
export default function Home() {
  return (
    <>
      <Hero />
      <Differentiators />
      <Comparison />
      <Principles />
      <Architecture />
      <Agents />
      <Features />
      <Install />
      <Cost />
      <Footer />
    </>
  );
}
