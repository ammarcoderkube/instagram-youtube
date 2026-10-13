import { NextRequest, NextResponse } from "next/server";
import { upsertSession } from "@/lib/supabaseServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sessionid } = body;
    const deviceId = req.headers.get("x-device-id") || body.deviceId;

    if (!sessionid || typeof sessionid !== "string" || !sessionid.trim()) {
      return NextResponse.json(
        { success: false, error: "Provide a valid 'sessionid' string." },
        { status: 400 }
      );
    }

    if (!deviceId) {
      return NextResponse.json(
        { success: false, error: "Device identifier is required." },
        { status: 400 }
      );
    }

    const doc = await upsertSession(deviceId, "Custom Session", sessionid);
    return NextResponse.json({
      success: true,
      message: "Instagram session saved successfully in Supabase for this device.",
      account: doc.username,
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: `Failed to save session: ${err.message}` },
      { status: 500 }
    );
  }
}
