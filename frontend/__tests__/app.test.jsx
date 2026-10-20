import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import ForgotPage from "../app/forgot/page";
import LoginPage from "../app/login/page";
import Home from "../app/page";
import ResetPage from "../app/reset/page";
import SecurityPage from "../app/security/page";

const { router } = vi.hoisted(() => ({ router: { replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/link", async () => {
  const React = await import("react");
  return { default: ({ href, children }) => React.createElement("a", { href }, children) };
});
vi.mock("recharts", () => {
  const Null = () => null;
  return { ResponsiveContainer: Null, LineChart: Null, BarChart: Null, Line: Null, Bar: Null, XAxis: Null, YAxis: Null,
    Tooltip: Null, Legend: Null, CartesianGrid: Null };
});

afterEach(() => { cleanup(); router.replace.mockClear(); });

function mockApi(routes) {
  global.fetch = vi.fn(async (url, opts = {}) => {
    const r = routes[`${opts.method || "GET"} ${url.split("?")[0]}`] || { status: 404, body: { error: "not found" } };
    const status = r.status || 200;
    return { ok: status < 400, status, json: async () => r.body };
  });
}

const signedIn = { "GET /api/auth/me": { body: { email: "ada@example.org", mfa: false } } };
const type = (label, text) => userEvent.type(screen.getByLabelText(label), text);

test("redirects to /login when signed out", async () => {
  mockApi({ "GET /api/auth/me": { status: 401, body: { error: "Authentication required" } } });
  render(<Home />);
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
});

test("dashboard shows LGAs, data, export link and nav", async () => {
  mockApi({
    ...signedIn,
    "GET /api/meta": { body: { lgas: ["Akure South", "Owo"], variables: { rain_mm: "Rainfall (mm/month)" }, start: "2024-01", end: "2024-03" } },
    "GET /api/data": { body: [{ lga: "Akure South", period: "2024-01", rain_mm: 120.5 }] },
    "GET /api/summary": { body: [{ lga: "Akure South", value: 120.5 }] },
  });
  render(<Home />);
  expect(await screen.findByRole("checkbox", { name: "Akure South" })).toBeTruthy();
  expect(await screen.findByText("120.5")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Download Excel" }).getAttribute("href")).toContain("/api/export.xlsx");
  expect(screen.getByRole("link", { name: "Map" })).toBeTruthy();
});

test("sign-in shows the server error on a wrong password", async () => {
  mockApi({ "POST /api/auth/login": { status: 401, body: { error: "Invalid email or password" } } });
  render(<LoginPage />);
  await type("Email", "ada@example.org");
  await type("Password", "wrong-password-1");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Invalid email or password");
});

test("sign-in asks for the authenticator code, then continues", async () => {
  mockApi({ "POST /api/auth/login": { body: { mfa_required: true } }, "POST /api/auth/mfa": { body: { email: "ada@example.org" } } });
  render(<LoginPage />);
  await type("Email", "ada@example.org");
  await type("Password", "correct horse battery");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await userEvent.type(await screen.findByLabelText("6-digit code"), "123456");
  await userEvent.click(screen.getByRole("button", { name: "Verify" }));
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
});

test("forgot password gives a generic confirmation", async () => {
  mockApi({ "POST /api/auth/forgot": { body: { ok: true } } });
  render(<ForgotPage />);
  await type("Email", "anyone@example.org");
  await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
  expect(await screen.findByText(/reset link is on its way/)).toBeTruthy();
});

test("reset page sends the token from the URL fragment", async () => {
  window.location.hash = "#token=abc123";
  mockApi({ "POST /api/auth/reset": { body: { ok: true } } });
  render(<ResetPage />);
  await type("New password", "a brand new passphrase");
  await type("Confirm password", "a brand new passphrase");
  await userEvent.click(screen.getByRole("button", { name: "Set new password" }));
  expect(await screen.findByText(/Password updated/)).toBeTruthy();
  expect(global.fetch.mock.calls.at(-1)[1].body).toContain("abc123");
});

test("security page sets up two-factor sign-in", async () => {
  mockApi({
    ...signedIn,
    "POST /api/auth/mfa/setup": { body: { secret: "JBSWY3DP", qr: "data:image/svg+xml;base64,AA==" } },
    "POST /api/auth/mfa/enable": { body: { ok: true } },
  });
  render(<SecurityPage />);
  await userEvent.click(await screen.findByRole("button", { name: "Set up two-factor sign-in" }));
  expect(await screen.findByAltText("QR code for your authenticator app")).toBeTruthy();
  expect(screen.getByText("JBSWY3DP")).toBeTruthy();
  await type("6-digit code", "123456");
  await userEvent.click(screen.getByRole("button", { name: "Turn on" }));
  expect(await screen.findByText(/Two-factor sign-in is on/)).toBeTruthy();
});
