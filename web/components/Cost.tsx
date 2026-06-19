import { Section } from "@/components/Section";
import { site } from "@/content";

/** 비용 표. data-section="cost". */
export default function Cost() {
  const { cost } = site;
  return (
    <Section name="cost" className="mx-auto w-full max-w-3xl px-6 py-20">
      <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
        {cost.heading}
      </h2>
      <p className="mt-3 max-w-2xl text-lg text-muted">{cost.subheading}</p>

      <table
        data-block="cost-table"
        className="mt-8 w-full border-separate border-spacing-0 text-left text-sm"
      >
        <tbody>
          {cost.rows.map((row) => (
            <tr key={row.item} data-block="cost-row">
              <th
                scope="row"
                className="border-b border-line py-3 pr-4 font-normal text-muted"
              >
                {row.item}
              </th>
              <td className="border-b border-line py-3 text-right font-medium">
                {row.price}
              </td>
            </tr>
          ))}
          <tr data-block="cost-total">
            <th scope="row" className="py-3 pr-4 font-semibold">
              {cost.total.item}
            </th>
            <td className="py-3 text-right text-lg font-bold text-success">
              {cost.total.price}
            </td>
          </tr>
        </tbody>
      </table>
    </Section>
  );
}
