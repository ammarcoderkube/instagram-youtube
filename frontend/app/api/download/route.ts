import { NextRequest, NextResponse } from "next/server";
import { processMediaDownload } from "@/lib/mediaProcessor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { url, sessionid } = body;
    const deviceId = req.headers.get("x-device-id") || body.deviceId;

    if (!url || typeof url !== "string") {
      return NextResponse.json(
        { success: false, error: "Media URL is required." },
        { status: 400 }
      );
    }

    console.log(`[Download Request URL]:`, url);

    const host = req.headers.get("host") || "localhost:5173";
    const protocol = req.headers.get("x-forwarded-proto") || "http";
    const baseUrl = `${protocol}://${host}`;

    const data = await processMediaDownload({
      url,
      deviceId: deviceId || undefined,
      sessionid: sessionid || undefined,
      baseUrl,
    });

    return NextResponse.json({
      success: true,
      message: "Media processed successfully",
      data,
    });
  } catch (err: any) {
    console.error("[Download API Error]:", err.message);
    const isAuthError = err.message?.includes("Authentication Required");
    return NextResponse.json(
      {
        success: false,
        error: err.message || "Failed to process download request.",
      },
      { status: isAuthError ? 401 : 500 }
    );
  }
}
