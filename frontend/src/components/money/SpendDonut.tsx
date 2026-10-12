import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";

/**
 * The donut behind SpendBreakdown, in its own module so the chart library is
 * its own chunk.
 *
 * recharts and its d3 dependencies are 292KB -- the largest thing this
 * application ships -- and importing them from Money.tsx put them in the entry
 * graph, so every page preloaded the whole charting stack including the login
 * screen, which has no chart and no session. Behind `React.lazy` in
 * SpendBreakdown, the bytes are fetched by the one panel that draws one.
 *
 * `aria-hidden` on the wrapper is deliberate and lives with the caller: every
 * number in this chart is also in the list beside it, so a screen reader
 * reading the SVG would read the same figures twice.
 */
export default function SpendDonut({
  slices,
}: {
  slices: { id: string; label: string; amount: number; color: string }[];
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={slices}
          dataKey="amount"
          nameKey="label"
          innerRadius={50}
          outerRadius={78}
          paddingAngle={2}
          strokeWidth={0}
          isAnimationActive={false}
        >
          {slices.map((s) => (
            <Cell key={s.id} fill={s.color} />
          ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  );
}
