"use client";
import Correlations from "../../components/Correlations";
import Protected from "../../components/Protected";

export default function CorrelationsPage() {
  return <Protected>{({ logout }) => <Correlations onLogout={logout} />}</Protected>;
}
