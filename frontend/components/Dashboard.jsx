"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer } from "recharts";

const COLORS = ["#0f766e", "#b45309", "#1d4ed8", "#be123c", "#6d28d9", "#4d7c0f", "#0e7490", "#a16207"];

export default function Dashboard({ onLogout }) {
  const [meta, setMeta] = useState(null);
  const [sel, setSel] = useState([]);
  const [variable, setVariable] = useState("rain_mm");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/meta")
      .then(m => { setMeta(m); setSel(m.lgas.slice(0, 3)); setStart(m.start); setEnd(m.end); })
      .catch(e => (e.status === 401 ? onLogout() : setError("No data yet. Load boundaries and run the pipeline, then reload.")));
  }, [onLogout]);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    sel.forEach(l => p.append("lga", l));
    p.set("variable", variable);
    if (start) p.set("start", start);
    if (end) p.set("end", end);
    return p.toString();
  }, [sel, variable, start, end]);

  useEffect(() => {
    if (!meta) return;
    const lost = e => e.status === 401 && onLogout();
    api(`/api/data?${qs}`).then(setRows).catch(lost);
    api(`/api/summary?${qs}`).then(setSummary).catch(lost);
  }, [qs, meta, onLogout]);

  const series = useMemo(() => {
    const m = {};
    rows.forEach(r => { (m[r.period] ??= { period: r.period })[r.lga] = r[variable]; });
    return Object.values(m);
  }, [rows, variable]);

  const toggle = l => setSel(s => (s.includes(l) ? s.filter(x => x !== l) : [...s, l]));
  const label = meta?.variables[variable];

  return (
    <>
      <header>
        <h1>Ondo State climate data by LGA</h1>
        <p>Monthly rainfall, temperature and humidity. Choose LGAs and dates, then download to Excel.</p>
      </header>
      {error && <div className="err">{error}</div>}
      {meta && (
        <main>
          <aside>
            <label htmlFor="v">Indicator</label>
            <select id="v" value={variable} onChange={e => setVariable(e.target.value)}>
              {Object.entries(meta.variables).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <label htmlFor="s">From</label>
            <input id="s" type="month" value={start} min={meta.start} max={meta.end} onChange={e => setStart(e.target.value)} />
            <label htmlFor="e">To</label>
            <input id="e" type="month" value={end} min={meta.start} max={meta.end} onChange={e => setEnd(e.target.value)} />
            <label>LGAs ({sel.length} selected)</label>
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
            <section className="panel">
              <h2>{label} over time</h2>
              <div className="chart">
                <ResponsiveContainer>
                  <LineChart data={series}>
                    <CartesianGrid stroke="#e4eaee" /><XAxis dataKey="period" minTickGap={40} /><YAxis /><Tooltip /><Legend />
                    {sel.slice(0, 8).map((l, i) => <Line key={l} dataKey={l} stroke={COLORS[i]} dot={false} strokeWidth={2} />)}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              {sel.length > 8 && <p>Chart shows the first 8 selected LGAs. The Excel file includes all.</p>}
            </section>
            <section className="panel">
              <h2>Average {label} by LGA, {start} to {end}</h2>
              <div className="chart">
                <ResponsiveContainer>
                  <BarChart data={summary}>
                    <CartesianGrid stroke="#e4eaee" /><XAxis dataKey="lga" interval={0} angle={-35} textAnchor="end" height={80} fontSize={11} /><YAxis /><Tooltip />
                    <Bar dataKey="value" fill="#0f766e" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>
            <section className="panel">
              <h2>Data preview</h2>
              <div className="tbl">
                <table>
                  <thead><tr><th>LGA</th><th>Month</th>{Object.values(meta.variables).map(v => <th key={v}>{v}</th>)}</tr></thead>
                  <tbody>
                    {rows.slice(0, 100).map(r => (
                      <tr key={r.lga + r.period}><td>{r.lga}</td><td>{r.period}</td>{Object.keys(meta.variables).map(k => <td key={k}>{r[k] ?? ""}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </main>
      )}
    </>
  );
}
