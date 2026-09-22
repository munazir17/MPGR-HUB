import { redirect } from "next/navigation";

// app/agent/page.tsx
//
// The Base Stocks terminal moved to Home ("/") as the MPGR AGENT —
// there is no separate Stocks page anymore. /agent is kept only as a
// redirect so existing links don't 404.

export default function AgentPage() {
  redirect("/");
}
