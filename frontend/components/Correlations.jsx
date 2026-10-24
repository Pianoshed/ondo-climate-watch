"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { corrSentence, divColor, fmt, isNum, normalise, pNum, shortLabel, unitOf } from "../lib/analytics";
import { Interpret, Kpi } from "./Shared";

const COLORS = ["#0f766e", "#b45309", "#1d4ed8", "#be123c", "#6d28d9", "#4d7c0f", "#0e7490", "#a16207", "#64748b", "#db2777"];
const DEFAULT = ["rain_mm", "t2m", "t2m_max", "rh2m"];
const stars = p => (p == null ? "" : p < 0.01 ? "**" : p < 0.05 ? "*" : "");

function Seg({ value, onChange, options, label }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" className={v === value ? "on" : ""} aria-pressed={v === value} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

export default function Correlations({ onLogout }) {
  const [meta, setMeta] = useState(null);
  const [vars, setVars] = useState(DEFAULT);
  const [scope, setScope] = useState("state");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [method, setMethod] = useState("pearson");
  const [deseason, setDeseason] = useState(true);
  const [pair, setPair] = useState(["rain_mm", "rh2m"]);
  const [maxLag, setMaxLag] = useState(12);
  const [corr, setCorr] = useState(null);
  const [trend, setTrend] = useState(null);
  const [shown, setShown] = useState(DEFAULT);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/meta")
      .then(m => { setMeta(m); setStart(m.start); setEnd(m.end); })
      .catch(e => (e.status === 401 ? onLogout() : setError("No data yet. Load boundaries and run the pipeline, then reload.")));
  }, [onLogout]);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    vars.forEach(v => p.append("variable", v));
    p.set("scope", scope); p.set("method", method); p.set("deseasonalise", deseason ? "1" : "0");
    if (start) p.set("start", start);
    if (end) p.set("end", end);
    return p;
  }, [vars, scope, method, deseason, start, end]);

  useEffect(() => {
    if (!meta || vars.length < 2) { setCorr(null); setTrend(null); return; }
    const lost = e => (e.status === 401 ? onLogout() : setError(e.message));
    setError("");
    const c = new URLSearchParams(qs);
    if (pair[0] && pair[1] && vars.includes(pair[0]) && vars.includes(pair[1])) {
      c.set("lag_a", pair[0]); c.set("lag_b", pair[1]); c.set("max_lag", String(maxLag));
    }
    api(`/api/correlations?${c}`).then(setCorr).catch(lost);
    const t = new URLSearchParams(qs); t.delete("method"); t.delete("deseasonalise");
    api(`/api/trends?${t}`).then(setTrend).catch(lost);
  }, [qs, pair, maxLag, meta, vars, onLogout]);

  const toggle = v => setVars(s => (s.includes(v) ? s.filter(x => x !== v) : [...s, v]));
  const label = k => meta?.variables[k] ?? k;
  const cell = (a, b) => corr?.matrix.find(c => c.a === a && c.b === b);

  const best = useMemo(() => {
    const ok = (corr?.lag || []).filter(l => isNum(l.r));
    return ok.length ? ok.reduce((m, l) => (Math.abs(l.r) > Math.abs(m.r) ? l : m)) : null;
  }, [corr]);

  // Yearly values of the chosen indicators, each rescaled 0-100 so different units can be compared on one chart.
  const overlay = useMemo(() => {
    if (!trend) return [];
    const keys = shown.filter(k => trend.trends[k]);
    const years = [...new Set(keys.flatMap(k => trend.trends[k].annual.map(a => a.year)))].sort();
    const rows = years.map(y => {
      const r = { period: String(y) };
      keys.forEach(k => { r[k] = trend.trends[k].annual.find(a => a.year === y)?.value ?? null; });
      return r;
    });
    return normalise(rows, keys);
  }, [trend, shown]);

  // Each pair once, strongest first.
  const pairs = useMemo(() => {
    if (!corr) return [];
    const seen = new Set();
    return corr.matrix.filter(c => c.a !== c.b && isNum(c.r)).filter(c => {
      const k = [c.a, c.b].sort().join("|");
      if (seen.has(k)) return false;
      seen.add(k); return true;
    }).sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  }, [corr]);
  const sigPairs = pairs.filter(c => pNum(c.p) < 0.05);
  const tr = trend ? trend.variables.map(k => ({ k, t: trend.trends[k] })).filter(x => x.t) : [];
  const sigTrends = tr.filter(x => pNum(x.t.p) < 0.05);
  const areaName = scope === "state" ? "Ondo State (average of LGAs)" : scope;
  const lagData = (corr?.lag || []).map(l => ({ ...l, r: l.r ?? 0, sig: l.p != null && l.p < 0.05 }));

  return (
    <>
      <header>
        <h1>Correlations and trends</h1>
        <p>How the indicators move together over time, with what lag, and which way each is heading. Works on the full history loaded, so months before 2015 are included once the pipeline has fetched them.</p>
      </header>
      {error && <div className="err">{error}</div>}
      {meta && (
        <main>
          <aside>
            <label>Indicators ({vars.length} selected, need 2+)</label>
            <div className="lgas">
              {Object.entries(meta.variables).map(([k, v]) => (
                <label key={k}><input type="checkbox" checked={vars.includes(k)} onChange={() => toggle(k)} />{v}</label>
              ))}
            </div>
            <label htmlFor="sc">Area</label>
            <select id="sc" value={scope} onChange={e => setScope(e.target.value)}>
              <option value="state">Ondo State (average of LGAs)</option>
              {meta.lgas.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <label htmlFor="s">From</label>
            <input id="s" type="month" value={start} min={meta.start} max={meta.end} onChange={e => setStart(e.target.value)} />
            <label htmlFor="e">To</label>
            <input id="e" type="month" value={end} min={meta.start} max={meta.end} onChange={e => setEnd(e.target.value)} />
            <label>Method</label>
            <Seg label="Method" value={method} onChange={setMethod} options={[["pearson", "Pearson"], ["spearman", "Spearman"]]} />
            <label>Seasonal cycle</label>
            <Seg label="Seasonal cycle" value={deseason ? "y" : "n"} onChange={v => setDeseason(v === "y")} options={[["y", "Removed"], ["n", "Kept"]]} />
            <p className="note">Removed compares each month with its own average, so the calendar does not inflate the result. Use Kept only to see the raw seasonal link.</p>
          </aside>
          <div className="col">
            {corr && corr.matrix.length > 0 && (
              <section aria-label="Key figures">
                <h3 className="sec"><span className="badge">{areaName}</span> {corr.start} to {corr.end}</h3>
                <div className="kpis" style={{ marginTop: 8 }}>
                  <Kpi hl label="Months analysed" value={corr.months} sub={`${vars.length} indicators`} />
                  <Kpi label="Strongest link" value={pairs[0] ? pairs[0].r.toFixed(2) : "–"} sub={pairs[0] ? `${shortLabel(label(pairs[0].a))} and ${shortLabel(label(pairs[0].b))}` : "no pair"} />
                  <Kpi label="Significant pairs" value={`${sigPairs.length} of ${pairs.length}`} sub="p below 0.05" />
                  <Kpi label="Strongest lag" value={best ? `${best.lag} mo` : "–"} sub={best ? `r = ${fmt(best.r)}` : "choose a pair"} />
                  <Kpi label="Significant trends" value={`${sigTrends.length} of ${tr.length}`} sub="p below 0.05" />
                </div>
              </section>
            )}
            <section className="panel">
              <h2>Correlation matrix</h2>
              {!corr || !corr.matrix.length ? <p>Pick at least two indicators that have data in this period.</p> : (
                <>
                  <p className="note">{corr.months} months, {corr.start} to {corr.end}. * p&lt;0.05, ** p&lt;0.01, adjusted for month-to-month autocorrelation. Hover a cell for n.</p>
                  <div className="heat" tabIndex={0} role="region" aria-label="Correlation matrix">
                    <table>
                      <thead><tr><th />{corr.variables.map(v => <th key={v} title={label(v)}>{shortLabel(label(v))}</th>)}</tr></thead>
                      <tbody>
                        {corr.variables.map(a => (
                          <tr key={a}>
                            <td className="rl">{shortLabel(label(a))}</td>
                            {corr.variables.map(b => {
                              const c = cell(a, b);
                              const r = a === b ? 1 : c?.r;
                              return (
                                <td key={b} style={{ background: isNum(r) ? divColor(r) : "#eef2f4", color: isNum(r) && Math.abs(r) > 0.6 ? "#fff" : "#14202b", cursor: "pointer" }}
                                  title={a === b ? "" : `${shortLabel(label(a))} vs ${shortLabel(label(b))}: r=${fmt(c?.r)}, p=${c?.p ?? "–"}, n=${c?.n}, effective n=${c?.n_eff ?? "–"}`}
                                  onClick={() => a !== b && setPair([a, b])}>
                                  {a === b ? "" : isNum(r) ? r.toFixed(2) + stars(c?.p) : "–"}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="note">Click a cell to see its lag profile below.</p>
                </>
              )}
            </section>

            <Interpret title="Correlation matrix: what it says" items={[
              ...pairs.slice(0, 3).map(c => corrSentence(shortLabel(label(c.a)), shortLabel(label(c.b)), c.r, pNum(c.p), c.n)),
              pairs.length && !sigPairs.length ? "No pair is statistically clear in this period, so treat all links as unproven." : null,
              deseason ? "The seasonal cycle is removed, so these links are about unusual months, not about the calendar." : "The seasonal cycle is kept, so strong links may simply reflect the calendar (for example, both rise in the rainy season).",
            ]} foot="r runs from -1 to +1. Below 0.3 is weak, 0.3 to 0.6 moderate, above 0.6 strong. Correlation does not show cause." />

            <section className="panel">
              <h2>Does one lead the other? {corr?.lag_pair ? `${shortLabel(label(corr.lag_pair[0]))} then ${shortLabel(label(corr.lag_pair[1]))}` : ""}</h2>
              <div className="ctrl">
                <select aria-label="First indicator" value={pair[0]} onChange={e => setPair([e.target.value, pair[1]])}>
                  {vars.map(v => <option key={v} value={v}>{label(v)}</option>)}
                </select>
                <span>then</span>
                <select aria-label="Second indicator" value={pair[1]} onChange={e => setPair([pair[0], e.target.value])}>
                  {vars.map(v => <option key={v} value={v}>{label(v)}</option>)}
                </select>
                <Seg label="Lag range" value={String(maxLag)} onChange={v => setMaxLag(Number(v))} options={[["6", "±6 mo"], ["12", "±12 mo"], ["24", "±24 mo"]]} />
              </div>
              {lagData.length ? (
                <>
                  <div className="chart">
                    <ResponsiveContainer>
                      <BarChart data={lagData}>
                        <CartesianGrid stroke="#e4eaee" /><XAxis dataKey="lag" /><YAxis domain={[-1, 1]} /><Tooltip formatter={(v, n, p) => [`r=${fmt(p.payload.r)}, p=${p.payload.p ?? "–"}`, "Correlation"]} labelFormatter={l => `Lag ${l} months`} />
                        <ReferenceLine y={0} stroke="#14202b" />
                        <Bar dataKey="r">{lagData.map((l, i) => <Cell key={i} fill={l.sig ? "#0f766e" : "#b6c4cc"} />)}</Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="note">Positive lag: the second indicator follows the first by that many months. Dark bars are significant (p&lt;0.05). {best && `Strongest: r=${fmt(best.r)} at ${best.lag} months.`} Strongest-of-many is a screening hint, not proof of a delay.</p>
                </>
              ) : <p>Choose two selected indicators.</p>}
            </section>

            {lagData.length > 0 && best && corr?.lag_pair && (
              <Interpret title="Lag: what it says" items={[
                `The strongest link between ${shortLabel(label(corr.lag_pair[0]))} and ${shortLabel(label(corr.lag_pair[1]))} is at a lag of ${best.lag} months (r = ${fmt(best.r)}). ${best.lag > 0 ? `${shortLabel(label(corr.lag_pair[1]))} tends to follow ${shortLabel(label(corr.lag_pair[0]))} by about ${best.lag} months.` : best.lag < 0 ? `${shortLabel(label(corr.lag_pair[0]))} tends to follow ${shortLabel(label(corr.lag_pair[1]))} by about ${-best.lag} months.` : "They move in the same month."}`,
                best.p != null && pNum(best.p) >= 0.05 ? "That peak is not statistically clear, so do not read a delay into it." : null,
              ]} foot="The best lag is picked from many, so it is a hint to investigate, not proof of a delay." />
            )}

            <section className="panel">
              <h2>Trends (complete years only)</h2>
              {!trend || !trend.variables.length ? <p>No trend data for this selection.</p> : (
                <>
                  <div className="tbl">
                    <table>
                      <thead><tr><th>Indicator</th><th>Change per decade</th><th>p</th><th>Direction</th><th>Years</th><th>Show</th></tr></thead>
                      <tbody>
                        {trend.variables.map(k => {
                          const t = trend.trends[k];
                          return (
                            <tr key={k}>
                              <td>{label(k)}</td>
                              <td>{isNum(t.slope_per_decade) ? `${t.slope_per_decade > 0 ? "+" : ""}${fmt(t.slope_per_decade)} ${unitOf(label(k))}` : "–"}</td>
                              <td>{t.p ?? "–"}</td>
                              <td>{t.direction}</td>
                              <td>{t.start_year ? `${t.start_year}–${t.end_year} (${t.n_years})` : t.n_years}</td>
                              <td><input type="checkbox" aria-label={`Show ${label(k)}`} checked={shown.includes(k)} onChange={() => setShown(s => (s.includes(k) ? s.filter(x => x !== k) : [...s, k]))} /></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className="note">Theil–Sen slope with a Mann-Kendall style test: robust to outliers. A short record can hide a real trend, so check the years covered.</p>
                  <h2>Trends side by side (each indicator rescaled 0 to 100)</h2>
                  <div className="chart">
                    <ResponsiveContainer>
                      <LineChart data={overlay}>
                        <CartesianGrid stroke="#e4eaee" /><XAxis dataKey="period" minTickGap={30} /><YAxis domain={[0, 100]} /><Tooltip formatter={v => fmt(v)} /><Legend />
                        {shown.filter(k => trend.trends[k]).map((k, i) => (
                          <Line key={k} name={shortLabel(label(k))} dataKey={k} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} connectNulls />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </>
              )}
            </section>
            {tr.length > 0 && (
              <Interpret title="Trends: what they say" items={tr.map(({ k, t }) => {
                const clear = pNum(t.p) < 0.05, u = unitOf(label(k));
                return isNum(t.slope_per_decade)
                  ? `${shortLabel(label(k))}: ${t.slope_per_decade > 0 ? "up" : "down"} about ${fmt(Math.abs(t.slope_per_decade))} ${u} per decade (${t.start_year}–${t.end_year}). ${clear ? "This trend is statistically clear." : "Not statistically clear, so treat it as no firm trend."}`
                  : null;
              })} foot="A short record can hide a real trend, so check the years covered." />
            )}
          </div>
        </main>
      )}
    </>
  );
}
