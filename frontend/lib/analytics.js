// Pure helpers for the Analytics page. No React, so they are easy to test.
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const ADDITIVE = new Set(["rain_mm", "era5_rain_mm"]); // quantities that add up over time
export const RAINY = new Set([4, 5, 6, 7, 8, 9, 10]); // Apr-Oct; Nov-Mar counts as the dry season

export const isNum = v => typeof v === "number" && Number.isFinite(v);
export const mean = a => {
  const x = a.filter(isNum);
  return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null;
};
export const unitOf = label => (label.match(/\(([^)]+)\)\s*$/) || [])[1] || "";
export const shortLabel = label => label.replace(/\s*\([^)]*\)\s*$/, "");
export const fmt = v => (v == null || !isNum(v) ? "–" : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
const ym = period => period.split("-").map(Number);

// Rows (one per LGA per month) -> one row per month holding the mean across the LGAs in `rows`.
export function monthlySeries(rows, keys) {
  const by = new Map();
  for (const r of rows) {
    let e = by.get(r.period);
    if (!e) {
      const [year, month] = ym(r.period);
      e = { period: r.period, year, month, _v: {} };
      by.set(r.period, e);
    }
    for (const k of keys) if (isNum(r[k])) (e._v[k] ??= []).push(r[k]);
  }
  return [...by.values()]
    .sort((a, b) => (a.period < b.period ? -1 : 1))
    .map(({ _v, ...e }) => {
      for (const k of keys) e[k] = mean(_v[k] || []);
      return e;
    });
}

// Trailing mean over `w` months. Needs a full window, otherwise the seasons bias the first points.
export function rolling(series, keys, w = 12) {
  return series.map((s, i) => {
    const out = { ...s };
    for (const k of keys) {
      const win = series.slice(Math.max(0, i - w + 1), i + 1).map(x => x[k]).filter(isNum);
      out[k] = win.length >= w ? mean(win) : null;
    }
    return out;
  });
}

// Rescales each key to 0-100 so indicators with different units share one axis. Raw values kept as raw_<key>.
export function normalise(series, keys) {
  const range = {};
  for (const k of keys) {
    const v = series.map(s => s[k]).filter(isNum);
    range[k] = [Math.min(...v), Math.max(...v)];
  }
  return series.map(s => {
    const o = { ...s };
    for (const k of keys) {
      const [lo, hi] = range[k];
      o["raw_" + k] = s[k];
      o[k] = isNum(s[k]) ? (hi === lo ? 50 : ((s[k] - lo) / (hi - lo)) * 100) : null;
    }
    return o;
  });
}

export function pearson(xs, ys) {
  const p = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => isNum(x) && isNum(y));
  if (p.length < 3) return null;
  const mx = mean(p.map(a => a[0])), my = mean(p.map(a => a[1]));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of p) {
    sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

export function linreg(xs, ys) {
  const p = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => isNum(x) && isNum(y));
  if (p.length < 3) return null;
  const mx = mean(p.map(a => a[0])), my = mean(p.map(a => a[1]));
  let sxy = 0, sxx = 0;
  for (const [x, y] of p) {
    sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2;
  }
  if (!sxx) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r: pearson(xs, ys), n: p.length };
}

// Yearly values: totals for rainfall (complete years only), means otherwise (years with 9+ months).
export function annualValues(series, key) {
  const by = {};
  for (const s of series) if (isNum(s[key])) (by[s.year] ??= []).push(s[key]);
  const out = [];
  for (const [y, v] of Object.entries(by)) {
    if (ADDITIVE.has(key)) {
      if (v.length === 12) out.push({ year: +y, value: v.reduce((a, b) => a + b, 0) });
    } else if (v.length >= 9) out.push({ year: +y, value: mean(v) });
  }
  return out.sort((a, b) => a.year - b.year);
}

export function kpis(series, key) {
  const pts = series.filter(s => isNum(s[key]));
  if (!pts.length) return null;
  const peak = pts.reduce((a, b) => (b[key] > a[key] ? b : a));
  const low = pts.reduce((a, b) => (b[key] < a[key] ? b : a));
  const latest = pts[pts.length - 1];
  const prev = pts.find(s => s.year === latest.year - 1 && s.month === latest.month);
  const usual = mean(pts.filter(s => s.month === latest.month && s !== latest).map(s => s[key]));
  const yearly = annualValues(series, key);
  const fit = yearly.length >= 5 ? linreg(yearly.map(y => y.year), yearly.map(y => y.value)) : null;
  return {
    additive: ADDITIVE.has(key),
    average: ADDITIVE.has(key) ? mean(yearly.map(y => y.value)) : mean(pts.map(s => s[key])),
    peak, low, latest,
    vsLastYear: prev ? latest[key] - prev[key] : null,
    vsUsual: usual == null ? null : latest[key] - usual,
    perDecade: fit ? fit.slope * 10 : null,
    months: pts.length,
  };
}

