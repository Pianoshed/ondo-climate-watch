// Shared by the map-style pages: turns the GeoJSON from the API into SVG paths coloured by value.
import { isNum, seqColor } from "./analytics";

const rings = g => (g.type === "Polygon" ? [g.coordinates] : g.coordinates).flat();

export function mapPaths(fc) {
  if (!fc || !fc.features.length) return null;
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const f of fc.features) for (const ring of rings(f.geometry)) for (const [x, y] of ring) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const vals = fc.features.map(f => f.properties.value).filter(isNum);
  const lo = vals.length ? Math.min(...vals) : 0, hi = vals.length ? Math.max(...vals) : 0;
  const paths = fc.features.map(f => {
    const v = f.properties.value;
    return {
      ...f.properties,
      fill: isNum(v) ? seqColor(hi === lo ? 0.5 : (v - lo) / (hi - lo)) : "#e4eaee",
      d: rings(f.geometry).map(r => "M" + r.map(([x, y]) => `${(x - x0).toFixed(4)},${(y1 - y).toFixed(4)}`).join("L") + "Z").join(""),
    };
  });
  return { w: x1 - x0, h: y1 - y0, lo, hi, paths, hasValues: vals.length > 0 };
}
