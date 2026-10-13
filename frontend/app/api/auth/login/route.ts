import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import { upsertSession } from "@/lib/supabaseServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { username, password, verificationCode } = body;
    const deviceId = req.headers.get("x-device-id") || body.deviceId;

    if (!username || !password) {
      return NextResponse.json(
        { success: false, error: "Username and password are required." },
        { status: 400 }
      );
    }

    const scriptPath = path.join(process.cwd(), "scripts", "instaloader_downloader.py");
    const pythonProcess = spawn("python", [scriptPath, "--account-login-stdin"]);

    pythonProcess.stdin.write(JSON.stringify({ username, password, verificationCode }));
    pythonProcess.stdin.end();

    let stdout = "";
    let stderr = "";

    pythonProcess.stdout.on("data", (d) => {
      stdout += d.toString();
    });

    pythonProcess.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    const parsed = await new Promise<any>((resolve) => {
      pythonProcess.on("close", () => {
        try {
          const match = stdout.match(/\{[\s\S]*\}/);
          if (match) {
            return resolve(JSON.parse(match[0]));
          }
          return resolve(JSON.parse(stdout.trim()));
        } catch {
          resolve(null);
        }
      });
    });

    if (parsed && typeof parsed === "object") {
      if (parsed.success && parsed.sessionid && deviceId) {
        await upsertSession(deviceId, parsed.account || username, parsed.sessionid);
      }
      return NextResponse.json(parsed);
    }

    return NextResponse.json(
      {
        success: false,
        error: stderr || stdout || "Authentication failed. Please verify credentials.",
      },
      { status: 401 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: `Login error: ${err.message}` },
      { status: 500 }
    );
  }
}
