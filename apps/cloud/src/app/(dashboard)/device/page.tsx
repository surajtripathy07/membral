import { PageFrame } from "@/components/ui/page-frame";
import { DeviceApproveView } from "@/components/device-approve-view";

// /device — device-code sign-in for the Membral CLI (`membral setup`).
// Lives in the (dashboard) route group so the layout's own auth redirect
// plus middleware's ?next=/device?code=... round-trip (see
// src/middleware.ts and (auth)/actions.ts) gets a signed-out visitor here
// through login/signup and back, exactly like any other protected page.
export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const params = await searchParams;
  const codeParam = Array.isArray(params.code) ? params.code[0] : params.code;

  return (
    <PageFrame width="read">
      <DeviceApproveView initialCode={codeParam ?? ""} />
    </PageFrame>
  );
}
