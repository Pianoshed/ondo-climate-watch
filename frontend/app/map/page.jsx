"use client";
import MapView from "../../components/MapView";
import Protected from "../../components/Protected";

export default function MapPage() {
  return <Protected>{({ logout }) => <MapView onLogout={logout} />}</Protected>;
}
