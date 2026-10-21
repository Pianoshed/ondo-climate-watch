"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart, ReferenceLine,
  ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  ADDITIVE, MONTHS, RAINY, annualValues, buildWaterfall, correlationMatrix, divColor, fmt, heatMatrix, isNum, kpis, linreg,
  monthlySeries, normalise, pieByLga, pieByMonth, pieBySeason, rolling, seqColor, shortLabel, unitOf,
} from "../lib/analytics";

const COLORS = ["#0f766e", "#b45309", "#1d4ed8", "#be123c", "#6d28d9", "#4d7c0f", "#0e7490", "#a16207", "#64748b", "#db2777"];
const slice = i => (i < COLORS.length ? COLORS[i] : `hsl(${(i * 47) % 360} 55% 45%)`);
const WF = { total: "#0f766e", up: "#b45309", down: "#1d4ed8" };

function Seg({ value, onChange, options, label }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" className={v === value ? "on" : ""} aria-pressed={v === value} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

function Kpi({ label, value, sub, tone }) {
  return (
    <div className="kpi">
      <small>{label}</small>
      <strong>{value}</strong>
      <em className={tone}>{sub}</em>
    </div>
  );
}

const signed = v => (v == null ? "–" : (v > 0 ? "+" : "") + fmt(v));
const tone = v => (v == null || v === 0 ? "" : v > 0 ? "up" : "down");

function Heat({ cols, rows, color, text, title, legend }) {
  return (
    <>
      <div className="heat" tabIndex={0} role="region" aria-label={title}>
        <table>
          <thead><tr><th />{cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.name}>
                <td className="rl">{r.name}</td>
                {r.cells.map((v, i) => {
                  const bg = isNum(v) ? color(v) : "#eef2f4";
                  return <td key={i} title={`${r.name}, ${cols[i]}: ${fmt(v)}`} style={{ background: bg, color: isNum(v) && legend.dark(v) ? "#fff" : "#14202b" }}>{text(v)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="legend"><span>{legend.lo}</span><i style={{ background: legend.gradient }} /><span>{legend.hi}</span></div>
    </>
  );
}

export default function Analytics({ onLogout }) {
  const [meta, setMeta] = useState(null);
  const [sel, setSel] = useState([]);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [primary, setPrimary] = useState("");
  const [compare, setCompare] = useState([]);
  const [style, setStyle] = useState("auto");
  const [norm, setNorm] = useState(false);
  const [smoothPick, setSmoothPick] = useState(null); // null = decide from the length of the period
  const [wfMode, setWfMode] = useState("months");
  const [wfYear, setWfYear] = useState("");
  const [pieBy, setPieBy] = useState("month");
  const [heatBy, setHeatBy] = useState("month");
  const [sx, setSx] = useState("");
  const [sy, setSy] = useState("");

  const lost = e => (e.status === 401 ? onLogout() : setError("Could not load the data. Check that the backend is running."));

  useEffect(() => {
    api("/api/meta").then(m => { setMeta(m); setSel(m.lgas); setStart(m.start); setEnd(m.end); }).catch(lost);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!meta) return;
    const p = new URLSearchParams();
    if (start) p.set("start", start);
    if (end) p.set("end", end);
    api(`/api/data?${p}`).then(setRows).catch(lost);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, start, end]);

  const keys = useMemo(() => (meta && rows ? Object.keys(meta.variables).filter(k => rows.some(r => isNum(r[k]))) : []), [meta, rows]);

  useEffect(() => {
    if (!keys.length) return;
    const pick = (cur, want) => (cur && keys.includes(cur) ? cur : keys.includes(want) ? want : keys[0]);
    setPrimary(c => pick(c, "era5_rain_mm"));
    setSx(c => pick(c, "era5_t2m"));
    setSy(c => (c && keys.includes(c) ? c : keys.includes("era5_rain_mm") ? "era5_rain_mm" : keys[1] || keys[0]));
    setCompare(c => {
      const kept = c.filter(k => keys.includes(k));
      if (kept.length) return kept;
      const d = ["era5_rain_mm", "era5_t2m"].filter(k => keys.includes(k));
      return d.length ? d : keys.slice(0, 2);
    });
  }, [keys]);

  const selRows = useMemo(() => (rows ? rows.filter(r => sel.includes(r.lga)) : []), [rows, sel]);
  const series = useMemo(() => monthlySeries(selRows, keys), [selRows, keys]);
  const smooth = smoothPick ?? series.length > 120; // long periods start on the 12-month average
  const name = k => meta?.variables[k] || k;

  // ---- KPIs
  const kp = useMemo(() => (primary ? kpis(series, primary) : null), [series, primary]);

  // ---- Compare
  const cmpKeys = compare.filter(k => keys.includes(k));
  const units = [...new Set(cmpKeys.map(k => unitOf(name(k))))];
  const useNorm = norm || units.length > 2;
  const cmpData = useMemo(() => {
    const d = smooth ? rolling(series, cmpKeys, 12) : series;
    return useNorm ? normalise(d, cmpKeys) : d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, compare, smooth, useNorm, keys]);
  const axisOf = k => (useNorm || unitOf(name(k)) === units[0] ? "l" : "r");
  const twoAxes = !useNorm && units.length === 2;

  // ---- Waterfall
  const years = useMemo(() => [...new Set(series.filter(s => isNum(s[primary])).map(s => s.year))], [series, primary]);
  const wfYearEff = years.includes(+wfYear) ? +wfYear : years[years.length - 1];
  const wf = useMemo(() => {
    if (!primary) return null;
    const pts = wfMode === "months"
      ? series.filter(s => s.year === wfYearEff && isNum(s[primary])).map(s => ({ name: MONTHS[s.month - 1], value: s[primary] }))
      : annualValues(series, primary).map(y => ({ name: String(y.year), value: y.value }));
    return buildWaterfall(pts);
  }, [series, primary, wfMode, wfYearEff]);

  // ---- Pie
  const pie = useMemo(() => {
    if (!primary) return [];
    return pieBy === "lga" ? pieByLga(selRows, primary) : pieBy === "season" ? pieBySeason(series, primary) : pieByMonth(series, primary);
  }, [selRows, series, primary, pieBy]);
  const pieTotal = pie.reduce((a, d) => a + d.value, 0);

  // ---- Scatter
  const sc = useMemo(() => {
    const pts = series.filter(s => isNum(s[sx]) && isNum(s[sy])).map(s => ({ x: s[sx], y: s[sy], period: s.period, rainy: RAINY.has(s.month) }));
    const fit = linreg(pts.map(p => p.x), pts.map(p => p.y));
    const xs = pts.map(p => p.x);
    return { pts, fit, x0: Math.min(...xs), x1: Math.max(...xs) };
  }, [series, sx, sy]);

  // ---- Heatmap
  const heat = useMemo(() => {
    if (!primary) return null;
    if (heatBy === "corr") {
      const m = correlationMatrix(series, keys);
      return { corr: true, cols: keys.map(k => shortLabel(name(k))), rows: keys.map((k, i) => ({ name: shortLabel(name(k)), cells: m[i] })) };
    }
    return heatMatrix(selRows, primary, heatBy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selRows, series, primary, heatBy, keys]);

  const toggleLga = l => setSel(s => (s.includes(l) ? s.filter(x => x !== l) : [...s, l]));
  const toggleCmp = k => setCompare(c => (c.includes(k) ? c.filter(x => x !== k) : c.length >= 5 ? c : [...c, k]));
  const qs = new URLSearchParams([...sel.map(l => ["lga", l]), ["start", start], ["end", end]]).toString();

  const heatProps = heat && (heat.corr
    ? { color: divColor, text: v => (isNum(v) ? v.toFixed(2) : ""), legend: { lo: "-1 (opposite)", hi: "+1 (move together)", gradient: `linear-gradient(90deg,${divColor(-1)},#fff,${divColor(1)})`, dark: v => Math.abs(v) > 0.65 } }
    : (() => {
      const span = heat.max - heat.min || 1;
      const t = v => (v - heat.min) / span;
      return { color: v => seqColor(t(v)), text: v => (isNum(v) ? fmt(v) : ""), legend: { lo: fmt(heat.min), hi: fmt(heat.max), gradient: `linear-gradient(90deg,${seqColor(0)},${seqColor(1)})`, dark: v => t(v) > 0.6 } };
    })());

  return (
    <>
      <header>
        <h1>Climate analytics</h1>
        <p>Compare indicators month by month, track change over time, and see how LGAs differ.</p>
      </header>
      {error && <div className="err">{error}</div>}
      {meta && (
        <main>
          <aside>
            <label htmlFor="pv">Main indicator</label>
            <select id="pv" value={primary} onChange={e => setPrimary(e.target.value)}>
              {keys.map(k => <option key={k} value={k}>{name(k)}</option>)}
            </select>
            <p className="note">Drives the KPIs, waterfall, pie chart and heatmap.</p>
            <label htmlFor="s">From</label>
            <input id="s" type="month" value={start} min={meta.start} max={meta.end} onChange={e => setStart(e.target.value)} />
            <label htmlFor="e">To</label>
            <input id="e" type="month" value={end} min={meta.start} max={meta.end} onChange={e => setEnd(e.target.value)} />
            <label>LGAs ({sel.length} selected)</label>
            <div className="links">
              <button onClick={() => setSel(meta.lgas)}>Select all</button>
              <button onClick={() => setSel([])}>Clear</button>
            </div>
            <div className="lgas">
              {meta.lgas.map(l => <label key={l}><input type="checkbox" checked={sel.includes(l)} onChange={() => toggleLga(l)} />{l}</label>)}
            </div>
            <a className="btn" href={`/api/export.xlsx?${qs}`}>Download Excel</a>
          </aside>

          <div className="col">
            {!rows && <p>Loading…</p>}
            {rows && !keys.length && <div className="panel">No data yet. Run the pipelines (pipeline.py and era5.py), then reload.</div>}
            {rows && !sel.length && <div className="panel">Select at least one LGA.</div>}

            {kp && sel.length > 0 && (
              <section aria-label="Key figures">
                <div className="kpis">
                  <Kpi label={kp.additive ? "Average yearly total" : "Average"} value={fmt(kp.average)} sub={`${kp.months} months, ${sel.length} LGAs`} />
                  <Kpi label="Highest month" value={fmt(kp.peak[primary])} sub={kp.peak.period} />
                  <Kpi label="Lowest month" value={fmt(kp.low[primary])} sub={kp.low.period} />
                  <Kpi label={`Latest (${kp.latest.period})`} value={fmt(kp.latest[primary])} sub={kp.vsLastYear == null ? "no year-ago value" : `${signed(kp.vsLastYear)} vs a year ago`} tone={tone(kp.vsLastYear)} />
                  <Kpi label="Versus usual for the month" value={signed(kp.vsUsual)} sub="latest minus long-term average" tone={tone(kp.vsUsual)} />
                  <Kpi label="Trend per decade" value={signed(kp.perDecade)} sub={kp.perDecade == null ? "needs 5+ full years" : "linear fit, yearly values"} tone={tone(kp.perDecade)} />
                </div>
                <p className="note">Units: {unitOf(name(primary))}. Values are averages across the selected LGAs.</p>
              </section>
            )}

            {keys.length > 0 && sel.length > 0 && (
              <>
                <section className="panel">
                  <div className="panel-head">
                    <h2>Compare indicators by month</h2>
                    <div className="ctrl">
                      <Seg label="Chart style" value={style} onChange={setStyle} options={[["auto", "Auto"], ["lines", "Lines"], ["bars", "Bars"], ["area", "Area"]]} />
                      <Seg label="Smoothing" value={smooth ? "on" : "off"} onChange={v => setSmoothPick(v === "on")} options={[["off", "Monthly"], ["on", "12-month avg"]]} />
                      <Seg label="Scale" value={useNorm ? "norm" : "raw"} onChange={v => setNorm(v === "norm")} options={[["raw", "Real units"], ["norm", "0–100 scale"]]} />
                    </div>
                  </div>
                  <div className="chips" role="group" aria-label="Indicators to compare (up to 5)">
                    {keys.map(k => (
                      <label key={k} className={compare.includes(k) ? "on" : ""}>
                        <input type="checkbox" checked={compare.includes(k)} onChange={() => toggleCmp(k)} />{name(k)}
                      </label>
                    ))}
                  </div>
                  <div className="chart tall">
                    <ResponsiveContainer>
                      <ComposedChart data={cmpData}>
                        <CartesianGrid stroke="#e4eaee" />
                        <XAxis dataKey="period" minTickGap={50} />
                        <YAxis yAxisId="l" domain={useNorm ? [0, 100] : ["auto", "auto"]} tickFormatter={v => fmt(v)} width={56} />
                        {twoAxes && <YAxis yAxisId="r" orientation="right" tickFormatter={v => fmt(v)} width={56} />}
                        <Tooltip formatter={(v, n, p) => [fmt(useNorm ? p.payload["raw_" + p.dataKey] : v), n]} />
                        <Legend />
                        {cmpKeys.map((k, i) => {
                          const common = { dataKey: k, name: name(k), yAxisId: axisOf(k), stroke: COLORS[i], fill: COLORS[i], isAnimationActive: false, connectNulls: true };
                          const kind = style === "auto" ? (ADDITIVE.has(k) && !smooth ? "bars" : "lines") : style;
                          if (kind === "bars") return <Bar key={k} {...common} stroke="none" fillOpacity={0.55} />;
                          if (kind === "area") return <Area key={k} {...common} type="monotone" fillOpacity={0.2} dot={false} />;
                          return <Line key={k} {...common} type="monotone" dot={false} strokeWidth={2} />;
                        })}
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="note">
                    {useNorm ? "Each indicator is rescaled to its own 0–100 range so different units can share one axis. Hover for real values."
                      : twoAxes ? `Left axis: ${units[0]}. Right axis: ${units[1]}.` : `All shown in ${units[0] || "the same unit"}.`}
                    {units.length > 2 && " More than two units selected, so the 0–100 scale is used."}
                  </p>
                </section>

                <section className="panel">
                  <div className="panel-head">
                    <h2>Waterfall: how {shortLabel(name(primary))} changes</h2>
                    <div className="ctrl">
                      <Seg label="Waterfall steps" value={wfMode} onChange={setWfMode} options={[["months", "Month to month"], ["years", "Year to year"]]} />
                      {wfMode === "months" && (
                        <select aria-label="Year" value={wfYearEff ?? ""} onChange={e => setWfYear(e.target.value)}>
                          {years.map(y => <option key={y} value={y}>{y}</option>)}
                        </select>
                      )}
                    </div>
                  </div>
                  {wf ? (
                    <>
                      <div className="chart">
                        <ResponsiveContainer>
                          <BarChart data={wf.items}>
                            <CartesianGrid stroke="#e4eaee" vertical={false} />
                            <XAxis dataKey="name" interval={wf.items.length > 16 ? "preserveStartEnd" : 0} fontSize={11} />
                            <YAxis domain={[wf.floor, wf.ceil]} allowDataOverflow tickFormatter={v => fmt(v)} width={56} />
                            <Tooltip content={({ active, payload }) => {
                              if (!active || !payload?.length) return null;
                              const d = payload[0].payload;
                              return <div className="tip"><strong>{d.name}</strong><br />Level: {fmt(d.value)}{d.delta != null && <><br />Change: {signed(d.delta)}</>}</div>;
                            }} />
                            <Bar dataKey="range" isAnimationActive={false}>
                              {wf.items.map((d, i) => <Cell key={i} fill={WF[d.kind]} />)}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                      <div className="legend">
                        <span style={{ color: WF.total }}>■ start and end level</span><span style={{ color: WF.up }}>■ increase</span><span style={{ color: WF.down }}>■ decrease</span>
                      </div>
                      <p className="note">
                        {wfMode === "months" ? `Each bar is the change from the previous month in ${wfYearEff}.` : `Each bar is the change from the previous year (${ADDITIVE.has(primary) ? "yearly totals, complete years only" : "yearly averages"}).`}
                        {" "}The axis does not start at zero, so small changes are visible.
                      </p>
                    </>
                  ) : <p>Not enough data in this period for a waterfall.</p>}
                </section>

                <div className="two">
                  <section className="panel">
                    <div className="panel-head">
                      <h2>Share of {shortLabel(name(primary))}</h2>
                      <Seg label="Pie slices" value={pieBy} onChange={setPieBy} options={[["month", "By month"], ["season", "By season"], ["lga", "By LGA"]]} />
                    </div>
                    <div className="chart">
                      <ResponsiveContainer>
                        <PieChart>
                          <Pie data={pie} dataKey="value" nameKey="name" innerRadius="45%" outerRadius="80%" paddingAngle={1} isAnimationActive={false}
                            label={({ name: n, value }) => (value / pieTotal >= (pieBy === "lga" ? 0.07 : 0.05) ? `${n} ${Math.round((value / pieTotal) * 100)}%` : "")} labelLine={false}>
                            {pie.map((d, i) => <Cell key={d.name} fill={slice(i)} />)}
                          </Pie>
                          <Tooltip formatter={(v, n) => [`${fmt(v)} (${Math.round((v / pieTotal) * 100)}%)`, n]} />
                          {pieBy === "lga" && <Legend />}
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <p className="note">
                      {ADDITIVE.has(primary) ? "Shares of rainfall." : "Shares of the summed averages. This is most meaningful for rainfall."}
                      {pieBy === "season" && " Rainy season is taken as April to October."}
                    </p>
                  </section>

                  <section className="panel">
                    <div className="panel-head"><h2>Indicator against indicator</h2></div>
                    <div className="ctrl">
                      <select aria-label="Horizontal axis" value={sx} onChange={e => setSx(e.target.value)}>{keys.map(k => <option key={k} value={k}>{name(k)}</option>)}</select>
                      <span>vs</span>
                      <select aria-label="Vertical axis" value={sy} onChange={e => setSy(e.target.value)}>{keys.map(k => <option key={k} value={k}>{name(k)}</option>)}</select>
                    </div>
                    <div className="chart">
                      <ResponsiveContainer>
                        <ScatterChart>
                          <CartesianGrid stroke="#e4eaee" />
                          <XAxis type="number" dataKey="x" name={name(sx)} domain={["auto", "auto"]} tickFormatter={v => fmt(v)} />
                          <YAxis type="number" dataKey="y" name={name(sy)} domain={["auto", "auto"]} tickFormatter={v => fmt(v)} width={56} />
                          <Tooltip content={({ active, payload }) => {
                            if (!active || !payload?.length) return null;
                            const d = payload[0].payload;
                            return <div className="tip"><strong>{d.period}</strong><br />{shortLabel(name(sx))}: {fmt(d.x)}<br />{shortLabel(name(sy))}: {fmt(d.y)}</div>;
                          }} />
                          <Legend />
                          <Scatter name="Rainy season" data={sc.pts.filter(p => p.rainy)} fill={COLORS[2]} isAnimationActive={false} />
                          <Scatter name="Dry season" data={sc.pts.filter(p => !p.rainy)} fill={COLORS[1]} isAnimationActive={false} />
                          {sc.fit && <ReferenceLine segment={[{ x: sc.x0, y: sc.fit.intercept + sc.fit.slope * sc.x0 }, { x: sc.x1, y: sc.fit.intercept + sc.fit.slope * sc.x1 }]} stroke="#14202b" strokeDasharray="5 4" />}
                        </ScatterChart>
                      </ResponsiveContainer>
                    </div>
                    <p className="note">
                      {sc.fit ? `Correlation r = ${sc.fit.r.toFixed(2)} across ${sc.fit.n} months. Correlation does not show cause.` : "Not enough overlapping data."}
                    </p>
                  </section>
                </div>

                <section className="panel">
                  <div className="panel-head">
                    <h2>Heatmap{heat?.corr ? ": how indicators move together" : `: ${shortLabel(name(primary))} by LGA`}</h2>
                    <Seg label="Heatmap layout" value={heatBy} onChange={setHeatBy} options={[["month", "LGA × month"], ["year", "LGA × year"], ["corr", "Correlations"]]} />
                  </div>
                  {heat && heatProps && <Heat key={heatBy} cols={heat.cols} rows={heat.rows} title="Heatmap" {...heatProps} />}
                  <p className="note">
                    {heatBy === "month" && "Average for each calendar month across all years in the period."}
                    {heatBy === "year" && "Average monthly value for each year."}
                    {heatBy === "corr" && "Pearson correlation of monthly values across the selected LGAs."}
                  </p>
                </section>
              </>
            )}
          </div>
        </main>
      )}
    </>
  );
}
