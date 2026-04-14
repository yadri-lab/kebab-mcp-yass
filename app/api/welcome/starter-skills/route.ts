import { NextResponse } from "next/server";
import { checkAdminAuth } from "@/core/auth";
import { STARTER_SKILLS } from "@/core/starter-skills";
import { createSkill } from "@/connectors/skills/store";

/**
 * GET  /api/welcome/starter-skills              → list curated starter skills
 * POST /api/welcome/starter-skills  { id }      → install a starter skill into the user's store
 *
 * Auth: same as other admin routes. The /welcome flow has just minted a
 * permanent token by this point, so checkAdminAuth's claim-cookie or
 * Authorization header path will accept the request.
 */

export async function GET(request: Request) {
  const authError = checkAdminAuth(request);
  if (authError) return authError;
  return NextResponse.json({ skills: STARTER_SKILLS });
}

export async function POST(request: Request) {
  const authError = checkAdminAuth(request);
  if (authError) return authError;

  let body: { id?: string };
  try {
    body = (await request.json()) as { id?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const starter = STARTER_SKILLS.find((s) => s.id === body.id);
  if (!starter) {
    return NextResponse.json({ ok: false, error: "Unknown starter skill" }, { status: 404 });
  }

  try {
    const created = await createSkill({
      name: starter.name,
      description: starter.description,
      content: starter.content,
      arguments: starter.arguments,
      source: { type: "inline" },
    });
    return NextResponse.json({ ok: true, id: created.id });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : "Save failed",
    });
  }
}
