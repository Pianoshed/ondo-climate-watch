"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";
import { fmt, isNum, linreg } from "../lib/analytics";
import { mapPaths } from "../lib/geo";

const CLIMATE = ["rain_mm", "t2m", "t2m_max", "rh2m"];
const key = i => `${i.source}|${i.indicator}`;

export default function Surveys({ onLogout }) {
  const [items, setItems] = useState(null);
  const [pick, setPick] = useState("");
  const [year, setYear] = useState("");
  const [rows, setRows] = useState([]);
  const [fc, setFc] = useState(null);
  const [corr, setCorr] = useState(null);
  const [vars, setVars] = useState({});
  const [cv, setCv] = useState("rain_mm");
  const [method, setMethod] = useState("pearson");
  const [hover, setHover] = useState(null);
  const [error, setError] = useState("");

  const item = items?.find(i => key(i) === pick);
  const lost = e => (e.status === 401 ? onLogout() : setError(e.message));

  useEffect(() => {
    api("/api/meta").then(m => setVars(m.variables)).catch(lost);
    api("/api/surveys/meta").then(list => {
      setItems(list);
      const first = list.find(i => i.geo_levels.includes("lga")) || list[0];
      if (first) { setPick(key(first)); setYear(String(first.years.at(-1))); }
    }).catch(lost);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!item || !year) return;
    setError(""); setFc(null); setCorr(null);
    const q = new URLSearchParams({ indicator: item.indicator, source: item.source, year });
    api(`/api/surveys?${q}`).then(setRows).catch(lost);
    if (item.geo_levels.includes("lga")) {
      api(`/api/surveys/boundaries?${q}`).then(setFc).catch(lost);
      const c = new URLSearchParams(q); c.set("method", method);
      CLIMATE.forEach(v => c.append("variable", v));
      api(`/api/correlations/survey?${c}`).then(setCorr).catch(lost);
    }
  }, [item, year, method]); // eslint-disable-line react-hooks/exhaustive-deps

  const lga = useMemo(() => rows.filter(r => r.geo_level === "lga" && isNum(r.value)).sort((a, b) => b.value - a.value), [rows]);
  const state = rows.filter(r => r.geo_level === "state");
  const view = useMemo(() => mapPaths(fc), [fc]);
  const chosen = corr?.results.find(r => r.variable === cv);
  const fit = chosen?.points.length ? linreg(chosen.points.map(p => p.x), chosen.points.map(p => p.y)) : null;
  const unit = item?.unit || "";
  const lowCount = lga.filter(r => (r.note || "").startsWith("Indicative")).length;

  if (items && !items.length) {
    return (
      <>
        <header><h1>Survey and modelled health indicators</h1></header>
        <main><div className="panel">
          <p>No survey data loaded yet. From the backend folder run one or more of:</p>
          <pre>{`python surveys.py dhs-api
python surveys.py dhs-microdata --kr NGKR8CFL.DTA --ge NGGE8AFL.shp --year 2023
python surveys.py rasters data/surveys/map --source "MAP"`}</pre>
        </div></main>
      </>
    );
  }

  return (
    <>
      <header>
        <h1>Survey and modelled health indicators</h1>
        <p>DHS child health estimates (Ondo as a whole, and by LGA where cluster data are loaded) and modelled surfaces such as the Malaria Atlas Project, shown next to the climate indicators.</p>
      </header>
      {error && <div className="err">{error}</div>}
      {item && (
        <main>
          <aside>
            <label htmlFor="ind">Indicator</label>
            <select id="ind" value={pick} onChange={e => { const i = items.find(x => key(x) === e.target.value); setPick(key(i)); setYear(String(i.years.at(-1))); }}>
              {items.map(i => <option key={key(i)} value={key(i)}>{i.label} [{i.source}]</option>)}
            </select>
            <label htmlFor="yr">Survey year</label>
            <select id="yr" value={year} onChange={e => setYear(e.target.value)}>
              {item.years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            {state.map(s => (
              <div className="kpi" key={s.geo_name} style={{ marginTop: 12 }}>
                <small>{s.geo_name} State</small>
                <strong>{fmt(s.value)}{unit}</strong>
                <em>{isNum(s.ci_low) ? `95% CI ${fmt(s.ci_low)} to ${fmt(s.ci_high)}` : "survey estimate"}{isNum(s.n) ? `, n=${s.n}` : ""}</em>
              </div>
            ))}
            {view && <p className="note">Map: low {fmt(view.lo)} to high {fmt(view.hi)} {unit}</p>}
            <p><strong>{hover ? `${hover.lga}: ${isNum(hover.value) ? fmt(hover.value) + unit : "no data"}${hover.n ? ` (n=${hover.n})` : ""}` : "Hover over an LGA"}</strong></p>
          </aside>
          <div className="col">
            {lga.length === 0 ? (
              <section className="panel"><p>This indicator has a state estimate only. LGA values need the cluster-level or raster loaders (see the command list in the project notes).</p></section>
            ) : (
              <>
                {lowCount > 0 && <div className="err">{lowCount} of {lga.length} LGAs have few survey clusters or children. Treat those values as indicative; the table shows n for each.</div>}
                <div className="two">
                  <section className="panel">
                    <h2>Map by LGA</h2>
                    {view && (
                      <svg viewBox={`0 0 ${view.w} ${view.h}`} role="img" aria-label="Map of the indicator by LGA" style={{ width: "100%", maxHeight: "55vh" }}>
                        {view.paths.map(p => (
                          <path key={p.lga} d={p.d} fill={p.fill} stroke="#14202b" strokeWidth="1" vectorEffect="non-scaling-stroke"
                            onMouseEnter={() => setHover(p)} onMouseLeave={() => setHover(null)} />
                        ))}
                      </svg>
                    )}
                  </section>
                  <section className="panel">
                    <h2>Ranking</h2>
                    <div className="chart">
                      <ResponsiveContainer>
                        <BarChart data={lga}>
                          <CartesianGrid stroke="#e4eaee" /><XAxis dataKey="geo_name" interval={0} angle={-35} textAnchor="end" height={80} fontSize={11} /><YAxis /><Tooltip />
                          <Bar dataKey="value" fill="#0f766e" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </section>
                </div>
                <section className="panel">
                  <div className="panel-head">
                    <h2>Does the health indicator line up with climate across LGAs?</h2>
                    <div className="seg" role="group" aria-label="Method">
                      {[["pearson", "Pearson"], ["spearman", "Spearman"]].map(([v, t]) => (
                        <button key={v} type="button" className={v === method ? "on" : ""} aria-pressed={v === method} onClick={() => setMethod(v)}>{t}</button>
                      ))}
                    </div>
                  </div>
                  {corr && (
                    <>
                      <p className="note">Average climate {corr.start} to {corr.end} against the {year} values, {corr.n_lgas} LGAs. {corr.note}</p>
                      <div className="tbl">
                        <table>
                          <thead><tr><th>Climate indicator</th><th>r</th><th>p</th><th>LGAs</th><th>Plot</th></tr></thead>
                          <tbody>
                            {corr.results.map(r => (
                              <tr key={r.variable}>
                                <td>{vars[r.variable] ?? r.label}</td><td>{isNum(r.r) ? r.r.toFixed(2) : "–"}</td><td>{r.p ?? "–"}</td><td>{r.n}</td>
                                <td><input type="radio" name="cv" aria-label={`Plot ${r.label}`} checked={cv === r.variable} onChange={() => setCv(r.variable)} /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {chosen?.points.length > 0 && (
                        <div className="chart">
                          <ResponsiveContainer>
                            <ScatterChart margin={{ left: 8, right: 16, top: 8 }}>
                              <CartesianGrid stroke="#e4eaee" />
                              <XAxis type="number" dataKey="x" name={vars[cv]} domain={["auto", "auto"]} tickFormatter={fmt} />
                              <YAxis type="number" dataKey="y" name={item.label} domain={["auto", "auto"]} />
                              <Tooltip cursor={{ strokeDasharray: "3 3" }} formatter={(v) => fmt(v)} labelFormatter={() => ""} />
                              <Scatter data={chosen.points} fill="#0f766e" />
                            </ScatterChart>
                          </ResponsiveContainer>
                        </div>
                      )}
                      {fit && <p className="note">Fitted line: {item.label} changes by {fmt(fit.slope)} per unit of {vars[cv]} (r={fmt(fit.r)}, n={fit.n}).</p>}
                    </>
                  )}
                </section>
                <section className="panel">
                  <h2>Values</h2>
                  <div className="tbl">
                    <table>
                      <thead><tr><th>LGA</th><th>Value</th><th>Children / cells (n)</th><th>Clusters</th><th>Note</th></tr></thead>
                      <tbody>
                        {lga.map(r => (
                          <tr key={r.geo_name}><td>{r.geo_name}</td><td>{fmt(r.value)}{unit}</td><td>{r.n ?? ""}</td><td>{r.n_clusters ?? ""}</td><td>{r.note}</td></tr>
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
