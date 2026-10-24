"use client";
import Hazards from "../../components/Hazards";
import Protected from "../../components/Protected";

export default function HazardsPage() {
  return <Protected>{({ logout }) => <Hazards onLogout={logout} />}</Protected>;
}
