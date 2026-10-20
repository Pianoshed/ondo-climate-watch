"use client";
import { useState } from "react";
import Brand from "../../components/Brand";
import { post } from "../../lib/api";

export default function ForgotPage() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setError("");
    try {
      await post("/api/auth/forgot", { email });
      setDone(true);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="login">
      <form className="panel" onSubmit={submit}>
        <div className="brandtop"><Brand size={64} /></div>
        <h1>Reset your password</h1>
        {done ? (
          <p>If that email has an account, a reset link is on its way. It works once and expires in 30 minutes.</p>
        ) : (
          <>
            <label htmlFor="fe">Email</label>
            <input id="fe" type="email" required value={email} onChange={e => setEmail(e.target.value)} />
            {error && <p role="alert" className="err">{error}</p>}
            <button className="btn">Send reset link</button>
          </>
        )}
        <a href="/login">Back to sign in</a>
      </form>
    </div>
  );
}
