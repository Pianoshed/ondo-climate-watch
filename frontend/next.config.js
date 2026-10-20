const secure = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];
module.exports = {
  poweredByHeader: false,
  async rewrites() { return [{ source: "/api/:path*", destination: `${process.env.API_URL || "http://127.0.0.1:5000"}/api/:path*` }]; },
  async headers() { return [{ source: "/:path*", headers: secure }]; },
};
