"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip, XAxis, YAxis, BarChart } from "recharts";
import { fmt, isNum, linreg, mean, signed, tone } from "../lib/analytics";
import { mapPaths } from "../lib/geo";
import { Interpret, Kpi, Seg } from "./Shared";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const STATE = "Ondo State";
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const GROUPS = {
  flood: { title: "Floods", rgb: [29, 78, 216], seasonal: "heavy_days_50mm",
    note: "This is a rainfall-based flood indicator, not a map of flooded land. It shows where and when the rain that causes floods is heaviest. Local flooding also depends on drainage, terrain and river levels." },
  heat: { title: "Heat waves", rgb: [190, 18, 60], seasonal: "heatwave_days",
    note: "A heat wave here is 3 or more days in a row above the LGA's own 90th percentile of daily maximum temperature for that time of year. It measures unusual heat for the place, so it does not include humidity." },
  wind: { title: "Wind", rgb: [109, 40, 217], seasonal: "gust_days_ge14",
    note: "Values come from ERA5 reanalysis, a grid of about 25 km. It captures regional wind well but underestimates short local storm squalls, so real gusts at a site can be stronger." },
};
const ramp = (rgb, t) => `rgb(${rgb.map((c, i) => Math.round([236, 242, 246][i] + (c - [236, 242, 246][i]) * t)).join(",")})`;
const SEASON = [["all", "Whole year"], ["rainy", "Rainy (Apr–Oct)"], ["dry", "Dry (Nov–Mar)"]];

