import Image from "next/image";
import { site } from "@/content";
// 정적 import — next/image 가 basePath/assetPrefix 가 반영된 해시 자산 URL 로 내보낸다.
// (문자열 "/logo.png" src 는 정적추출+하위경로에서 basePath 가 안 붙어 404 난다.)
import logoImg from "@/public/logo.png";

/**
 * 최상단 히어로. data-section="hero".
 * 브랜드 보라 방사형 그라데이션 톤.
 */
export default function Hero() {
  const { hero, brand } = site;
  return (
    <section
      id="hero"
      data-section="hero"
      data-testid="section-hero"
      className="relative overflow-hidden px-6 pb-16 pt-20 text-center sm:pb-24 sm:pt-28"
    >
      {/* 보라 방사형 그라데이션 배경 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(120% 90% at 15% 0%, #966de2 0%, #6c3fa8 38%, #1b0f33 72%, #08060f 100%)",
        }}
      />

      <a
        href="#hero"
        data-block="brand"
        className="mx-auto mb-9 inline-flex items-center gap-3 text-lg font-semibold opacity-95"
      >
        <Image
          src={logoImg}
          alt={`${brand.name} logo`}
          width={40}
          height={40}
          priority
          className="block rounded-xl shadow-lg"
        />
        {brand.name}
      </a>

      {/* 정체성 레이어 — 능력 타이틀 «위» 1줄. 보라 그라데이션 위라 본문은 onAccent
          (밝은 ink)로 대비 확보, 강조는 위치/타이포로. status색(노랑/주황) 차용 금지.
          NOTE: 폰트 크기에 `text-base` 금지 — 이 프로젝트는 `--color-base` 를 정의해
          Tailwind v4 가 `text-base` 를 «색»(거의 검정)으로 컴파일한다. 크기는 임의값으로. */}
      <p className="mx-auto mb-3 max-w-[40ch] text-sm font-semibold text-ink/90 sm:text-[1rem]">
        {hero.eyebrow}
      </p>

      <h1 className="mx-auto max-w-[12ch] text-4xl font-extrabold leading-[1.08] tracking-tight sm:text-5xl">
        {hero.title}
      </h1>

      <p className="mx-auto mt-4 max-w-[34ch] text-lg text-muted">
        {hero.tagline}
      </p>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <a
          href={hero.primaryCta.href}
          target="_blank"
          rel="noopener noreferrer"
          data-cta="app-store"
          data-testid="cta-install"
          className="inline-flex items-center gap-2 rounded-full bg-white px-6 py-3.5 text-base font-bold text-[#2a1450] shadow-xl transition-transform hover:-translate-y-0.5"
        >
          {hero.primaryCta.label} <span aria-hidden>→</span>
        </a>
        <a
          href={hero.secondaryCta.href}
          data-cta="how-it-works"
          className="inline-flex items-center gap-2 rounded-full border border-line px-6 py-3.5 text-base font-medium text-ink/90 transition-colors hover:border-accent-soft/50"
        >
          {hero.secondaryCta.label}
        </a>
      </div>

      <ul
        data-block="pills"
        className="mt-7 flex flex-wrap items-center justify-center gap-2 text-sm text-muted"
      >
        {hero.pills.map((pill) => (
          <li
            key={pill}
            className="rounded-full border border-line px-3 py-1.5"
          >
            {pill}
          </li>
        ))}
      </ul>
    </section>
  );
}
