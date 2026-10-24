"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  ADDITIVE, RAINY, annualValues, bandSeries, climatology, fmt, interpretAnnual, interpretSeason, interpretState, isNum, kpis, linreg,
  lgaStats, mean, monthlySeries, rolling, shortLabel, signed, stateSummary, tone, unitOf,
} from "../lib/analytics";
import { Interpret, Kpi, Seg } from "./Shared";

const COLORS = ["#0f766e", "#b45309", "#1d4ed8", "#be123c", "#6d28d9", "#4d7c0f", "#0e7490", "#a16207"];
const STATE = "Ondo State";

export default function Dashboard({ onLogout }) {
  const [meta, setMeta] = useState(null);
  const [sel, setSel] = useState([]);
  const [variable, setVariable] = useState("rain_mm");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [rows, setRows] = useState(null);
  const [smooth, setSmooth] = useState(false);
  const [sort, setSort] = useState("value");
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/meta")
      .then(m => { setMeta(m); setSel(m.lgas.slice(0, 3)); setStart(m.start); setEnd(m.end); })
      .catch(e => (e.status === 401 ? onLogout() : setError("No data yet. Load boundaries and run the pipeline, then reload.")));
  }, [onLogout]);

  useEffect(() => {
    if (!meta) return;
    const p = new URLSearchParams();
    if (start) p.set("start", start);
    if (end) p.set("end", end);
    api(`/api/data?${p}`).then(setRows).catch(e => (e.status === 401 ? onLogout() : setError("Could not load the data.")));
  }, [meta, start, end, onLogout]);

  const keys = useMemo(() => (meta && rows ? Object.keys(meta.variables).filter(k => rows.some(r => isNum(r[k]))) : []), [meta, rows]);
  useEffect(() => { if (keys.length && !keys.includes(variable)) setVariable(keys[0]); }, [keys, variable]);

  const label = meta?.variables[variable] || variable;
  const unit = unitOf(label);
  const sum = useMemo(() => (rows && keys.includes(variable) ? stateSummary(rows, variable) : null), [rows, variable, keys]);

  // "Ondo State at a glance": every indicator in one table.
  const glance = useMemo(() => {
    if (!rows || !keys.length) return [];
    const s = monthlySeries(rows, keys);
    return keys.map(k => {
      const kp = kpis(s, k), per = lgaStats(rows, k);
      return kp && per.length ? { k, kp, per, avg: mean(per.map(p => p.value)) } : null;
    }).filter(Boolean);
  }, [rows, keys]);

  const band = useMemo(() => (rows && sum ? bandSeries(rows, variable) : []), [rows, variable, sum]);
  const stateLine = useMemo(() => (smooth ? rolling(band, ["mean"], 12) : band), [band, smooth]);

  const annual = useMemo(() => (sum ? annualValues(sum.series, variable) : []), [sum, variable]);
  const annualFit = annual.length >= 5 ? linreg(annual.map(a => a.year), annual.map(a => a.value)) : null;
  const annualData = annual.map(a => ({ ...a, trend: annualFit ? annualFit.intercept + annualFit.slope * a.year : null }));
  const season = useMemo(() => (sum ? climatology(sum.series, variable) : []), [sum, variable]);

  const compare = useMemo(() => {
    if (!rows) return [];
    const m = {};
    band.forEach(b => { m[b.period] = { period: b.period, [STATE]: b.mean }; });
    rows.forEach(r => { if (sel.includes(r.lga) && m[r.period]) m[r.period][r.lga] = r[variable]; });
    return Object.values(m);
  }, [rows, band, sel, variable]);

  const table = useMemo(() => {
    if (!sum) return [];
    const t = sum.per.map((p, i) => ({ ...p, rank: i + 1, diff: p.value - sum.avg, pct: sum.avg ? ((p.value - sum.avg) / Math.abs(sum.avg)) * 100 : null }));
    if (sort === "name") return [...t].sort((a, b) => a.lga.localeCompare(b.lga));
    if (sort === "trend") return [...t].sort((a, b) => (b.perDecade ?? -Infinity) - (a.perDecade ?? -Infinity));
    return t;
  }, [sum, sort]);

  const toggle = l => setSel(s => (s.includes(l) ? s.filter(x => x !== l) : [...s, l]));
  const qs = new URLSearchParams([...sel.map(l => ["lga", l]), ["variable", variable], ["start", start], ["end", end]]).toString();
  const kp = sum?.kp;

  return (
    <>
      <header>
        <h1>Ondo State climate dashboard</h1>
        <p>State summary first, then every LGA. Monthly rainfall, temperature, humidity, radiation, wind and soil moisture (CHIRPS, NASA POWER and ERA5, 1996 to date).</p>
      </header>
      {error && <div className="err">{error}</div>}
      {meta && (
        <main>
          <aside>
            <label htmlFor="v">Indicator</label>
            <select id="v" value={variable} onChange={e => setVariable(e.target.value)}>
              {(keys.length ? keys : Object.keys(meta.variables)).map(k => <option key={k} value={k}>{meta.variables[k]}</option>)}
            </select>
            <label htmlFor="s">From</label>
            <input id="s" type="month" value={start} min={meta.start} max={meta.end} onChange={e => setStart(e.target.value)} />
            <label htmlFor="e">To</label>
            <input id="e" type="month" value={end} min={meta.start} max={meta.end} onChange={e => setEnd(e.target.value)} />
            <p className="note">The state figures always use all {meta.lgas.length} LGAs. The LGA choice below only drives the comparison chart and the data preview.</p>
            <label>Compare LGAs ({sel.length} selected)</label>
            <div className="links">
              <button onClick={() => setSel(meta.lgas)}>Select all</button>
              <button onClick={() => setSel([])}>Clear</button>
            </div>
            <div className="lgas">
              {meta.lgas.map(l => (
                <label key={l}><input type="checkbox" checked={sel.includes(l)} onChange={() => toggle(l)} />{l}</label>
              ))}
            </div>
            <a className="btn" href={`/api/export.xlsx?${qs}`}>Download Excel</a>
          </aside>

          <div className="col">
            {!rows && <p>Loading…</p>}
            {rows && !sum && <div className="panel">No data for this indicator and period.</div>}

            {sum && (
              <>
                <section aria-label="Ondo State key figures">
                  <h3 className="sec"><span className="badge">Ondo State</span> {shortLabel(label)}, {start} to {end}</h3>
                  <div className="kpis" style={{ marginTop: 8 }}>
                    <Kpi hl label={kp.additive ? "State average yearly total" : "State average"} value={`${fmt(sum.avg)}`} sub={`${unit || "mean of LGAs"} · ${sum.per.length} LGAs`} />
                    <Kpi label={`Latest month (${kp.latest.period})`} value={fmt(kp.latest[variable])} sub={kp.vsLastYear == null ? "no year-ago value" : `${signed(kp.vsLastYear)} vs a year ago`} tone={tone(kp.vsLastYear)} />
                    <Kpi label="Versus usual for the month" value={signed(kp.vsUsual)} sub="latest minus long-term average" tone={tone(kp.vsUsual)} />
                    <Kpi label="Trend per decade" value={signed(kp.perDecade)} sub={kp.perDecade == null ? "needs 5+ full years" : `${unit} · straight-line fit`} tone={tone(kp.perDecade)} />
                    <Kpi label="Highest month (state)" value={fmt(kp.peak[variable])} sub={kp.peak.period} />
                    <Kpi label="Lowest month (state)" value={fmt(kp.low[variable])} sub={kp.low.period} />
                    <Kpi label="Highest LGA" value={sum.hi.lga} sub={`${fmt(sum.hi.value)} ${unit}`} />
                    <Kpi label="Lowest LGA" value={sum.lo.lga} sub={`${fmt(sum.lo.value)} ${unit}`} />
                    <Kpi label="Gap between LGAs" value={fmt(sum.spread)} sub={`${unit} · highest minus lowest`} />
                    <Kpi label="LGAs above state average" value={`${sum.above} of ${sum.per.length}`} sub={`${sum.per.length - sum.above} at or below`} />
                  </div>
                </section>
                <Interpret title="Ondo State summary, in plain words" items={interpretState(label, variable, sum)} />
              </>
            )}

            {glance.length > 0 && (
              <section className="panel">
                <h2>Ondo State at a glance: all indicators</h2>
                <p className="note" style={{ marginTop: 0 }}>State value = mean of the LGAs. Click a row to load that indicator into the charts below.</p>
                <div className="tbl tall">
                  <table className="glance">
                    <thead><tr><th>Indicator</th><th>State average</th><th>Latest</th><th>Vs usual</th><th>Trend / decade</th><th>Highest LGA</th><th>Lowest LGA</th></tr></thead>
                    <tbody>
                      {glance.map(g => (
                        <tr key={g.k} className={g.k === variable ? "on" : ""} onClick={() => setVariable(g.k)}>
                          <td>{meta.variables[g.k]}</td>
                          <td>{fmt(g.avg)}</td>
                          <td>{fmt(g.kp.latest[g.k])} <small>({g.kp.latest.period})</small></td>
                          <td className={tone(g.kp.vsUsual)}>{signed(g.kp.vsUsual)}</td>
                          <td className={tone(g.kp.perDecade)}>{signed(g.kp.perDecade)}</td>
                          <td>{g.per[0].lga} ({fmt(g.per[0].value)})</td>
                          <td>{g.per[g.per.length - 1].lga} ({fmt(g.per[g.per.length - 1].value)})</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="note">Rainfall rows are yearly totals; other rows are averages. Orange = above usual or rising, blue = below usual or falling.</p>
              </section>
            )}

            {sum && (
              <>
                <section className="panel">
                  <div className="panel-head">
                    <h2>{STATE}: {shortLabel(label)} over time</h2>
                    <Seg label="Smoothing" value={smooth ? "on" : "off"} onChange={v => setSmooth(v === "on")} options={[["off", "Monthly"], ["on", "12-month avg"]]} />
                  </div>
                  <div className="chart tall">
                    <ResponsiveContainer>
                      <ComposedChart data={stateLine}>
                        <CartesianGrid stroke="#e4eaee" /><XAxis dataKey="period" minTickGap={40} /><YAxis tickFormatter={v => fmt(v)} width={56} />
                        <Tooltip formatter={(v, n) => [Array.isArray(v) ? `${fmt(v[0])} to ${fmt(v[1])}` : fmt(v), n]} /><Legend />
                        {!smooth && <Area dataKey="band" name="Range across LGAs" stroke="none" fill="#0f766e" fillOpacity={0.15} isAnimationActive={false} />}
                        <Line dataKey="mean" name="Ondo State (mean of LGAs)" stroke="#0f766e" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="note">{smooth ? "12-month trailing average removes the seasons so the long-term direction is easier to see." : "The shaded band spans the lowest to the highest LGA each month, so you can see how much LGAs differ from the state line."}</p>
                </section>

                <div className="two">
                  <section className="panel">
                    <h2>{STATE}: yearly {kp.additive ? "totals" : "averages"}</h2>
                    <div className="chart">
                      <ResponsiveContainer>
                        <ComposedChart data={annualData}>
                          <CartesianGrid stroke="#e4eaee" /><XAxis dataKey="year" minTickGap={20} /><YAxis tickFormatter={v => fmt(v)} width={56} />
                          <Tooltip formatter={v => fmt(v)} /><Legend />
                          <Bar dataKey="value" name={kp.additive ? "Yearly total" : "Yearly average"} fill="#0f766e" fillOpacity={0.6} isAnimationActive={false} />
                          {annualFit && <Line dataKey="trend" name="Trend line" stroke="#b45309" strokeWidth={2} dot={false} isAnimationActive={false} />}
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                    <p className="note">Complete years only{kp.additive ? " (all 12 months for rainfall)" : " (9+ months)"}.</p>
                  </section>
                  <section className="panel">
                    <h2>{STATE}: typical year</h2>
                    <div className="chart">
                      <ResponsiveContainer>
                        <BarChart data={season}>
                          <CartesianGrid stroke="#e4eaee" vertical={false} /><XAxis dataKey="name" /><YAxis tickFormatter={v => fmt(v)} width={56} /><Tooltip formatter={v => fmt(v)} />
                          <Bar dataKey="value" name={shortLabel(label)} isAnimationActive={false}>
                            {season.map(d => <Cell key={d.name} fill={ADDITIVE.has(variable) && RAINY.has(d.month) ? "#1d4ed8" : "#0f766e"} />)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <p className="note">Long-term average for each calendar month.{ADDITIVE.has(variable) && " Blue = rainy season (April to October)."}</p>
                  </section>
                </div>
                <Interpret title="Yearly pattern and seasons" items={[...interpretAnnual(annual, label), ...interpretSeason(sum.series, variable, label)]} />

                <section className="panel">
                  <h2>LGAs against the state average: {shortLabel(label)}</h2>
                  <div className="chart">
                    <ResponsiveContainer>
                      <BarChart data={sum.per}>
                        <CartesianGrid stroke="#e4eaee" /><XAxis dataKey="lga" interval={0} angle={-35} textAnchor="end" height={80} fontSize={11} /><YAxis tickFormatter={v => fmt(v)} width={56} />
                        <Tooltip formatter={v => fmt(v)} />
                        <ReferenceLine y={sum.avg} stroke="#14202b" strokeDasharray="5 4" label={{ value: "State average", position: "insideTopRight", fontSize: 11 }} />
                        <Bar dataKey="value" name={shortLabel(label)} isAnimationActive={false}>
                          {sum.per.map(p => <Cell key={p.lga} fill={p.value > sum.avg ? "#b45309" : "#0f766e"} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="note">Orange = above the state average, green = at or below. Rainfall is the yearly total.</p>
                </section>

                <section className="panel">
                  <div className="panel-head">
                    <h2>LGA summary table</h2>
                    <Seg label="Sort" value={sort} onChange={setSort} options={[["value", "Highest first"], ["trend", "Trend"], ["name", "A to Z"]]} />
                  </div>
                  <div className="tbl tall">
                    <table>
                      <thead><tr><th>Rank</th><th>LGA</th><th>Average</th><th>Vs state</th><th>Vs state %</th><th>Trend / decade</th><th>Latest month</th></tr></thead>
                      <tbody>
                        {table.map(t => (
                          <tr key={t.lga}>
                            <td>{t.rank}</td><td>{t.lga}</td><td>{fmt(t.value)}</td>
                            <td className={tone(t.diff)}>{signed(t.diff)}</td>
                            <td className={tone(t.diff)}>{t.pct == null ? "–" : `${t.pct > 0 ? "+" : ""}${t.pct.toFixed(1)}%`}</td>
                            <td className={tone(t.perDecade)}>{signed(t.perDecade)}</td>
                            <td>{fmt(t.latest)}</td>
                          </tr>
                        ))}
                        <tr style={{ fontWeight: 700 }}><td /><td>{STATE}</td><td>{fmt(sum.avg)}</td><td /><td /><td className={tone(kp.perDecade)}>{signed(kp.perDecade)}</td><td>{fmt(kp.latest[variable])}</td></tr>
                      </tbody>
                    </table>
                  </div>
                  <p className="note">The state row is the mean of the LGAs above it. Units: {unit || "as shown"}.</p>
                </section>

                <section className="panel">
                  <h2>Selected LGAs against the state</h2>
                  {sel.length ? (
                    <div className="chart tall">
                      <ResponsiveContainer>
                        <LineChart data={compare}>
                          <CartesianGrid stroke="#e4eaee" /><XAxis dataKey="period" minTickGap={40} /><YAxis tickFormatter={v => fmt(v)} width={56} /><Tooltip formatter={v => fmt(v)} /><Legend />
                          <Line dataKey={STATE} stroke="#14202b" strokeDasharray="6 4" strokeWidth={2} dot={false} isAnimationActive={false} />
                          {sel.slice(0, 8).map((l, i) => <Line key={l} dataKey={l} stroke={COLORS[i]} dot={false} strokeWidth={2} isAnimationActive={false} connectNulls />)}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  ) : <p>Pick one or more LGAs on the left to compare them with the state line.</p>}
                  {sel.length > 8 && <p className="note">Chart shows the first 8 selected LGAs. The Excel file includes all.</p>}
                </section>

                <section className="panel">
                  <h2>Data preview (selected LGAs)</h2>
                  <div className="tbl">
                    <table>
                      <thead><tr><th>LGA</th><th>Month</th>{keys.map(k => <th key={k}>{meta.variables[k]}</th>)}</tr></thead>
                      <tbody>
                        {rows.filter(r => sel.includes(r.lga)).slice(0, 100).map(r => (
                          <tr key={r.lga + r.period}><td>{r.lga}</td><td>{r.period}</td>{keys.map(k => <td key={k}>{r[k] ?? ""}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </>
            )}
          </div>
        </main>
      )}
    </>
  );
}
