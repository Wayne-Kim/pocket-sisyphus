import { Section } from "@/components/Section";
import { site } from "@/content";

/** 기능 카드. data-section="features". */
export default function Features() {
  const { features } = site;
  return (
    <Section name="features" className="mx-auto w-full max-w-5xl px-6 py-20">
      <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
        {features.heading}
      </h2>

      <ul className="mt-10 grid gap-4 sm:grid-cols-2">
        {features.items.map((feature) => (
          <li
            key={feature.id}
            data-block="feature-card"
            data-testid={`feature-${feature.id}`}
            className="rounded-2xl border border-line bg-white/[0.03] p-6"
          >
            <span className="text-3xl" aria-hidden>
              {feature.icon}
            </span>
            <h3 className="mt-3 flex items-center gap-2 text-lg font-semibold">
              {feature.title}
              {"pro" in feature && feature.pro && (
                <span
                  data-block="pro-badge"
                  // pro=주황(#FF9500) 약속색. amber-400(노랑 쪽)은 warning 과 혼동 →
                  // pro 토큰(globals.css @theme --color-pro)으로 교정. CLAUDE.md 색 정책.
                  // font-semibold 로 Differentiators 의 Pro 배지와 사이트 전역 통일.
                  className="rounded-full border border-pro/30 bg-pro/10 px-2 py-0.5 text-xs font-semibold text-pro"
                >
                  Pro
                </span>
              )}
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">
              {feature.body}
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
