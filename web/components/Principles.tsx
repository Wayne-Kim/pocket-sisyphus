import { Section } from "@/components/Section";
import { site } from "@/content";

/**
 * 앱(iOS+Mac)의 핵심 원칙. data-section="principles".
 * 이 보장들은 «앱» 의 성질이지 이 웹사이트 호스팅과는 무관 — 카피가 the app 을 주어로 둔다.
 */
export default function Principles() {
  const { principles } = site;
  return (
    <Section name="principles" className="mx-auto w-full max-w-5xl px-6 py-20">
      <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
        {principles.heading}
      </h2>
      <p className="mt-3 max-w-2xl text-lg text-muted">
        {principles.subheading}
      </p>

      <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {principles.items.map((item) => (
          <li
            key={item.id}
            data-block="principle"
            data-testid={`principle-${item.id}`}
            className="rounded-2xl border border-line bg-white/[0.03] p-5"
          >
            <h3 className="text-lg font-semibold">{item.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">
              {item.body}
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
