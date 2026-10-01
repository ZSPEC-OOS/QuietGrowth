import Link from "next/link";
const ITEMS: [string, string][] = [["/dashboard", "Dashboard"], ["/funnel", "Funnel"], ["/opportunities", "Opportunities"], ["/actions", "Actions"], ["/acquisition", "Acquisition"], ["/lifecycle", "Lifecycle"], ["/experiments", "Experiments"], ["/analytics", "Analytics"], ["/autopilot", "Autopilot"], ["/integrations", "Integrations"], ["/product", "Product profile"], ["/settings", "Settings"]];
export function Nav() {
  return (<nav className="nav" aria-label="Main"><div className="brand">Quiet<b>Growth</b></div>{ITEMS.map(([h, l]) => <Link key={h} href={h}>{l}</Link>)}</nav>);
}
