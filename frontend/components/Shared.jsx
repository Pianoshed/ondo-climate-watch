"use client";
// Small pieces used on several pages.
export function Kpi({ label, value, sub, tone, hl }) {
  return (
    <div className={"kpi" + (hl ? " hl" : "")}>
      <small>{label}</small>
      <strong>{value}</strong>
      <em className={tone}>{sub}</em>
    </div>
  );
}

export function Seg({ value, onChange, options, label }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" className={v === value ? "on" : ""} aria-pressed={v === value} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

// Plain-language reading of the figures above it.
export function Interpret({ title = "What this means", items, foot }) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  return (
    <section className="panel interp" aria-label={title}>
      <h2>{title}</h2>
      <ul>{list.map((t, i) => <li key={i}>{t}</li>)}</ul>
      {foot && <p className="note">{foot}</p>}
    </section>
  );
}
