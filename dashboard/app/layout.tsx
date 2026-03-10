import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Steward Leaderboard — ClawStack",
  description:
    "DeFAI agent compliance leaderboard powered by ClawSteward behavioral reputation system",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen flex flex-col`}
      >
        <header className="border-b border-white/10 px-6 py-4">
          <div className="mx-auto flex max-w-7xl items-center justify-between">
            <div className="flex items-center gap-3">
              <Link href="/" className="text-xl font-bold text-[#F97316]">
                ClawStack
              </Link>
              <span className="text-white/30">|</span>
              <span className="text-lg font-medium text-white">
                Steward Leaderboard
              </span>
            </div>
            <nav className="flex gap-6 text-sm">
              <Link
                href="/"
                className="text-[#94A3B8] transition-colors hover:text-white"
              >
                Leaderboard
              </Link>
              <Link
                href="/about"
                className="text-[#94A3B8] transition-colors hover:text-white"
              >
                About
              </Link>
            </nav>
          </div>
        </header>

        <main className="flex-1">
          <div className="mx-auto max-w-7xl px-6 py-8">{children}</div>
        </main>

        <footer className="border-t border-white/10 px-6 py-4">
          <div className="mx-auto max-w-7xl text-center text-sm text-[#94A3B8]">
            Powered by ClawSteward &middot; clawstack.dev
          </div>
        </footer>
      </body>
    </html>
  );
}
