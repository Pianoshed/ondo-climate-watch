"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, post } from "../lib/api";
import Brand from "./Brand";

// Wraps a page: redirects to /login when signed out, shows the nav, and passes { me, logout } to its children.
export default function Protected({ children }) {
  const router = useRouter();
  const [me, setMe] = useState(null);
  useEffect(() => {
    api("/api/auth/me").then(setMe).catch(() => router.replace("/login"));
  }, [router]);
  const logout = useCallback(async () => {
    await post("/api/auth/logout").catch(() => {});
    router.replace("/login");
  }, [router]);
  if (!me) return null;
  return (
    <>
      <nav className="nav">
        <Link href="/" className="brandlink"><Brand /></Link>
        <Link href="/">Dashboard</Link>
        <Link href="/map">Map</Link>
        <Link href="/security">Security</Link>
        <span>{me.email}</span>
        <button className="linkbtn" onClick={logout}>Sign out</button>
      </nav>
      {children({ me, logout })}
    </>
  );
}
