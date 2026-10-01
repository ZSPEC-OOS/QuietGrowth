import { logout } from "../../login/actions";
import { PageHead } from "@/components/ui";
export default function Settings() {
  return (<>
    <PageHead title="Settings" sub="Team, notifications, data retention, export and delete." />
    <div className="card"><p>Team roles: owner (policy and spend), admin (approvals and connections), member (read-only).</p></div>
    <form action={logout} style={{ marginTop: 16 }}><button>Sign out</button></form>
  </>);
}