export default function Hazards({ onLogout }) {
  const [data, setData] = useState(null);
  const [missing, setMissing] = useState(false);
  const [fc, setFc] = useState(null);
  const [tab, setTab] = useState("flood");
  const [metric, setMetric] = useState("");
  const [period, setPeriod] = useState("avg");
  const [lga, setLga] = useState(STATE);
  const [season, setSeason] = useState("all");
  const [hover, setHover] = useState(null);

  useEffect(() => {
    const lost = e => (e.status === 401 ? onLogout() : null);
    api("/api/hazards").then(setData).catch(e => (e.status === 404 ? setMissing(true) : lost(e) ?? setMissing(true)));
    api("/api/boundaries?variable=rain_mm").then(setFc).catch(lost);
  }, [onLogout]);

  const g = GROUPS[tab];
  const keys = useMemo(() => (data ? Object.keys(data.metrics).filter(k => data.metrics[k].group === tab) : []), [data, tab]);
  const m = keys.includes(metric) ? metric : keys[0];
  const info = data?.metrics[m];
  const unit = info?.unit || "";
  const names = useMemo(() => (data ? Object.keys(data.lgas) : []), [data]);

  const pick = arr => {
    if (period === "avg") return mean(arr);
    if (period === "last10") return mean(arr.slice(-10));
    const i = data.years.indexOf(+period);
    return i < 0 ? null : arr[i];
  };
  const periodLabel = !data ? "" : period === "avg" ? `average of ${data.years[0]}–${data.years.at(-1)}` : period === "last10" ? `average of the last 10 years` : period;

  const rows = useMemo(() => {
    if (!data || !m) return [];
    return names.map(n => ({ lga: n, value: pick(data.lgas[n].yearly[m]) })).filter(r => isNum(r.value)).sort((a, b) => b.value - a.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, m, period, names]);
  const avg = mean(rows.map(r => r.value));
  const hi = rows[0], lo = rows.at(-1);
  const above = rows.filter(r => r.value > avg).length;

  // Map: geometry from the API, values from the crawl (names matched ignoring case and punctuation).
  const view = useMemo(() => {
    if (!fc || !rows.length) return null;
    const val = Object.fromEntries(rows.map(r => [norm(r.lga), r.value]));
    const out = mapPaths({ ...fc, features: fc.features.map(f => ({ ...f, properties: { ...f.properties, value: val[norm(f.properties.lga)] ?? null } })) });
    if (!out) return null;
    const span = out.hi - out.lo || 1;
    return { ...out, paths: out.paths.map(p => ({ ...p, fill: isNum(p.value) ? ramp(g.rgb, (p.value - out.lo) / span) : "#e4eaee" })) };
  }, [fc, rows, g]);
  const unmatched = fc && rows.length ? fc.features.filter(f => !rows.some(r => norm(r.lga) === norm(f.properties.lga))).map(f => f.properties.lga) : [];

  const series = useMemo(() => {
    if (!data || !m) return [];
    return data.years.map((y, i) => ({
      year: y,
      state: mean(names.map(n => data.lgas[n].yearly[m][i])),
      lga: lga === STATE ? null : data.lgas[lga]?.yearly[m][i],
    }));
  }, [data, m, names, lga]);
  const fit = series.length >= 5 ? linreg(series.map(s => s.year), series.map(s => s.state)) : null;
  const data2 = series.map(s => ({ ...s, trend: fit ? fit.intercept + fit.slope * s.year : null }));
  const perDecade = fit ? fit.slope * 10 : null;
  const worst = series.length ? series.reduce((a, b) => (isNum(b.state) && b.state > (a.state ?? -Infinity) ? b : a)) : null;
  const latest = series.at(-1);

  const sk = g.seasonal, seasonal = data ? (lga === STATE ? data.state_seasonal[sk] : data.lgas[lga]?.seasonal[sk]) : null;
  const seasData = seasonal ? seasonal.map((v, i) => ({ name: MONTHS[i], value: v })) : [];
  const peakM = seasData.filter(d => isNum(d.value)).sort((a, b) => b.value - a.value)[0];
  const rose = data ? (lga === STATE ? data.state_windrose : data.lgas[lga]?.windrose) : null;
  const roseData = rose ? data.sectors.map((s, i) => ({ s, freq: rose[season].freq[i], speed: rose[season].speed[i] })) : [];
  const topDir = roseData.length ? roseData.reduce((a, b) => (b.freq > a.freq ? b : a)) : null;
  const dirName = { N: "north", NE: "north-east", E: "east", SE: "south-east", S: "south", SW: "south-west", W: "west", NW: "north-west" };

  if (missing) {
    return (
      <>
        <header><h1>Floods, heat waves and wind</h1></header>
        <main style={{ display: "block" }}>
          <div className="panel">
            <p>The hazard data has not been created yet. From the project folder run:</p>
            <p>In the backend folder run:</p>
            <pre>python hazards.py</pre>
            <p>It downloads daily ERA5 weather for every LGA (about 15 to 25 minutes the first time, seconds after that) and saves the indicators in the database. Reload this page afterwards.</p>
          </div>
        </main>
      </>
    );
  }

  const trendText = !isNum(perDecade) ? null
    : Math.abs(perDecade) < Math.abs(avg) * 0.02 ? `Across the record the state-wide level shows no clear change (${signed(perDecade)} ${unit} per decade).`
      : `Across the record the state-wide level is ${perDecade > 0 ? "rising" : "falling"} by about ${fmt(Math.abs(perDecade))} ${unit} per decade (straight-line fit, not a significance test).`;

  return (
    <>
      <header>
        <h1>Floods, heat waves and wind: Ondo State</h1>
        <p>Where the hazard is highest across the 18 LGAs, how it changes year to year, and when in the year it peaks. {data && `ERA5 daily data, ${data.years[0]} to ${data.years.at(-1)}.`}</p>
      </header>
      {data && (
        <main>
          <aside>
            <label>Hazard</label>
            <Seg label="Hazard" value={tab} onChange={t => { setTab(t); setMetric(""); }} options={Object.entries(GROUPS).map(([k, v]) => [k, v.title])} />
            <label htmlFor="hm">Indicator</label>
            <select id="hm" value={m} onChange={e => setMetric(e.target.value)}>{keys.map(k => <option key={k} value={k}>{data.metrics[k].label}</option>)}</select>
            <p className="note">{info?.desc}</p>
            <label htmlFor="hp">Period</label>
            <select id="hp" value={period} onChange={e => setPeriod(e.target.value)}>
              <option value="avg">Average of all years</option>
              <option value="last10">Average of last 10 years</option>
              {[...data.years].reverse().map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <label htmlFor="hl">Area for the charts</label>
            <select id="hl" value={lga} onChange={e => setLga(e.target.value)}>
              {[STATE, ...names].map(n => <option key={n}>{n}</option>)}
            </select>
            <p className="note">{g.note}</p>
            <p className="note">Source: {data.source}{data.last_day ? ` Data to ${data.last_day}.` : ""}</p>
            <a className="btn" href="/api/hazards/export.csv">Download CSV</a>
            <p><strong>{hover ? `${hover.lga}: ${isNum(hover.value) ? fmt(hover.value) + " " + unit : "no data"}${isNum(hover.value) ? ` (${signed(hover.value - avg)} vs state)` : ""}` : "Hover over an LGA"}</strong></p>
          </aside>

          <div className="col">
            {rows.length > 0 && (
              <section aria-label="Ondo State key figures">
                <h3 className="sec"><span className="badge">Ondo State</span> {info.label}, {periodLabel}</h3>
                <div className="kpis" style={{ marginTop: 8 }}>
                  <Kpi hl label="State average" value={fmt(avg)} sub={`${unit} · mean of ${rows.length} LGAs`} />
                  <Kpi label="Highest LGA" value={hi.lga} sub={`${fmt(hi.value)} ${unit}`} />
                  <Kpi label="Lowest LGA" value={lo.lga} sub={`${fmt(lo.value)} ${unit}`} />
                  <Kpi label="LGAs above state average" value={`${above} of ${rows.length}`} sub={`${rows.length - above} at or below`} />
                  <Kpi label="Trend per decade" value={signed(perDecade)} sub={perDecade == null ? "needs 5+ years" : `${unit} · state-wide`} tone={tone(perDecade)} />
                  <Kpi label="Worst year (state)" value={worst ? String(worst.year) : "–"} sub={worst ? `${fmt(worst.state)} ${unit}` : ""} />
                  <Kpi label={`Latest year (${latest?.year})`} value={fmt(latest?.state)} sub={isNum(latest?.state) && isNum(mean(series.map(s => s.state))) ? `${signed(latest.state - mean(series.map(s => s.state)))} vs all-year average` : ""} tone={tone(isNum(latest?.state) ? latest.state - mean(series.map(s => s.state)) : 0)} />
                </div>
              </section>
            )}

            <div className="two">
              <section className="panel">
                <h2>{info?.label} by LGA</h2>
                {view ? (
                  <>
                    <svg viewBox={`0 0 ${view.w} ${view.h}`} role="img" aria-label={`Map of ${info.label}`} style={{ width: "100%", maxHeight: "62vh" }}>
                      {view.paths.map(p => (
                        <path key={p.lga} d={p.d} fill={p.fill} stroke="#14202b" strokeWidth="1" vectorEffect="non-scaling-stroke"
                          onMouseEnter={() => setHover(p)} onMouseLeave={() => setHover(null)} />
                      ))}
                    </svg>
                    <div className="legend"><span>{fmt(view.lo)}</span><i style={{ background: `linear-gradient(90deg,${ramp(g.rgb, 0)},${ramp(g.rgb, 1)})` }} /><span>{fmt(view.hi)} {unit}</span></div>
                    {unmatched.length > 0 && <p className="note">No hazard data matched these map areas (name mismatch): {unmatched.join(", ")}.</p>}
                  </>
                ) : <p>Loading map…</p>}
              </section>
              <section className="panel">
                <h2>LGA ranking</h2>
                <div className="tbl tall">
                  <table>
                    <thead><tr><th>Rank</th><th>LGA</th><th>Value</th><th>Vs state</th></tr></thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={r.lga} onMouseEnter={() => setHover(r)} onMouseLeave={() => setHover(null)}>
                          <td>{i + 1}</td><td>{r.lga}</td><td>{fmt(r.value)}</td><td className={tone(r.value - avg)}>{signed(r.value - avg)}</td>
                        </tr>
                      ))}
                      <tr style={{ fontWeight: 700 }}><td /><td>{STATE}</td><td>{fmt(avg)}</td><td /></tr>
                    </tbody>
                  </table>
                </div>
              </section>
            </div>

            <section className="panel">
              <h2>{info?.label} year by year{lga === STATE ? "" : `: ${lga} against the state`}</h2>
              <div className="chart tall">
                <ResponsiveContainer>
                  <ComposedChart data={data2}>
                    <CartesianGrid stroke="#e4eaee" /><XAxis dataKey="year" minTickGap={20} /><YAxis tickFormatter={v => fmt(v)} width={56} /><Tooltip formatter={v => fmt(v)} /><Legend />
                    <Bar dataKey="state" name="Ondo State (mean of LGAs)" fill={ramp(g.rgb, 1)} fillOpacity={0.55} isAnimationActive={false} />
                    {lga !== STATE && <Line dataKey="lga" name={lga} stroke="#14202b" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />}
                    {fit && <Line dataKey="trend" name="State trend" stroke="#b45309" strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} />}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </section>

            <div className="two">
              <section className="panel">
                <h2>When in the year: {data.metrics[sk].label.toLowerCase()}</h2>
                <div className="chart">
                  <ResponsiveContainer>
                    <BarChart data={seasData}>
                      <CartesianGrid stroke="#e4eaee" vertical={false} /><XAxis dataKey="name" /><YAxis tickFormatter={v => fmt(v)} width={48} /><Tooltip formatter={v => `${fmt(v)} days`} />
                      <Bar dataKey="value" name="Average days per month" fill={ramp(g.rgb, 1)} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <p className="note">Average number of days per month, for {lga}.</p>
              </section>
              {tab === "wind" && (
                <section className="panel">
                  <div className="panel-head"><h2>Wind rose: {lga}</h2><Seg label="Season" value={season} onChange={setSeason} options={SEASON} /></div>
                  <div className="chart">
                    <ResponsiveContainer>
                      <RadarChart data={roseData} outerRadius="75%">
                        <PolarGrid /><PolarAngleAxis dataKey="s" /><PolarRadiusAxis tickFormatter={v => `${Math.round(v)}%`} />
                        <Tooltip formatter={(v, n, p) => [`${fmt(v)}% of days, average ${fmt(p.payload.speed)} m/s`, "Wind from here"]} />
                        <Radar dataKey="freq" stroke={ramp(g.rgb, 1)} fill={ramp(g.rgb, 1)} fillOpacity={0.4} isAnimationActive={false} />
                      </RadarChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="note">Each spoke shows how often the wind blows FROM that direction.</p>
                </section>
              )}
            </div>

            <Interpret title={`${g.title}: what it shows`} items={[
              rows.length && `${info.label} for Ondo State (${periodLabel}) is ${fmt(avg)} ${unit}. ${hi.lga} is highest (${fmt(hi.value)}) and ${lo.lga} lowest (${fmt(lo.value)}); ${above} of ${rows.length} LGAs are above the state average.`,
              rows.length && hi.value > 0 && lo.value >= 0 && hi.value / Math.max(lo.value, 1e-9) > 1.5 ? "The highest LGA has at least 1.5 times the level of the lowest, so the hazard is clearly uneven across the state." : null,
              trendText,
              worst && isNum(worst.state) && `The worst year for the state as a whole was ${worst.year} (${fmt(worst.state)} ${unit}).`,
              peakM && peakM.value > 0 && `${lga} sees most ${data.metrics[sk].label.toLowerCase()} in ${peakM.name} (${fmt(peakM.value)} days a month on average).`,
              tab === "wind" && topDir && `In ${lga} the wind most often blows from the ${dirName[topDir.s]} (${fmt(topDir.freq)}% of days, ${season === "all" ? "whole year" : season === "rainy" ? "rainy season" : "dry season"}). Expect the dry-season wind to lean north-east (harmattan) and the rainy-season wind south-west.`,
              tab === "flood" && "Heavy rain days cluster in the rainy season. Compare the map with where rivers and low ground are, since the same rain floods some places far more than others.",
              tab === "heat" && "Heat waves matter most for outdoor workers, older people, young children and people with heart or kidney disease. More heat-wave days in recent years points to rising heat stress.",
            ]} foot={g.note} />
          </div>
        </main>
      )}
    </>
  );
}
