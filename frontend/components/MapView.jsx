"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { fmt, healthNote, isNum, mean, shortLabel, signed, tone, unitOf } from "../lib/analytics";
import { mapPaths } from "../lib/geo";
import { Interpret, Kpi } from "./Shared";

export default function MapView({ onLogout }) {
  const [vars, setVars] = useState({});
  const [v, setV] = useState("rain_mm");
  const [fc, setFc] = useState(null);
  const [hover, setHover] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const lost = e => (e.status === 401 ? onLogout() : setError("Could not load the map."));
    api("/api/meta").then(m => setVars(m.variables)).catch(lost);
    api(`/api/boundaries?variable=${v}`).then(setFc).catch(lost);
  }, [v, onLogout]);

  const view = useMemo(() => mapPaths(fc), [fc]);
  const label = vars[v] || v, unit = unitOf(label);

  // State summary from the LGA values on the map.
  const sum = useMemo(() => {
    if (!view) return null;
    const list = view.paths.filter(p => isNum(p.value)).sort((a, b) => b.value - a.value);
    if (!list.length) return null;
    const avg = mean(list.map(p => p.value)), hi = list[0], lo = list[list.length - 1];
    return { list, avg, hi, lo, spread: hi.value - lo.value, above: list.filter(p => p.value > avg).length };
  }, [view]);

  const pct = sum && sum.avg ? (sum.spread / Math.abs(sum.avg)) * 100 : null;

  return (
    <div className="map">
      <aside>
        <label htmlFor="mv">Indicator</label>
        <select id="mv" value={v} onChange={e => setV(e.target.value)}>
          {Object.entries(vars).map(([k, name]) => <option key={k} value={k}>{name}</option>)}
        </select>
        {view && <p>Low {fmt(view.lo)} to high {fmt(view.hi)} (average monthly value over all months loaded)</p>}
        <p><strong>{hover ? `${hover.lga}: ${isNum(hover.value) ? fmt(hover.value) : "no data"}${isNum(hover.value) && sum ? ` (${signed(hover.value - sum.avg)} vs state)` : ""}` : "Hover over an LGA"}</strong></p>
      </aside>
      <div className="col">
        {error && <p className="err">{error}</p>}
        {fc && !view && <section className="panel"><p>No boundaries loaded. Run: python manage.py load-boundaries</p></section>}
        {sum && (
          <section aria-label="Ondo State key figures">
            <h3 className="sec"><span className="badge">Ondo State</span> {shortLabel(label)} across LGAs</h3>
            <div className="kpis" style={{ marginTop: 8 }}>
              <Kpi hl label="State average" value={fmt(sum.avg)} sub={`${unit} · mean of ${sum.list.length} LGAs`} />
              <Kpi label="Highest LGA" value={sum.hi.lga} sub={fmt(sum.hi.value)} />
              <Kpi label="Lowest LGA" value={sum.lo.lga} sub={fmt(sum.lo.value)} />
              <Kpi label="Gap between LGAs" value={fmt(sum.spread)} sub={pct == null ? "highest minus lowest" : `${pct.toFixed(0)}% of the state average`} />
              <Kpi label="LGAs above average" value={`${sum.above} of ${sum.list.length}`} sub={`${sum.list.length - sum.above} at or below`} />
            </div>
          </section>
        )}
        {view && (
          <div className="two">
            <section className="panel">
              <h2>Map of {shortLabel(label)} by LGA</h2>
              <svg viewBox={`0 0 ${view.w} ${view.h}`} role="img" aria-label="Map of Ondo State LGAs" style={{ width: "100%", maxHeight: "70vh" }}>
                {view.paths.map(p => (
                  <path key={p.lga} d={p.d} fill={p.fill} stroke="#14202b" strokeWidth="1" vectorEffect="non-scaling-stroke"
                    onMouseEnter={() => setHover(p)} onMouseLeave={() => setHover(null)} />
                ))}
              </svg>
              <div className="legend"><span>{fmt(view.lo)}</span><i style={{ background: "linear-gradient(90deg,rgb(226,240,238),rgb(15,118,123))" }} /><span>{fmt(view.hi)}</span></div>
            </section>
            {sum && (
              <section className="panel">
                <h2>LGA ranking</h2>
                <div className="tbl tall">
                  <table>
                    <thead><tr><th>Rank</th><th>LGA</th><th>Value</th><th>Vs state</th></tr></thead>
                    <tbody>
                      {sum.list.map((p, i) => (
                        <tr key={p.lga} onMouseEnter={() => setHover(p)} onMouseLeave={() => setHover(null)}>
                          <td>{i + 1}</td><td>{p.lga}</td><td>{fmt(p.value)}</td><td className={tone(p.value - sum.avg)}>{signed(p.value - sum.avg)}</td>
                        </tr>
                      ))}
                      <tr style={{ fontWeight: 700 }}><td /><td>Ondo State</td><td>{fmt(sum.avg)}</td><td /></tr>
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
        )}
        {sum && (
          <Interpret title="Map: what it shows" items={[
            `Darker LGAs have higher average monthly ${shortLabel(label).toLowerCase()}. The state average is ${fmt(sum.avg)} ${unit}; ${sum.hi.lga} is highest (${fmt(sum.hi.value)}) and ${sum.lo.lga} lowest (${fmt(sum.lo.value)}).`,
            pct != null && (pct < 5 ? "The colours span a narrow range, so LGAs are climatically very similar on this indicator." : pct > 15 ? "The gap is large, so LGAs are clearly different on this indicator." : "LGAs differ moderately on this indicator."),
            `${sum.above} of ${sum.list.length} LGAs are above the state average.`,
            healthNote(v),
          ]} foot="Colours are scaled from the lowest to the highest LGA, so a dark LGA is high relative to the others, not necessarily high in absolute terms." />
        )}
      </div>
    </div>
  );
}
