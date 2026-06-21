import { Section } from "@/components/Section";
import { differentiators, ROW_META } from "@/content";

/**
 * 공식 원격 제어·릴레이 앱 대비 정직한 비교표. data-section="comparison".
 *
 * 접근성: <caption>(sr-only) + 열 머리 `scope="col"` + 행 머리 `scope="row"` — 스크린리더가
 * 각 셀을 «항목 × 제품» 으로 읽는다. 정적이라 빈/로딩 상태 없음.
 *
 * 색 정책: 우리 열만 accent(보라) hairline(.06) 틴트로 «선택» 강조. 경쟁 열은 muted 중립 —
 * 빨강(danger)으로 칠하지 않는다(비방·과장 금지, 빨강은 파괴적 동작 전용). 트레이드오프
 * 고지는 경고(노랑)가 아니라 info(파랑) 보조-정보 톤이다.
 */
export default function Comparison() {
  const { comparison } = differentiators;
  const lastRow = comparison.rows.length - 1;
  return (
    <Section name="comparison" className="mx-auto w-full max-w-5xl px-6 py-20">
      <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
        {comparison.heading}
      </h2>
      <p className="mt-3 max-w-3xl text-lg text-muted">
        {comparison.subheading}
      </p>

      <div className="mt-10 overflow-x-auto">
        <table
          data-block="comparison-table"
          className="w-full min-w-[40rem] border-separate border-spacing-0 text-left text-sm"
        >
          <caption className="sr-only">{comparison.caption}</caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="border-b border-line py-3 pr-4 align-bottom font-medium text-muted"
              >
                {comparison.colCapability}
              </th>
              <th
                scope="col"
                className="rounded-t-xl border-b border-line bg-accent/[0.06] px-4 py-3 align-bottom font-semibold text-accent-soft"
              >
                {comparison.colYou}
              </th>
              <th
                scope="col"
                className="border-b border-line px-4 py-3 align-bottom font-medium text-ink"
              >
                {comparison.colOfficial}
              </th>
              <th
                scope="col"
                className="border-b border-line px-4 py-3 align-bottom font-medium text-ink"
              >
                {comparison.colRelay}
              </th>
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((row, i) => (
              <tr
                key={ROW_META[i].id}
                data-block="comparison-row"
                data-testid={`comparison-${ROW_META[i].id}`}
              >
                <th
                  scope="row"
                  className="border-b border-line py-3 pr-4 align-top font-medium text-ink"
                >
                  {row.label}
                </th>
                <td
                  className={`border-b border-line bg-accent/[0.06] px-4 py-3 align-top text-ink ${
                    i === lastRow ? "rounded-b-xl" : ""
                  }`}
                >
                  {row.you}
                </td>
                <td className="border-b border-line px-4 py-3 align-top text-muted">
                  {row.official}
                </td>
                <td className="border-b border-line px-4 py-3 align-top text-muted">
                  {row.relay}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p
        data-block="comparison-footnote"
        className="mt-6 max-w-3xl border-l-2 border-info/40 pl-4 text-sm leading-relaxed text-muted"
      >
        <span className="font-semibold text-info">
          {comparison.footnoteLabel}:{" "}
        </span>
        {comparison.footnote}
      </p>
    </Section>
  );
}
