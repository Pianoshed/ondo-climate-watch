"use client";
import Surveys from "../../components/Surveys";
import Protected from "../../components/Protected";

export default function SurveysPage() {
  return <Protected>{({ logout }) => <Surveys onLogout={logout} />}</Protected>;
}
