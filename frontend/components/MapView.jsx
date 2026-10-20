"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

const rings = g => (g.type === "Polygon" ? [g.coordinates] : g.coordinates).flat();
const shade = t => `rgb(${Math.round(226 - 211 * t)},${Math.round(240 - 122 * t)},${Math.round(238 - 123 * t)})`;

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

  const view = useMemo(() => {
    if (!fc || !fc.features.length) return null;
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const f of fc.features) for (const ring of rings(f.geometry)) for (const [x, y] of ring) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const vals = fc.features.map(f => f.properties.value).filter(x => x != null);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const paths = fc.features.map(f => ({
      lga: f.properties.lga, value: f.properties.value,
      fill: f.properties.value == null ? "#e4eaee" : shade(hi === lo ? 0.5 : (f.properties.value - lo) / (hi - lo)),
      d: rings(f.geometry).map(r => "M" + r.map(([x, y]) => `${(x - x0).toFixed(4)},${(y1 - y).toFixed(4)}`).join("L") + "Z").join(""),
    }));
    return { w: x1 - x0, h: y1 - y0, lo, hi, paths };
  }, [fc]);

  return (
    <div className="map">
      <aside>
        <label htmlFor="mv">Indicator</label>
        <select id="mv" value={v} onChange={e => setV(e.target.value)}>
          {Object.entries(vars).map(([k, name]) => <option key={k} value={k}>{name}</option>)}
        </select>
        {view && <p>Low {view.lo} to high {view.hi} (average over all months loaded)</p>}
        <p><strong>{hover ? `${hover.lga}: ${hover.value ?? "no data"}` : "Hover over an LGA"}</strong></p>
      </aside>
      <section className="panel">
        {error && <p className="err">{error}</p>}
        {fc && !view && <p>No boundaries loaded. Run: python manage.py load-boundaries</p>}
        {view && (
          <svg viewBox={`0 0 ${view.w} ${view.h}`} role="img" aria-label="Map of Ondo State LGAs" style={{ width: "100%", maxHeight: "70vh" }}>
            {view.paths.map(p => (
              <path key={p.lga} d={p.d} fill={p.fill} stroke="#14202b" strokeWidth="1" vectorEffect="non-scaling-stroke"
                onMouseEnter={() => setHover(p)} onMouseLeave={() => setHover(null)} />
            ))}
          </svg>
        )}
      </section>
    </div>
  );
}
