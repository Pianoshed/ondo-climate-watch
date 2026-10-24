"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";
import { corrSentence, fmt, isNum, linreg, mean, pNum as pn, shortLabel, signed, tone } from "../lib/analytics";
import { Interpret, Kpi } from "./Shared";
import { mapPaths } from "../lib/geo";

const CLIMATE = ["rain_mm", "t2m", "t2m_max", "rh2m"];
const ORIGIN_SEP = " | Origin: ";
const PUBLISHERS = {
  "DHS API": ["The DHS Program", "https://api.dhsprogram.com/"],
  "DHS microdata": ["The DHS Program (NDHS microdata)", "https://dhsprogram.com/data/"],
  MAP: ["Malaria Atlas Project", "https://data.malariaatlas.org"],
  "IHME LBD": ["IHME Local Burden of Disease", "https://ghdx.healthdata.org"],
};
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
  const u = item?.unit || "";
  const unit = u === "%" ? "%" : u ? ` ${u}` : ""; // "%" sticks to the number, words like "per 1,000" get a space
  const stv = state.find(s => isNum(s.value));
  const lavg = lga.length ? mean(lga.map(r => r.value)) : null;
  const refv = stv ? stv.value : lavg; // official state estimate if loaded, else the mean of the LGAs
  const hiL = lga[0], loL = lga[lga.length - 1];
  const aboveN = refv == null ? 0 : lga.filter(r => r.value > refv).length;
  const lowCount = lga.filter(r => (r.note || "").startsWith("Indicative")).length;

  if (items && !items.length) {
    return (
      <>
        <header><h1>Survey and modelled health indicators</h1></header>
        <main><div className="panel">
          <p>No survey data loaded yet. From the backend folder run one or more of:</p>
          <pre>{`python surveys.py all`}</pre>
          <p>This loads the DHS API and Malaria Atlas Project data automatically, and the NDHS cluster data if NGKR*.DTA and NGGE*.shp are in data/surveys/.</p>
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
            <p className="note">Source: {item.source}{item.source === "MAP" ? ". Modelled surface from the Malaria Atlas Project (CC BY 3.0), not a survey." : ""}</p>
            {view && <p className="note">Map: low {fmt(view.lo)} to high {fmt(view.hi)} {unit}</p>}
            <p><strong>{hover ? `${hover.lga}: ${isNum(hover.value) ? fmt(hover.value) + unit : "no data"}${hover.n ? ` (n=${hover.n})` : ""}` : "Hover over an LGA"}</strong></p>
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>Origin of this data</summary>
              <p className="note" style={{ margin: "6px 0" }}>
                Publisher: {PUBLISHERS[item.source]?.[0] ?? "user-supplied data"}
                {PUBLISHERS[item.source] && <> (<a href={PUBLISHERS[item.source][1]} target="_blank" rel="noreferrer">website</a>)</>}
              </p>
              <p className="note" style={{ margin: "6px 0", wordBreak: "break-word" }}>{(rows[0]?.note || "").split(ORIGIN_SEP)[1] || "No origin recorded. Reload this data with the latest surveys.py to add it."}</p>
            </details>
            <label>Download data</label>
            <p style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "4px 0" }}>
              <a className="btn" href={`/api/surveys/export.csv?${new URLSearchParams({ indicator: item.indicator, source: item.source })}`}>This indicator, CSV</a>
              <a className="btn" href={`/api/surveys/export.xlsx?${new URLSearchParams({ indicator: item.indicator, source: item.source })}`}>This indicator, Excel</a>
              <a className="btn" href="/api/surveys/export.csv">All indicators, CSV</a>
              <a className="btn" href="/api/surveys/export.xlsx">All indicators, Excel</a>
            </p>
            <Help item={item} unit={unit} method={method} chosen={chosen} corr={corr} vars={vars} cv={cv} lowCount={lowCount} nLga={lga.length} />
          </aside>
          <div className="col">
            {lga.length === 0 ? (
              <section className="panel"><p>This indicator has a state estimate only. LGA values need the cluster-level or raster loaders (see the command list in the project notes).</p></section>
            ) : (
              <>
                <section aria-label="Ondo State key figures">
                  <h3 className="sec"><span className="badge">Ondo State</span> {item.label}, {year}</h3>
                  <div className="kpis" style={{ marginTop: 8 }}>
                    <Kpi hl label={stv ? "State estimate" : "Mean of LGAs"} value={`${fmt(refv)}${unit}`} sub={stv ? (isNum(stv.ci_low) ? `95% CI ${fmt(stv.ci_low)} to ${fmt(stv.ci_high)}` : "survey estimate") : `${lga.length} LGAs, no state-level figure loaded`} />
                    <Kpi label="Highest LGA" value={hiL.geo_name} sub={`${fmt(hiL.value)}${unit}`} />
                    <Kpi label="Lowest LGA" value={loL.geo_name} sub={`${fmt(loL.value)}${unit}`} />
                    <Kpi label="Gap between LGAs" value={`${fmt(hiL.value - loL.value)}${unit}`} sub="highest minus lowest" />
                    <Kpi label="LGAs above state" value={`${aboveN} of ${lga.length}`} sub={`${lga.length - aboveN} at or below`} />
                    <Kpi label="Thin-data LGAs" value={`${lowCount} of ${lga.length}`} sub="few clusters or children" />
                  </div>
                </section>
                <Interpret title="Survey indicator: what it shows" items={[
                  `${item.label} for Ondo State is ${fmt(refv)}${unit} (${stv ? `${item.source} state estimate` : "mean of the LGA values"}). ${hiL.geo_name} is highest at ${fmt(hiL.value)}${unit} and ${loL.geo_name} lowest at ${fmt(loL.value)}${unit}.`,
                  `${aboveN} of ${lga.length} LGAs are above the state figure. Use the state figure for headline numbers and the LGAs to decide where to look closer.`,
                  lowCount > 0 ? `${lowCount} LGA values rest on few children or clusters, so quote them as indicative.` : null,
                  item.source === "MAP" ? "These are modelled values, not a survey count." : null,
                ]} />
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
                      {chosen && isNum(chosen.r) && <Interpret title="Climate link: what it says" items={[
                        corrSentence(shortLabel(vars[cv] ?? chosen.label ?? "Climate"), item.label, chosen.r, pn(chosen.p), corr.n_lgas),
                        "This compares LGAs with each other (places with more of one tend to have more of the other). It does not show that climate causes the health outcome.",
                      ]} />}
                      {fit && <p className="note">Fitted line: {item.label} changes by {fmt(fit.slope)} per unit of {vars[cv]} (r={fmt(fit.r)}, n={fit.n}).</p>}
                    </>
                  )}
                </section>
                <section className="panel">
                  <h2>Values</h2>
                  <div className="tbl">
                    <table>
                      <thead><tr><th>LGA</th><th>Value</th><th>Vs state</th><th>Children / cells (n)</th><th>Clusters</th><th>Note</th></tr></thead>
                      <tbody>
                        {lga.map(r => (
                          <tr key={r.geo_name}><td>{r.geo_name}</td><td>{fmt(r.value)}{unit}</td><td className={tone(refv == null ? 0 : r.value - refv)}>{refv == null ? "–" : signed(r.value - refv)}</td><td>{r.n ?? ""}</td><td>{r.n_clusters ?? ""}</td><td>{(r.note || "").split(ORIGIN_SEP)[0]}</td></tr>
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

const pNum = p => (typeof p === "string" ? (p.trim().startsWith("<") ? 0.0005 : parseFloat(p)) : Number(p));
const strength = r => (Math.abs(r) < 0.3 ? "weak" : Math.abs(r) < 0.6 ? "moderate" : "strong");

function Help({ item, unit, method, chosen, corr, vars, cv, lowCount, nLga }) {
  const r = chosen && isNum(chosen.r) ? chosen.r : null;
  const p = chosen ? pNum(chosen.p) : NaN;
  const sig = Number.isFinite(p) && p < 0.05;
  const climate = (vars[cv] ?? chosen?.label ?? "climate").toLowerCase();
  const small = { fontSize: 13, margin: "6px 0", lineHeight: 1.45 };
  const flags = [];
  if (item?.source === "MAP") flags.push("These values are computer model estimates, and the models already use rainfall and temperature. A link with climate here can be partly built in, so do not treat it as independent proof.");
  if (lowCount > 0) flags.push(`${lowCount} of ${nLga} LGAs rest on very few children or survey clusters. Their values can swing a lot.`);
  if (corr && corr.n_lgas < 12) flags.push(`Only ${corr.n_lgas} LGAs have data, so one unusual LGA can change the result.`);
  if (r !== null && !sig) flags.push("The p value is not below 0.05, so this pattern could easily be chance.");
  if (r !== null && Math.abs(r) >= 0.6 && corr && corr.n_lgas < 12) flags.push("A strong r from a small number of LGAs is often driven by one or two points. Check the scatter plot.");
  flags.push("Four climate indicators are tested at once. Out of several tests, one can look significant by luck alone.");
  flags.push("It is a comparison between LGAs. It does not show that climate causes the health outcome.");
  return (
    <details open style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
      <summary style={{ fontWeight: 600, cursor: "pointer" }}>How to read this page</summary>

      <p style={small}><strong>What a correlation tells you.</strong> It checks whether LGAs with more of one thing also tend to have more (or less) of another. It describes a pattern, nothing more.</p>
      <p style={small}><strong>r</strong> runs from -1 to +1. Near 0 means no clear pattern. Below 0.3 is weak, 0.3 to 0.6 moderate, above 0.6 strong. A minus sign means one goes up as the other goes down.</p>
      <p style={small}><strong>p</strong> is the chance of seeing a pattern this strong by luck alone. Below 0.05 means unlikely to be luck. With few LGAs, only a big r can reach that.</p>
      <p style={small}><strong>Pearson or Spearman?</strong> Pearson looks for a straight-line pattern. Spearman compares rankings and copes better with unusual values.</p>

      {r !== null && (
        <div style={{ background: "var(--bg, #f4f7f9)", border: "1px solid var(--line)", borderRadius: 6, padding: 8, margin: "8px 0" }}>
          <strong style={{ fontSize: 13 }}>Your current result</strong>
          <p style={small}>
            {Math.abs(r) < 0.1
              ? `Across ${corr.n_lgas} LGAs there is almost no link between ${climate} and ${item.label.toLowerCase()}.`
              : `Across ${corr.n_lgas} LGAs, those with ${r > 0 ? "higher" : "lower"} ${climate} tend to have ${r > 0 ? "higher" : "lower"} values here. The link is ${strength(r)} (r = ${r.toFixed(2)}).`}
            {" "}{sig ? "It is unlikely to be chance, but that still does not prove cause." : "It is not strong enough to rule out chance."}
          </p>
        </div>
      )}

      <p style={{ ...small, fontWeight: 600 }}>Do</p>
      <ul style={{ ...small, paddingLeft: 18 }}>
        <li>Use the state figure for headline numbers.</li>
        <li>Use LGA values and correlations to decide where to look closer.</li>
        <li>Look at the scatter plot, not only r and p.</li>
        <li>Check n and the Note column before quoting an LGA.</li>
        <li>Name the source and say if it is a survey or a model.</li>
      </ul>

      <p style={{ ...small, fontWeight: 600 }}>Watch out for</p>
      <ul style={{ ...small, paddingLeft: 18 }}>
        {flags.map(f => <li key={f}>{f}</li>)}
        {item?.source === "DHS microdata" && <li>Survey GPS points are deliberately shifted by up to 2 km (urban) or 5 km (rural), so a cluster can land in the wrong neighbouring LGA.</li>}
        <li>Climate is averaged over the window shown, while the survey asks about the past 2 weeks. The timing only roughly matches.</li>
      </ul>
    </details>
  );
}
