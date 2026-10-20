"use client";
import { useState } from "react";

export default function PasswordInput(props) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="pw-wrap">
      <input {...props} type={visible ? "text" : "password"} />
      <button type="button" className="pw-toggle" onClick={() => setVisible(v => !v)} aria-pressed={visible}>
        {visible ? "Hide" : "Show"}
      </button>
    </span>
  );
}
