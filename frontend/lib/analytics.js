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
  // First row: Ondo State, the mean of all LGAs for each column.
  out.unshift({ name: "Ondo State", state: true, cells: cols.map(c => mean(Object.keys(cells).map(n => mean(cells[n][c] || [])))) });
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

// ================= State-level summary and plain-language interpretation =================
export const signed = v => (v == null || !isNum(v) ? "–" : (v > 0 ? "+" : "") + fmt(v));
export const tone = v => (v == null || v === 0 ? "" : v > 0 ? "up" : "down");
export const pNum = p => (typeof p === "string" ? (p.trim().startsWith("<") ? 0.0005 : parseFloat(p)) : Number(p));
export const strength = r => (Math.abs(r) < 0.3 ? "weak" : Math.abs(r) < 0.6 ? "moderate" : "strong");
const low = s => (s || "").toLowerCase();
const withUnit = (v, unit) => `${fmt(v)}${unit ? (unit === "%" ? "%" : " " + unit) : ""}`;

// One row per LGA: its average (yearly total for rainfall), its trend per decade and its latest month.
export function lgaStats(rows, key) {
  const by = new Map();
  for (const r of rows) { if (!by.has(r.lga)) by.set(r.lga, []); by.get(r.lga).push(r); }
  const out = [];
  for (const [lga, rs] of by) {
    const s = monthlySeries(rs, [key]);
    const pts = s.filter(x => isNum(x[key]));
    if (!pts.length) continue;
    const yearly = annualValues(s, key);
    const fit = yearly.length >= 5 ? linreg(yearly.map(y => y.year), yearly.map(y => y.value)) : null;
    const value = ADDITIVE.has(key)
      ? (yearly.length ? mean(yearly.map(y => y.value)) : mean(pts.map(x => x[key])) * 12) // short window: annualised
      : mean(pts.map(x => x[key]));
    out.push({ lga, value, perDecade: fit ? fit.slope * 10 : null, latest: pts[pts.length - 1][key] });
  }
  return out.filter(o => isNum(o.value)).sort((a, b) => b.value - a.value);
}

// State view of one indicator: mean of all LGAs, plus how the LGAs compare with it.
export function stateSummary(rows, key) {
  const series = monthlySeries(rows, [key]);
  const kp = kpis(series, key);
  const per = lgaStats(rows, key);
  if (!kp || !per.length) return null;
  const avg = mean(per.map(p => p.value));
  const hi = per[0], lo = per[per.length - 1];
  return { series, kp, per, avg, hi, lo, spread: hi.value - lo.value, above: per.filter(p => p.value > avg).length };
}

// Month by month: state mean and the lowest/highest LGA (for a shaded band).
export function bandSeries(rows, key) {
  const by = new Map();
  for (const r of rows) {
    if (!isNum(r[key])) continue;
    let e = by.get(r.period);
    if (!e) { e = { period: r.period, v: [] }; by.set(r.period, e); }
    e.v.push(r[key]);
  }
  return [...by.values()].sort((a, b) => (a.period < b.period ? -1 : 1))
    .map(e => ({ period: e.period, mean: mean(e.v), band: [Math.min(...e.v), Math.max(...e.v)] }));
}

export function healthNote(key) {
  if (/rain|precip/.test(key)) return "Why it matters for health: rain creates mosquito breeding sites (malaria) and can cause flooding and unsafe water (cholera, typhoid), while long dry spells strain water supply.";
  if (/t2m|temp/.test(key)) return "Why it matters for health: temperature changes how fast mosquitoes and malaria parasites develop, and very hot spells raise the risk of heat stress and dehydration.";
  if (/rh|humid/.test(key)) return "Why it matters for health: humid air helps mosquitoes live longer, which can raise malaria transmission, and damp conditions favour respiratory illness.";
  if (/soil|sm/.test(key)) return "Why it matters for health: wet soil keeps breeding sites and standing water around, and dry soil stresses crops and food supply.";
  return "";
}

export function interpretState(label, key, sum) {
  const { kp, per, avg, hi, lo, spread, above } = sum;
  const name = low(shortLabel(label)), unit = unitOf(label);
  const out = [];
  out.push(`Across Ondo State the ${kp.additive ? "average yearly total" : "average"} ${name} is ${withUnit(avg, unit)}${kp.additive ? " per year" : ""}, taken as the mean of ${per.length} LGAs.`);
  if (isNum(kp.vsUsual)) {
    const usual = kp.latest[key] - kp.vsUsual;
    const pct = usual ? Math.abs((kp.vsUsual / usual) * 100) : null;
    out.push(`The latest month (${kp.latest.period}) was ${withUnit(Math.abs(kp.vsUsual), unit)}${pct != null && isFinite(pct) ? ` (${pct.toFixed(0)}%)` : ""} ${kp.vsUsual >= 0 ? "above" : "below"} what is usual for that month.`);
  }
  if (isNum(kp.perDecade)) {
    const tol = /t2m|temp/.test(key) ? 0.05 : Math.abs(avg) * 0.02;
    out.push(Math.abs(kp.perDecade) < tol
      ? `Over the period the state-wide level is essentially flat (${signed(kp.perDecade)} ${unit} per decade).`
      : `Over the period the state-wide level is ${kp.perDecade > 0 ? "rising" : "falling"} by about ${withUnit(Math.abs(kp.perDecade), unit)} per decade. This is a straight-line fit; the Correlations page tests whether it is statistically clear.`);
  }
  if (per.length > 1 && avg) {
    const pct = (spread / Math.abs(avg)) * 100;
    out.push(`${hi.lga} is highest (${withUnit(hi.value, unit)}) and ${lo.lga} lowest (${withUnit(lo.value, unit)}), a gap of ${withUnit(spread, unit)} (${pct.toFixed(0)}% of the state average). ${above} of ${per.length} LGAs are above the state average.`);
    out.push(pct < 5 ? "LGAs are very similar, so the state figure describes each of them well." : pct > 15 ? "LGAs differ clearly, so use LGA figures, not the state average, for local decisions." : "LGAs differ moderately. The state figure is a fair guide, but check the LGA you care about.");
  }
  const h = healthNote(key); if (h) out.push(h);
  return out;
}

