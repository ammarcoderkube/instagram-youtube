import { NextRequest, NextResponse } from "next/server";
import { getRecentDownloads } from "@/lib/supabaseServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const deviceId =
      req.headers.get("x-device-id") ||
      req.nextUrl.searchParams.get("deviceId");

    if (!deviceId) {
      return NextResponse.json({ success: true, data: [] });
    }

    const history = await getRecentDownloads(deviceId);
    return NextResponse.json({ success: true, data: history });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 }
    );
  }
}
