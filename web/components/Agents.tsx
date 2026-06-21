import { Section } from "@/components/Section";
import { site } from "@/content";

/** 지원 코드 에이전트 CLI. data-section="agents". */
export default function Agents() {
  const { agents } = site;
  return (
    <Section name="agents" className="mx-auto w-full max-w-5xl px-6 py-20">
      <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
        {agents.heading}
      </h2>
      <p className="mt-3 max-w-2xl text-lg text-muted">{agents.subheading}</p>

      <ul className="mt-10 grid gap-4 sm:grid-cols-3">
        {agents.items.map((agent) => (
          <li
            key={agent.id}
            data-block="agent"
            data-testid={`agent-${agent.id}`}
            className="rounded-2xl border border-line bg-white/[0.03] p-6 text-center"
          >
            <p className="text-xl font-semibold">{agent.name}</p>
            <p className="mt-1 text-sm text-muted">{agent.vendor}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
