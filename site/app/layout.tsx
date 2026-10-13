import "./global.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

const description =
  "Run Claude Code, Codex and other coding agents at once from one browser tab. Every agent that needs you becomes a card in one queue. Local only: no account, no telemetry.";

export const metadata: Metadata = {
  metadataBase: new URL("https://frizz.sh"),
  title: { default: "Ntwine — an opinionated agent console", template: "%s · Ntwine" },
  description,
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    type: "website",
    siteName: "Ntwine",
    description,
    images: [{ url: "/img/og.png", width: 1200, height: 630 }],
  },
  twitter: { card: "summary_large_image", creator: "@colinhacks" },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col font-sans antialiased">
        <RootProvider theme={{ defaultTheme: "dark" }}>{children}</RootProvider>
      </body>
    </html>
  );
}