export function interpretSeason(series, key, label) {
  const c = climatology(series, key).filter(d => isNum(d.value));
  if (c.length < 12) return [];
  const peak = c.reduce((a, b) => (b.value > a.value ? b : a)), lowM = c.reduce((a, b) => (b.value < a.value ? b : a));
  const unit = unitOf(label), out = [`${peak.name} is the highest month on average (${withUnit(peak.value, unit)}) and ${lowM.name} the lowest (${withUnit(lowM.value, unit)}).`];
  if (ADDITIVE.has(key)) {
    const tot = c.reduce((a, d) => a + d.value, 0), rainy = c.filter(d => RAINY.has(d.month)).reduce((a, d) => a + d.value, 0);
    if (tot > 0) out.push(`${Math.round((rainy / tot) * 100)}% of the year's rain falls in the rainy season (April to October).`);
  }
  return out;
}

export function interpretAnnual(annual, label) {
  if (annual.length < 3) return ["Fewer than 3 complete years in this period, so no yearly pattern can be described."];
  const unit = unitOf(label), hi = annual.reduce((a, b) => (b.value > a.value ? b : a)), lo = annual.reduce((a, b) => (b.value < a.value ? b : a));
  const avg = mean(annual.map(a => a.value)), last = annual[annual.length - 1], d = last.value - avg;
  return [
    `Highest year: ${hi.year} (${withUnit(hi.value, unit)}). Lowest year: ${lo.year} (${withUnit(lo.value, unit)}).`,
    `${last.year} (the latest complete year) was ${withUnit(Math.abs(d), unit)} ${d >= 0 ? "above" : "below"} the all-years average of ${withUnit(avg, unit)}.`,
  ];
}

export function corrSentence(a, b, r, p, n) {
  if (!isNum(r)) return `${a} and ${b}: not enough overlapping data to measure a link.`;
  const sig = Number.isFinite(p) && p < 0.05, A = low(a), B = low(b);
  const base = Math.abs(r) < 0.1
    ? `${a} and ${B} show almost no link (r = ${r.toFixed(2)}).`
    : `${a} and ${B} have a ${strength(r)} ${r > 0 ? "positive" : "negative"} link (r = ${r.toFixed(2)}): when ${A} is higher than normal, ${B} tends to be ${r > 0 ? "higher" : "lower"}.`;
  const known = p != null && Number.isFinite(p);
  return `${base}${known ? (sig ? " This is unlikely to be chance." : " This could easily be chance.") : ""}${n ? ` (${n} points)` : ""}`;
}

export function interpretWaterfall(items, label, mode) {
  const steps = (items || []).filter(i => i.delta != null);
  if (!steps.length) return [];
  const unit = unitOf(label), up = steps.reduce((a, b) => (b.delta > a.delta ? b : a)), dn = steps.reduce((a, b) => (b.delta < a.delta ? b : a));
  const per = mode === "months" ? "month" : "year";
  return [`Biggest rise: ${up.name} (${signed(up.delta)} ${unit} on the previous ${per}). Biggest fall: ${dn.name} (${signed(dn.delta)} ${unit}).`];
}

export function interpretPie(pie, by, label) {
  if (!pie.length) return [];
  const tot = pie.reduce((a, d) => a + d.value, 0), top = pie.reduce((a, b) => (b.value > a.value ? b : a));
  const what = by === "lga" ? "LGA" : by === "season" ? "season" : "month";
  return [`The largest ${what} share is ${top.name} at ${Math.round((top.value / tot) * 100)}% of the total ${low(shortLabel(label))}.`];
}

export function interpretHeat(heat, by, fmtv = fmt) {
  if (!heat) return [];
  if (by === "corr") {
    let best = null;
    heat.rows.forEach((r, i) => r.cells.forEach((v, j) => { if (j > i && isNum(v) && (!best || Math.abs(v) > Math.abs(best.v))) best = { v, a: r.name, b: heat.cols[j] }; }));
    return best ? [corrSentence(best.a, best.b, best.v, NaN)] : [];
  }
  let hi = null, lo = null;
  heat.rows.forEach(r => r.cells.forEach((v, j) => {
    if (!isNum(v)) return;
    if (!hi || v > hi.v) hi = { v, r: r.name, c: heat.cols[j] };
    if (!lo || v < lo.v) lo = { v, r: r.name, c: heat.cols[j] };
  }));
  return hi ? [`Darkest cell: ${hi.r}, ${hi.c} (${fmtv(hi.v)}). Lightest: ${lo.r}, ${lo.c} (${fmtv(lo.v)}). The first row is the Ondo State average, so compare each LGA with it.`] : [];
}
