// Small shared icon set. Kept as plain inline SVG (no icon library
// dependency) so it renders the same wherever it's used.

// Sliders/filter icon — three horizontal lines, each with a hollow round
// handle at a different position. Used next to every "Filter" control.
// Lines are split around the handles (instead of drawn behind them) so the
// handles stay truly hollow on any background and pick up currentColor.
export function FilterIcon({ className = "" }) {
  const common = { stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", fill: "none" };
  return (
    <svg
      className={`icon-filter ${className}`.trim()}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M2 5.5H5.3M10.1 5.5H22" {...common} />
      <circle cx="7.7" cy="5.5" r="2.4" {...common} />
      <path d="M2 12H14.9M19.7 12H22" {...common} />
      <circle cx="17.3" cy="12" r="2.4" {...common} />
      <path d="M2 18.5H8.3M13.1 18.5H22" {...common} />
      <circle cx="10.7" cy="18.5" r="2.4" {...common} />
    </svg>
  );
}
