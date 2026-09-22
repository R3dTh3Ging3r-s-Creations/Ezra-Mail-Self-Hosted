import { FirstOwnerSetup } from "@/components/ezra/FirstOwnerSetup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function FirstOwnerSetupPage(props: {
  searchParams: Promise<{ challenge?: string }>;
}) {
  const { challenge = "" } = await props.searchParams;
  return <FirstOwnerSetup challenge={challenge} />;
}
