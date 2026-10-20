import "./globals.css";
import { APP_DESCRIPTION, APP_NAME, APP_SHORT_NAME, THEME_COLOR } from "../lib/brand";

// Set NEXT_PUBLIC_SITE_URL (at build time) to the public https address so share-card image links are absolute.
const site = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

export const metadata = {
  metadataBase: new URL(site),
  title: { default: APP_NAME, template: `%s | ${APP_NAME}` },
  description: APP_DESCRIPTION,
  applicationName: APP_NAME,
  keywords: ["Ondo State", "climate change", "health", "rainfall", "temperature", "humidity", "LGA", "Nigeria"],
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: APP_SHORT_NAME, statusBarStyle: "default" },
  formatDetection: { telephone: false },
  // Sign-in is required to see any data, so keep the app out of search results.
  robots: { index: false, follow: false },
  openGraph: { type: "website", siteName: APP_NAME, title: APP_NAME, description: APP_DESCRIPTION, locale: "en_NG" },
  twitter: { card: "summary_large_image", title: APP_NAME, description: APP_DESCRIPTION },
};

export const viewport = { themeColor: THEME_COLOR, width: "device-width", initialScale: 1 };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
