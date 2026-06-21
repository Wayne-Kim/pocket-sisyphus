import { Section } from "@/components/Section";
import { differentiators, AXIS_META } from "@/content";

/**
 * «우리만의 것» 3축 — 공식 원격 제어와의 차이를 헤드라인급으로. data-section="differentiators".
 * 색 정책: 번호·강조는 accent(보라, 브랜드). 「Pro」 배지는 «주황=프로» 토큰(`pro`)으로,
 * 전부 Pro 인 PO 루프 축에만 붙인다(멀티에이전트 축은 무료 CLI 가 섞여 있어 배지 없이 본문에 명시).
 */
export default function Differentiators() {
  const { edge } = differentiators;
  return (
    <Section
      name="differentiators"
      className="mx-auto w-full max-w-5xl px-6 py-20"
    >
      <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
        {edge.heading}
      </h2>
      <p className="mt-3 max-w-3xl text-lg text-muted">{edge.subheading}</p>

      <ul className="mt-10 grid gap-4 lg:grid-cols-3">
        {edge.axes.map((axis, i) => {
          const meta = AXIS_META[i];
          return (
            <li
              key={meta.id}
              data-block="differentiator"
              data-testid={`differentiator-${meta.id}`}
              className="flex flex-col rounded-2xl border border-line bg-white/[0.03] p-6"
            >
              <div className="flex items-center justify-between">
                <span
                  aria-hidden
                  className="font-mono text-sm font-semibold text-accent-soft"
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                {meta.pro && (
                  <span
                    data-block="pro-badge"
                    className="rounded-full border border-pro/30 bg-pro/10 px-2 py-0.5 text-xs font-semibold text-pro"
                  >
                    Pro
                  </span>
                )}
              </div>
              <h3 className="mt-3 text-lg font-semibold">{axis.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                {axis.body}
              </p>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
