import { ChromeGate } from "@/components/layout/chrome-gate";
import { getSiteSettings } from "@/lib/settings";

export async function SiteChrome({ children }: { children: React.ReactNode }) {
  const settings = await getSiteSettings();
  return <ChromeGate settings={settings}>{children}</ChromeGate>;
}
