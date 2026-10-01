import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "QuietGrowth", description: "Autonomous SaaS growth operations with owner-controlled money and risk" };
export default function RootLayout({ children }: { children: ReactNode }) {
  return (<html lang="en"><body>{children}</body></html>);
}
