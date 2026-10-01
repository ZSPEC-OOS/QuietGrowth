import type { ReactNode } from "react";
import { statusLabel, statusTone, type Tone } from "@/lib/format";
import type { Kpi } from "@/lib/kpi";

export const Pill = ({ tone, children }: { tone: Tone; children: ReactNode }) => <span className={`pill ${tone}`}>{children}</span>;
export const Status = ({ s }: { s: string }) => <Pill tone={statusTone(s)}>{statusLabel(s)}</Pill>;
export const Kpis = ({ items }: { items: Kpi[] }) => (
  <div className="grid">{items.map((k) => (<div key={k.label} className="card kpi"><div className="label">{k.label}</div><div className="value">{k.value}</div>{k.note && <div className="note">{k.note}</div>}</div>))}</div>
);
export const PageHead = ({ title, sub }: { title: string; sub?: string }) => (<><h1>{title}</h1>{sub && <p className="sub">{sub}</p>}</>);
export function Table<T>({ cols, rows, empty }: { cols: { h: string; c: (r: T) => ReactNode }[]; rows: T[]; empty: string }) {
  if (rows.length === 0) return <div className="card empty">{empty}</div>;
  return (<table><thead><tr>{cols.map((c) => <th key={c.h}>{c.h}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c.h}>{c.c(r)}</td>)}</tr>)}</tbody></table>);
}
export const Banner = ({ title, items }: { title: string; items: string[] }) => items.length === 0 ? null : (<div className="banner" role="alert"><strong>{title}</strong><ul>{items.map((i) => <li key={i}>{i}</li>)}</ul></div>);