// points: [{name, value}] -> bars for a waterfall: start total, one step per change, end total.
export function buildWaterfall(points) {
  const p = points.filter(x => isNum(x.value));
  if (p.length < 2) return null;
  const vals = p.map(x => x.value);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.25 || Math.abs(hi) * 0.05 || 1;
  const floor = lo >= 0 ? Math.max(0, lo - pad) : lo - pad, ceil = hi + pad; // never dip below zero for quantities that cannot be negative
  const items = [{ name: `Start (${p[0].name})`, kind: "total", value: p[0].value, delta: null, range: [floor, p[0].value] }];
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1].value, b = p[i].value;
    items.push({ name: p[i].name, kind: b >= a ? "up" : "down", value: b, delta: b - a, range: [Math.min(a, b), Math.max(a, b)] });
  }
  const last = p[p.length - 1];
  items.push({ name: `End (${last.name})`, kind: "total", value: last.value, delta: null, range: [floor, last.value] });
  return { items, floor, ceil };
}

// Long-term average for each calendar month (Jan..Dec).
export function climatology(series, key) {
  return MONTHS.map((name, i) => ({ name, month: i + 1, value: mean(series.filter(s => s.month === i + 1).map(s => s[key])) }));
}

export function pieByMonth(series, key) {
  return climatology(series, key).filter(d => isNum(d.value) && d.value > 0);
}

export function pieBySeason(series, key) {
  const c = climatology(series, key).filter(d => isNum(d.value) && d.value > 0);
  const sum = f => c.filter(d => f(d.month)).reduce((a, d) => a + d.value, 0);
  return [{ name: "Rainy season (Apr–Oct)", value: sum(m => RAINY.has(m)) }, { name: "Dry season (Nov–Mar)", value: sum(m => !RAINY.has(m)) }]
    .filter(d => d.value > 0);
}

export function pieByLga(rows, key, top = 20) {
  const by = {};
  for (const r of rows) if (isNum(r[key])) (by[r.lga] ??= []).push(r[key]);
  const all = Object.entries(by).map(([name, v]) => ({ name, value: mean(v) })).filter(d => d.value > 0).sort((a, b) => b.value - a.value);
  if (all.length <= top + 1) return all;
  return [...all.slice(0, top), { name: `Other (${all.length - top} LGAs)`, value: all.slice(top).reduce((a, d) => a + d.value, 0) }];
}

// LGA x month-of-year, or LGA x year, mean of the indicator.
export function heatMatrix(rows, key, by) {
  const cells = {};
  const colSet = new Set();
  for (const r of rows) {
    if (!isNum(r[key])) continue;
    const [y, m] = ym(r.period);
    const c = by === "year" ? y : m;
    colSet.add(c);
    ((cells[r.lga] ??= {})[c] ??= []).push(r[key]);
  }
  const cols = [...colSet].sort((a, b) => a - b);
  const out = Object.keys(cells).sort().map(name => ({ name, cells: cols.map(c => mean(cells[name][c] || [])) }));
  const all = out.flatMap(r => r.cells).filter(isNum);
  return { cols: cols.map(c => (by === "year" ? String(c) : MONTHS[c - 1])), rows: out, min: Math.min(...all), max: Math.max(...all) };
}

export function correlationMatrix(series, keys) {
  return keys.map(a => keys.map(b => (a === b ? 1 : pearson(series.map(s => s[a]), series.map(s => s[b])))));
}

// Colour scales. seq: 0..1 light to teal (same ramp as the map). div: -1..1 red - white - teal.
export const seqColor = t => `rgb(${Math.round(226 - 211 * t)},${Math.round(240 - 122 * t)},${Math.round(238 - 123 * t)})`;
export const divColor = v => {
  const a = Math.min(1, Math.abs(v));
  const [r, g, b] = v >= 0 ? [15, 118, 110] : [190, 18, 60];
  return `rgb(${Math.round(255 + (r - 255) * a)},${Math.round(255 + (g - 255) * a)},${Math.round(255 + (b - 255) * a)})`;
};
