const api = (process.env.API_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
// API_URL is baked in when `next build` runs, so it must be set on Render before the build.
if (process.env.RENDER && (!process.env.API_URL || /localhost|127\.0\.0\.1/.test(api))) {
  throw new Error("Set API_URL to the backend's https://....onrender.com address before building");
}

const secure = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

module.exports = {
  poweredByHeader: false,
  async rewrites() { return [{ source: "/api/:path*", destination: `${api}/api/:path*` }]; },
  async headers() { return [{ source: "/:path*", headers: secure }]; },
};
