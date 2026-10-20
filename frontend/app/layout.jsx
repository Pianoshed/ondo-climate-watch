import "./globals.css";
import { APP_NAME } from "../lib/brand"; // keep your existing import path

export const metadata = {
  title: { default: APP_NAME, template: `%s | ${APP_NAME}` },
  description:
    "Ondo State Climate Watch tracks climate conditions and their links to public health outcomes across Ondo State, Nigeria.",
  manifest: "/manifest.webmanifest",
  openGraph: { siteName: APP_NAME, title: APP_NAME, type: "website" },
  twitter: { card: "summary_large_image", title: APP_NAME },
  robots: { index: false, follow: false },
};

export const viewport = {
  themeColor: "#0f766e", // any 6-digit hex; swap for your brand color
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}