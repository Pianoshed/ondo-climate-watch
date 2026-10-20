"use client";
import { useState } from "react";
import { post } from "../../lib/api";

export default function ResetPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setError("");
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
    if (password !== confirm) return setError("The two passwords do not match.");
    try {
      await post("/api/auth/reset", { token, password });
      setDone(true);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="login">
      <form className="panel" onSubmit={submit}>
        <h1>Choose a new password</h1>
        {done ? (
          <p>Password updated. <a href="/login">Sign in</a></p>
        ) : (
          <>
            <label htmlFor="np">New password</label>
            <input id="np" type="password" autoComplete="new-password" minLength={12} required value={password} onChange={e => setPassword(e.target.value)} />
            <label htmlFor="cp">Confirm password</label>
            <input id="cp" type="password" autoComplete="new-password" minLength={12} required value={confirm} onChange={e => setConfirm(e.target.value)} />
            <p>Use at least 12 characters.</p>
            {error && <p role="alert" className="err">{error}</p>}
            <button className="btn">Set new password</button>
          </>
        )}
      </form>
    </div>
  );
}
