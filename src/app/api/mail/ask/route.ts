import { z } from "zod";
import { authenticated } from "@/lib/email/api";
import { askEzra } from "@/lib/email/professional";

export const runtime = "nodejs";

const schema = z.object({ query: z.string().trim().min(2).max(500) });

export async function POST(request: Request) {
  return authenticated(request, async () => {
    const body = schema.parse(await request.json());
    return askEzra(body.query);
  });
}
