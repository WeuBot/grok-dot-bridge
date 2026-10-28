import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Grok → dot 事件桥",
  description: "私有 HTTP 到 MCP Events 桥接控制台。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
