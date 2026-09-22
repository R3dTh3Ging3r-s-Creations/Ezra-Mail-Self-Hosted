import { foregroundBrowserNotificationsEnabled } from "@/lib/email/foreground-notifications";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PwaProvider } from "@/components/ezra/PwaProvider";

export const metadata: Metadata = {
  title: "Ezra Mail",
  applicationName: "Ezra Mail",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Ezra Mail", statusBarStyle: "default" },
  description: "Private mail intelligence for triage, briefing, sweeping, and replies.",
  icons: {
    icon: [
      {
        url: "/branding/ezra-mail-logo-d4-120.png",
        type: "image/png",
        sizes: "120x120",
      },
    ],
    shortcut: "/branding/ezra-mail-logo-d4-120.png",
    apple: [
      {
        url: "/branding/ezra-mail-logo-d4-512.png",
        type: "image/png",
        sizes: "512x512",
      },
    ],
  },
};

export const viewport: Viewport = { themeColor: "#173f43" };

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body><PwaProvider browserNotificationsEnabled={foregroundBrowserNotificationsEnabled()}>{children}</PwaProvider></body>
    </html>
  );
}
