import type { ReactNode } from "react";
import { Nav } from "@/components/Nav";
export default function AppLayout({ children }: { children: ReactNode }) {
  return (<div className="shell"><Nav /><main className="main">{children}</main></div>);
}
