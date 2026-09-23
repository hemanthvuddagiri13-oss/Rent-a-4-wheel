import { mobileHandler } from "@/lib/mobile/http";
import { mobileQuery } from "@/lib/mobile/queries";
import { mobileCommand } from "@/lib/mobile/commands";

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return mobileHandler(req, "query", () => mobileQuery(req, path));
}
export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return mobileHandler(req, "mutation", () => mobileCommand(req, path));
}
