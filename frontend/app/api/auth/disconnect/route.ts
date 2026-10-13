import { NextRequest, NextResponse } from "next/server";
import { disconnectSession } from "@/lib/supabaseServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    let deviceId = req.headers.get("x-device-id");
    try {
      const body = await req.json();
      if (body?.deviceId) deviceId = body.deviceId;
    } catch {}

    if (!deviceId) {
      return NextResponse.json(
        { success: false, error: "Device identifier is required." },
        { status: 400 }
      );
    }

    const removed = await disconnectSession(deviceId);
    return NextResponse.json({
      success: true,
      message: removed
        ? "Session disconnected successfully in Supabase."
        : "No active session found for this device.",
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 }
    );
  }
}
