import { NextRequest, NextResponse } from "next/server";
import { getSessionByDeviceId } from "@/lib/supabaseServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const deviceId =
      req.headers.get("x-device-id") ||
      req.nextUrl.searchParams.get("deviceId");

    if (!deviceId) {
      return NextResponse.json({
        success: true,
        loggedIn: false,
        account: null,
      });
    }

    const session = await getSessionByDeviceId(deviceId);

    return NextResponse.json({
      success: true,
      loggedIn: Boolean(session && session.isActive),
      account: session ? session.username : null,
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 }
    );
  }
}
