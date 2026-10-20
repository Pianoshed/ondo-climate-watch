"use client";
import { useState } from "react";
import Protected from "../../components/Protected";
import { post } from "../../lib/api";

function TwoFactor({ enabled }) {
  const [on, setOn] = useState(enabled);
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  async function start() {
    setError("");
    try {
      setSetup(await post("/api/auth/mfa/setup"));
    } catch (err) {
      setError(err.message);
    }
  }

  async function enable(e) {
    e.preventDefault();
    setError("");
    try {
      await post("/api/auth/mfa/enable", { code });
      setOn(true);
      setSetup(null);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="login">
      <div className="panel">
        <h1>Security</h1>
        {on ? (
          <p>Two-factor sign-in is on. If you lose your phone, ask an administrator to reset it.</p>
        ) : setup ? (
          <form onSubmit={enable}>
            <p>Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator, Authy), then enter the code it shows.</p>
            {/* eslint-disable-next-line @next/next/no-img-element -- inline data URI made by our own server */}
            <img src={setup.qr} alt="QR code for your authenticator app" width="180" height="180" />
            <p>Cannot scan? Enter this key instead: <code>{setup.secret}</code></p>
            <label htmlFor="tc">6-digit code</label>
            <input id="tc" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={e => setCode(e.target.value)} />
            {error && <p role="alert" className="err">{error}</p>}
            <button className="btn">Turn on</button>
          </form>
        ) : (
          <>
            <p>Add a second step to sign-in: a code from your phone.</p>
            {error && <p role="alert" className="err">{error}</p>}
            <button className="btn" onClick={start}>Set up two-factor sign-in</button>
          </>
        )}
      </div>
    </div>
  );
}

export default function SecurityPage() {
  return <Protected>{({ me }) => <TwoFactor enabled={me.mfa} />}</Protected>;
}
