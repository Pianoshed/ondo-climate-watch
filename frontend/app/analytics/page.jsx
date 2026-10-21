"use client";
import Analytics from "../../components/Analytics";
import Protected from "../../components/Protected";

export default function AnalyticsPage() {
  return <Protected>{({ logout }) => <Analytics onLogout={logout} />}</Protected>;
}
