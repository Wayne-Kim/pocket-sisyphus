import { Section } from "@/components/Section";
import { site } from "@/content";

/**
 * 듀얼 채널 구조 다이어그램. data-section="architecture".
 * README 「한눈에 보는 구조」를 카드 2개(iPhone / Mac) + 채널 라벨로 시각화.
 */
export default function Architecture() {
  const { architecture } = site;
  return (
    <Section
      name="architecture"
      className="mx-auto w-full max-w-5xl px-6 py-20"
    >
      <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
        {architecture.heading}
      </h2>
      <p className="mt-3 max-w-2xl text-lg text-muted">
        {architecture.subheading}
      </p>

      <div className="mt-10 grid items-stretch gap-4 lg:grid-cols-[1fr_auto_1fr]">
        <Node title={architecture.phone.title} lines={architecture.phone.lines} />

        {/* 채널 라벨 — 모바일에선 가로, 데스크탑에선 세로 화살표 */}
        <div
          data-block="channels"
          className="flex flex-row items-center justify-center gap-2 lg:flex-col"
        >
          {architecture.channelLabels.map((label, i) => (
            <span
              key={label}
              data-testid={`channel-${i}`}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
                i === 0
                  ? "border-success/40 text-success"
                  : "border-info/40 text-info"
              }`}
            >
              {label}
            </span>
          ))}
        </div>

        <Node title={architecture.mac.title} lines={architecture.mac.lines} />
      </div>
    </Section>
  );
}

function Node({ title, lines }: { title: string; lines: readonly string[] }) {
  return (
    <div
      data-block="arch-node"
      className="rounded-2xl border border-line bg-white/[0.03] p-6"
    >
      <p className="font-semibold text-accent-soft">{title}</p>
      <ul className="mt-3 space-y-2 text-sm text-muted">
        {lines.map((line) => (
          <li key={line} className="flex gap-2">
            <span aria-hidden className="text-accent-soft">
              ·
            </span>
            <span className="font-mono text-[13px]">{line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
