import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { DOWNLOAD_DIR, extractAudio } from "@/lib/mediaProcessor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  try {
    const { filename } = await params;
    const cleanFilename = path.basename(filename);
    const filePath = path.join(DOWNLOAD_DIR, cleanFilename);
    const ext = path.extname(cleanFilename).toLowerCase();
    const baseId = path.parse(cleanFilename).name;

    // On-demand audio conversion if .mp3 requested but not yet generated
    if (ext === ".mp3" && !fs.existsSync(filePath)) {
      const mp4Candidate = path.join(DOWNLOAD_DIR, `${baseId}.mp4`);
      if (fs.existsSync(mp4Candidate)) {
        console.log(`[Next.js API] On-demand MP3 audio conversion for ${cleanFilename}...`);
        await extractAudio(mp4Candidate, filePath);
      }
    }

    if (!fs.existsSync(filePath)) {
      return NextResponse.json(
        { success: false, error: "File not found or expired from temporary storage." },
        { status: 404 }
      );
    }

    const stats = fs.statSync(filePath);
    const fileSize = stats.size;

    let contentType = "application/octet-stream";
    if (ext === ".mp4") contentType = "video/mp4";
    else if (ext === ".mp3") contentType = "audio/mpeg";
    else if (ext === ".webm") contentType = "video/webm";
    else if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
    else if (ext === ".png") contentType = "image/png";
    else if (ext === ".webp") contentType = "image/webp";

    const isDownload = req.nextUrl.searchParams.get("download") === "true";
    const downloadName = ext === ".mp3" ? `reel-audio-${baseId}.mp3` : `linkly-${cleanFilename}`;

    // Handle HTTP Range header for video / audio streaming
    const rangeHeader = req.headers.get("range");
    if (rangeHeader && (contentType.startsWith("video/") || contentType.startsWith("audio/"))) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const fileStream = fs.createReadStream(filePath, { start, end });
      // Convert node ReadStream to web ReadableStream
      const stream = new ReadableStream({
        start(controller) {
          fileStream.on("data", (chunk) => controller.enqueue(chunk));
          fileStream.on("end", () => controller.close());
          fileStream.on("error", (err) => controller.error(err));
        },
        cancel() {
          fileStream.destroy();
        },
      });

      const headers = new Headers();
      headers.set("Content-Range", `bytes ${start}-${end}/${fileSize}`);
      headers.set("Accept-Ranges", "bytes");
      headers.set("Content-Length", chunkSize.toString());
      headers.set("Content-Type", contentType);
      if (isDownload) {
        headers.set("Content-Disposition", `attachment; filename="${downloadName}"`);
      }

      return new NextResponse(stream, {
        status: 206,
        headers,
      });
    }

    // Full file stream
    const fileStream = fs.createReadStream(filePath);
    const stream = new ReadableStream({
      start(controller) {
        fileStream.on("data", (chunk) => controller.enqueue(chunk));
        fileStream.on("end", () => controller.close());
        fileStream.on("error", (err) => controller.error(err));
      },
      cancel() {
        fileStream.destroy();
      },
    });

    const headers = new Headers();
    headers.set("Content-Length", fileSize.toString());
    headers.set("Content-Type", contentType);
    headers.set("Accept-Ranges", "bytes");
    if (isDownload) {
      headers.set("Content-Disposition", `attachment; filename="${downloadName}"`);
    }

    return new NextResponse(stream, {
      status: 200,
      headers,
    });
  } catch (err: any) {
    console.error("[File Route Error]:", err.message);
    return NextResponse.json(
      { success: false, error: "Failed to read requested file" },
      { status: 500 }
    );
  }
}

export const HEAD = GET;
