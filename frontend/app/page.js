"use client";
import Dashboard from "../components/Dashboard";
import Protected from "../components/Protected";

export default function Page() {
  return <Protected>{({ logout }) => <Dashboard onLogout={logout} />}</Protected>;
}
