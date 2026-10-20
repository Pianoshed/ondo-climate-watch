"use client";
import { useState } from "react";
import { post } from "../lib/api";

export default function Login({ onDone }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (needCode) {
        await post("/api/auth/mfa", { code });
        onDone();
      } else {
        const r = await post("/api/auth/login", { email, password });
        if (r.mfa_required) setNeedCode(true);
        else onDone();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="panel" onSubmit={submit}>
        <h1>Sign in</h1>
        {needCode ? (
          <>
            <p>Enter the 6-digit code from your authenticator app.</p>
            <label htmlFor="cd">6-digit code</label>
            <input id="cd" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={e => setCode(e.target.value)} />
          </>
        ) : (
          <>
            <p>Ondo climate and health data</p>
            <label htmlFor="em">Email</label>
            <input id="em" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} />
            <label htmlFor="pw">Password</label>
            <input id="pw" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
          </>
        )}
        {error && <p role="alert" className="err">{error}</p>}
        <button className="btn" disabled={busy}>{needCode ? "Verify" : "Sign in"}</button>
        {needCode ? (
          <button type="button" className="linkbtn" onClick={() => { setNeedCode(false); setCode(""); setError(""); }}>Start over</button>
        ) : (
          <a href="/forgot">Forgot password?</a>
        )}
      </form>
    </div>
  );
}
