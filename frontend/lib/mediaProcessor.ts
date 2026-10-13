import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  getAllActiveSessions,
  recordDownload,
  getSessionByDeviceId,
} from "./supabaseServer";

// Prepend Gyan FFmpeg if installed by winget
const FFMPEG_BIN =
  "C:\\Users\\Admin\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin";
if (fs.existsSync(FFMPEG_BIN)) {
  if (!process.env.PATH?.includes(FFMPEG_BIN)) {
    process.env.PATH = `${FFMPEG_BIN};${process.env.PATH}`;
  }
}

export const DOWNLOAD_DIR = path.join(process.cwd(), "downloads");
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

export function isValidMediaUrl(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return ["instagram.com", "instagr.am", "youtube.com", "m.youtube.com", "youtu.be"].includes(host);
  } catch {
    return false;
  }
}

export function isInstagramUrl(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return host === "instagram.com" || host === "instagr.am";
  } catch {
    return false;
  }
}

export function isInstagramReelUrl(value: string): boolean {
  if (!isInstagramUrl(value)) return false;
  try {
    const url = new URL(value);
    const p = url.pathname.toLowerCase();
    return (
      p.startsWith("/reel/") ||
      p.startsWith("/reels/") ||
      p.startsWith("/p/") ||
      p.startsWith("/tv/") ||
      p.startsWith("/stories/") ||
      p.startsWith("/share/") ||
      p.startsWith("/s/") ||
      p.includes("/reel") ||
      p.includes("/p/") ||
      p.includes("/stories/") ||
      p.includes("/s/") ||
      p.includes("highlight")
    );
  } catch {
    return false;
  }
}

/**
 * Fast audio extraction using ffmpeg
 */
export function extractAudio(videoPath: string, audioPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (fs.existsSync(audioPath)) return resolve(true);

    const ffmpegExe = fs.existsSync(path.join(FFMPEG_BIN, "ffmpeg.exe"))
      ? path.join(FFMPEG_BIN, "ffmpeg.exe")
      : "ffmpeg";

    const child = spawn(ffmpegExe, [
      "-i",
      videoPath,
      "-vn",
      "-c:a",
      "libmp3lame",
      "-q:a",
      "2",
      "-y",
      audioPath,
    ]);

    child.on("close", (code) => {
      resolve(code === 0 && fs.existsSync(audioPath));
    });

    child.on("error", () => {
      resolve(false);
    });
  });
}

/**
 * Download using Python Instaloader
 */
export function downloadWithInstaloader(url: string, sessionid?: string): Promise<any> {
  return new Promise((resolve) => {
    const scriptPath = path.join(process.cwd(), "scripts", "instaloader_downloader.py");
    const args = [scriptPath, url, DOWNLOAD_DIR];
    if (sessionid) {
      args.push(sessionid);
    }

    const pythonProcess = spawn("python", args);
    let stdout = "";
    let stderr = "";
    let isDone = false;

    const timer = setTimeout(() => {
      if (!isDone) {
        isDone = true;
        try {
          pythonProcess.kill();
        } catch {}
        resolve({
          success: false,
          error: "Download timeout: Media processing took longer than 25 seconds.",
        });
      }
    }, 25000);

    pythonProcess.stdout.on("data", (d) => {
      stdout += d.toString();
    });

    pythonProcess.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    pythonProcess.on("close", () => {
      if (isDone) return;
      isDone = true;
      clearTimeout(timer);

      try {
        const lines = stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean);
        let parsed = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const candidate = JSON.parse(lines[i]);
            if (candidate && typeof candidate === "object") {
              parsed = candidate;
              break;
            }
          } catch {}
        }
        if (parsed) {
          return resolve(parsed);
        }
        throw new Error("No JSON found");
      } catch {
        resolve({
          success: false,
          error: stderr || stdout || "Instaloader failed to extract media",
        });
      }
    });
  });
}

export interface ProcessMediaOptions {
  url: string;
  deviceId?: string;
  sessionid?: string;
  baseUrl?: string;
}

// In-memory cache for ultra-fast sub-millisecond responses
const mediaCache = new Map<string, { data: any; timestamp: number }>();

/**
 * Extracts shortcode from Instagram Reel, Post, or Share URL
 */
export function extractInstagramShortcode(value: string): string | null {
  if (!value || typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const p = url.pathname;
    const match = p.match(/(?:\/(?:reel|reels|p|tv)\/|\/share\/[^\/]+\/)([A-Za-z0-9_-]+)/i);
    if (match && match[1]) return match[1];
  } catch {}
  const match = value.match(/(?:\/(?:reel|reels|p|tv)\/|\/share\/[^\/]+\/)([A-Za-z0-9_-]+)/i);
  if (match && match[1]) return match[1];
  return null;
}

/**
 * Direct native Instagram GraphQL fetcher (sub-second response).
 * Bypasses heavy browser automation and yt-dlp delay.
 */
export async function fetchInstagramFast(
  shortcode: string,
  sessionTokens: string[] = []
): Promise<any> {
  const tokens = Array.from(new Set(sessionTokens.filter(Boolean)));
  if (tokens.length === 0) tokens.push("");

  for (const token of tokens) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);

      const cookieHeader = token
        ? `sessionid=${token}; csrftoken=missing`
        : `csrftoken=missing`;

      const res = await fetch("https://www.instagram.com/graphql/query", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          "X-IG-App-ID": "936619743392459",
          "X-CSRFToken": "missing",
          Referer: "https://www.instagram.com/",
          Cookie: cookieHeader,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          doc_id: "27128499623469141",
          variables: JSON.stringify({
            shortcode,
            __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false,
          }),
        }),
      });

      clearTimeout(timer);

      if (!res.ok) continue;

      const data = await res.json();
      const webInfo = data?.data?.xdt_api__v1__media__shortcode__web_info;
      const items = webInfo?.items;
      if (items && Array.isArray(items) && items.length > 0) {
        return items[0];
      }
    } catch {
      // Continue next session candidate
    }
  }

  return null;
}

/**
 * Universal media processor:
 * - Native Ultra-Fast GraphQL Engine (< 1s metadata, ~0.5s download)
 * - Instant Memory & Disk Cache (0 - 5ms)
 * - Direct Fast yt-dlp for YouTube
 * - Instant Audio extraction (MP3) in background
 * - Multi-media Instaloader engine for Stories & Highlights
 * - Supabase session pool fallback for private Instagram media
 */
export async function processMediaDownload({
  url,
  deviceId,
  sessionid,
  baseUrl = "",
}: ProcessMediaOptions) {
  if (!isValidMediaUrl(url)) {
    throw new Error("Invalid media URL. Please provide a valid link from Instagram or YouTube.");
  }

  const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");
  const isInstagram = isInstagramUrl(url);
  const isHighlight =
    isInstagram &&
    (url.toLowerCase().includes("/highlights/") ||
      url.toLowerCase().includes("highlight") ||
      url.toLowerCase().includes("/s/") ||
      /\/s\/[A-Za-z0-9_=-]+/i.test(url));
  const isStory =
    isInstagram &&
    url.toLowerCase().includes("/stories/") &&
    !isHighlight;

  // ⚡ INSTANT CACHE CHECK (0ms): If already downloaded or in memory, return immediately!
  if (isInstagram && !isHighlight && !isStory) {
    const shortcode = extractInstagramShortcode(url);
    if (shortcode) {
      // 1. Instant In-Memory Cache (0ms)
      const cached = mediaCache.get(shortcode);
      if (cached && Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) {
        const filePath = path.join(DOWNLOAD_DIR, cached.data.filename);
        if (fs.existsSync(filePath)) {
          console.log(`[Fast Engine] ⚡ Instant Memory Cache Hit for ${shortcode} (0ms)!`);
          return cached.data;
        }
      }

      // 2. Instant Disk Cache (2ms)
      const diskPath = path.join(DOWNLOAD_DIR, `${shortcode}.mp4`);
      if (fs.existsSync(diskPath)) {
        const stats = fs.statSync(diskPath);
        if (stats.size > 50 * 1024) {
          console.log(`[Fast Engine] ⚡ Instant Disk Cache Hit for ${shortcode} (2ms)!`);
          const filename = `${shortcode}.mp4`;
          const videoUrl = `${baseUrl}/api/file/${filename}`;
          const audioUrl = `${baseUrl}/api/file/${shortcode}.mp3`;
          const resData = {
            id: shortcode,
            filename,
            mediaType: "reel",
            contentType: "video/mp4",
            fileSize: stats.size,
            downloadUrl: videoUrl,
            videoUrl,
            audioUrl,
            hasAudio: true,
            preview: videoUrl,
          };
          mediaCache.set(shortcode, { data: resData, timestamp: Date.now() });
          return resData;
        }
      }
    }
  }

  // Retrieve device session from Supabase if not explicitly passed
  let activeSessionId = sessionid;
  if (!activeSessionId && deviceId && isInstagram) {
    try {
      const userSession = await getSessionByDeviceId(deviceId);
      if (userSession && userSession.sessionid) {
        activeSessionId = userSession.sessionid;
      }
    } catch {}
  }

  // Case A: Stories & Highlights -> Direct Multi-Media Engine
  if (isStory || isHighlight) {
    return executePrivateDownload({
      url,
      sessionid: activeSessionId,
      deviceId,
      baseUrl,
    });
  }

  // Case B: Instagram Reels & Posts -> Ultra-Fast Native GraphQL Engine
  if (isInstagram) {
    const shortcode = extractInstagramShortcode(url);
    if (shortcode) {
      // 3. Fast Native GraphQL Extraction (~700ms)
      const sessionTokens: string[] = [];
      if (activeSessionId) sessionTokens.push(activeSessionId);
      try {
        const pool = await getAllActiveSessions(deviceId);
        for (const s of pool) {
          if (s.sessionid && !sessionTokens.includes(s.sessionid)) {
            sessionTokens.push(s.sessionid);
          }
        }
      } catch {}

      console.log(`[Fast Engine] Querying Instagram GraphQL for ${shortcode}...`);
      const item = await fetchInstagramFast(shortcode, sessionTokens);

      if (item) {
        // --- B1. Carousel Album ---
        if (item.carousel_media && Array.isArray(item.carousel_media) && item.carousel_media.length > 0) {
          console.log(`[Fast Engine] Detected carousel with ${item.carousel_media.length} items`);
          const carouselItems: any[] = [];
          let idx = 1;
          for (const c of item.carousel_media) {
            const isVid = c.is_video || (c.video_versions && c.video_versions.length > 0);
            const mediaCdnUrl = isVid
              ? c.video_versions?.[0]?.url
              : c.image_versions2?.candidates?.[0]?.url;
            const previewCdn = c.image_versions2?.candidates?.[0]?.url || mediaCdnUrl;
            const ext = isVid ? "mp4" : "jpg";
            const itemFilename = `${shortcode}_${idx}.${ext}`;
            const itemFilePath = path.join(DOWNLOAD_DIR, itemFilename);

            carouselItems.push({
              index: idx,
              type: isVid ? "video" : "image",
              filename: itemFilename,
              downloadUrl: `${baseUrl}/api/file/${itemFilename}`,
              previewUrl: previewCdn || `${baseUrl}/api/file/${itemFilename}`,
              cdnUrl: mediaCdnUrl,
              filePath: itemFilePath,
            });
            idx++;
          }

          // Concurrently download carousel items via fast stream
          await Promise.all(
            carouselItems.map(async (ci) => {
              try {
                if (!fs.existsSync(ci.filePath) && ci.cdnUrl) {
                  const resp = await fetch(ci.cdnUrl, {
                    headers: {
                      "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                      Referer: "https://www.instagram.com/",
                    },
                  });
                  if (resp.ok) {
                    const buf = await resp.arrayBuffer();
                    fs.writeFileSync(ci.filePath, Buffer.from(buf));
                    ci.fileSize = buf.byteLength;
                  }
                } else if (fs.existsSync(ci.filePath)) {
                  ci.fileSize = fs.statSync(ci.filePath).size;
                }
              } catch {}
            })
          );

          const totalSize = carouselItems.reduce((acc, it) => acc + (it.fileSize || 0), 0);
          const resultData = {
            id: shortcode,
            mediaType: "carousel",
            contentType: carouselItems[0]?.type === "video" ? "video/mp4" : "image/jpeg",
            filename: carouselItems[0]?.filename || `${shortcode}.jpg`,
            fileSize: totalSize,
            mediaCount: carouselItems.length,
            items: carouselItems.map(({ filePath, cdnUrl, ...rest }) => rest),
            owner: item.user?.username || "creator",
            caption: item.caption?.text || "",
            preview: carouselItems[0]?.previewUrl,
            downloadUrl: carouselItems[0]?.downloadUrl,
            videoUrl: carouselItems[0]?.downloadUrl,
            hasAudio: carouselItems.some((ci) => ci.type === "video"),
          };
          mediaCache.set(shortcode, { data: resultData, timestamp: Date.now() });
          return resultData;
        }

        // --- B2. Single Photo ---
        if (!item.is_video && (!item.video_versions || item.video_versions.length === 0)) {
          const photoUrl = item.image_versions2?.candidates?.[0]?.url;
          const photoFilename = `${shortcode}.jpg`;
          const photoPath = path.join(DOWNLOAD_DIR, photoFilename);
          if (photoUrl) {
            const photoResp = await fetch(photoUrl, {
              headers: {
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                Referer: "https://www.instagram.com/",
              },
            });
            if (photoResp.ok) {
              const buf = await photoResp.arrayBuffer();
              fs.writeFileSync(photoPath, Buffer.from(buf));
              const stats = fs.statSync(photoPath);
              const downloadUrl = `${baseUrl}/api/file/${photoFilename}`;
              const resultData = {
                id: shortcode,
                mediaType: "photo",
                contentType: "image/jpeg",
                filename: photoFilename,
                fileSize: stats.size,
                downloadUrl,
                preview: photoUrl || downloadUrl,
                owner: item.user?.username || "creator",
                caption: item.caption?.text || "",
              };
              mediaCache.set(shortcode, { data: resultData, timestamp: Date.now() });
              return resultData;
            }
          }
        }

        // --- B3. Single Reel / Video ---
        if (item.video_versions && item.video_versions.length > 0) {
          const cdnVideoUrl = item.video_versions[0].url;
          const cdnPreviewUrl = item.image_versions2?.candidates?.[0]?.url || cdnVideoUrl;
          const targetFilename = `${shortcode}.mp4`;
          const targetPath = path.join(DOWNLOAD_DIR, targetFilename);
          const audioFilename = `${shortcode}.mp3`;
          const audioPath = path.join(DOWNLOAD_DIR, audioFilename);

          console.log(`[Fast Engine] Streaming video directly from CDN for ${shortcode}...`);
          const videoResp = await fetch(cdnVideoUrl, {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
              Referer: "https://www.instagram.com/",
            },
          });

          if (videoResp.ok) {
            const buf = await videoResp.arrayBuffer();
            fs.writeFileSync(targetPath, Buffer.from(buf));
            const stats = fs.statSync(targetPath);
            const videoUrl = `${baseUrl}/api/file/${targetFilename}`;
            const audioUrl = `${baseUrl}/api/file/${audioFilename}`;

            // Background non-blocking audio conversion
            extractAudio(targetPath, audioPath).catch(() => {});

            // Background non-blocking Supabase logging
            recordDownload({
              deviceId,
              url,
              title: "Instagram Reel",
              mediaType: "reel",
              format: "MP4",
              quality: "HD",
              filename: targetFilename,
              fileSize: stats.size,
              downloadUrl: videoUrl,
              owner: item.user?.username,
              caption: item.caption?.text,
            }).catch(() => {});

            const resultData = {
              id: shortcode,
              filename: targetFilename,
              mediaType: "reel",
              contentType: "video/mp4",
              fileSize: stats.size,
              downloadUrl: videoUrl,
              videoUrl,
              audioUrl,
              hasAudio: true,
              preview: cdnPreviewUrl || videoUrl,
              owner: item.user?.username,
              caption: item.caption?.text,
            };

            mediaCache.set(shortcode, { data: resultData, timestamp: Date.now() });
            console.log(`[Fast Engine] ⚡ Done! Returning ${shortcode} in record time.`);
            return resultData;
          }
        }
      }
    }

    // Fallback to private engine for Instagram link
    console.log(`[Next.js API] Falling back to private engine for Instagram link...`);
    return executePrivateDownload({
      url,
      sessionid: activeSessionId,
      deviceId,
      baseUrl,
    });
  }

  // Case C: YouTube Videos (Direct fast yt-dlp)
  const id = crypto.randomUUID();
  const outputTemplate = path.join(DOWNLOAD_DIR, `${id}.%(ext)s`);
  const outputFile = path.join(DOWNLOAD_DIR, `${id}.mp4`);
  const audioFile = path.join(DOWNLOAD_DIR, `${id}.mp3`);

  const args = [
    "-f",
    "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
    "--merge-output-format",
    "mp4",
    "--no-playlist",
    "--concurrent-fragments",
    "4",
    "-o",
    outputTemplate,
    url,
  ];

  console.log(`[Next.js API] Processing YouTube download: ${url} (ID: ${id})`);

  const downloadResult = await new Promise<{ success: boolean; error?: string }>((resolve) => {
    const child = spawn("yt-dlp", args);
    let stderr = "";

    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: stderr });
      }
    });
  });

  if (!downloadResult.success) {
    throw new Error(downloadResult.error || "Failed to download video.");
  }

  // Check generated file
  let finalFilePath = outputFile;
  if (!fs.existsSync(outputFile)) {
    const matching = fs
      .readdirSync(DOWNLOAD_DIR)
      .filter((file) => file.startsWith(id));
    if (matching.length === 0) {
      throw new Error("Output media file was not generated.");
    }
    finalFilePath = path.join(DOWNLOAD_DIR, matching[0]);
  }

  const stats = fs.statSync(finalFilePath);
  const filename = path.basename(finalFilePath);
  const videoUrl = `${baseUrl}/api/file/${filename}`;
  const audioUrl = `${baseUrl}/api/file/${id}.mp3`;

  // Pre-extract audio in background
  extractAudio(finalFilePath, audioFile).catch(() => {});

  // Record in Supabase
  await recordDownload({
    deviceId,
    url,
    title: isYouTube ? "YouTube Video" : "Instagram Reel",
    mediaType: isYouTube ? "youtube" : "reel",
    format: "MP4",
    quality: "HD",
    filename,
    fileSize: stats.size,
    downloadUrl: videoUrl,
  });

  return {
    id,
    filename,
    mediaType: isYouTube ? "youtube" : "reel",
    contentType: "video/mp4",
    fileSize: stats.size,
    downloadUrl: videoUrl,
    videoUrl,
    audioUrl,
    hasAudio: true,
    preview: videoUrl,
  };
}

/**
 * Private Instagram / Stories / Highlights engine with Supabase session pool
 */
export async function executePrivateDownload({
  url,
  sessionid,
  deviceId,
  baseUrl = "",
}: {
  url: string;
  sessionid?: string;
  deviceId?: string;
  baseUrl?: string;
}) {
  const id = crypto.randomUUID();
  const sessionCandidates: Array<{ sessionid: string; username: string }> = [];
  const seenSessions = new Set<string>();

  function addCandidate(token?: string | null, username = "Connected User") {
    if (!token || typeof token !== "string") return;
    const clean = token.trim().replace(/^sessionid=/, "");
    if (
      clean.length > 15 &&
      !clean.startsWith("mobile_") &&
      !clean.startsWith("session_live_test") &&
      !clean.includes("test_") &&
      clean !== "undefined" &&
      clean !== "null" &&
      !seenSessions.has(clean)
    ) {
      seenSessions.add(clean);
      sessionCandidates.push({ sessionid: clean, username });
    }
  }

  if (sessionid) {
    addCandidate(sessionid, "Request Session");
  }

  // Load active sessions from Supabase
  try {
    const pool = await getAllActiveSessions(deviceId);
    for (const s of pool) {
      addCandidate(
        s.sessionid,
        s.username || (s.ds_user_id ? `User ${s.ds_user_id}` : "Supabase User")
      );
    }
  } catch (err: any) {
    console.warn(`[Next.js API] Supabase session pool error:`, err.message);
  }

  // If no remote Supabase sessions, allow Instaloader to auto-extract device browser cookies
  if (sessionCandidates.length === 0) {
    sessionCandidates.push({ sessionid: "", username: "Device Browser" });
  }

  let lastError = "";

  // 1. Try Instaloader with candidate sessions
  for (let i = 0; i < sessionCandidates.length; i++) {
    const candidate = sessionCandidates[i];
    console.log(
      `[Supabase Pool] Trying session ${i + 1}/${sessionCandidates.length} (@${candidate.username})...`
    );

    const instaloaderRes = await downloadWithInstaloader(url, candidate.sessionid);
    if (instaloaderRes && instaloaderRes.success) {
      const filename = instaloaderRes.filename;
      const downloadUrl = `${baseUrl}/api/file/${filename}`;
      const matchedAccount = instaloaderRes.accountUsed || candidate.username;
      const mediaType = instaloaderRes.mediaType || "video";

      let formattedItems = null;
      if (instaloaderRes.items && Array.isArray(instaloaderRes.items)) {
        formattedItems = instaloaderRes.items.map((item: any) => ({
          index: item.index,
          type: item.type || "image",
          filename: item.filename,
          fileSize: item.fileSize,
          downloadUrl: `${baseUrl}/api/file/${item.filename}`,
          previewUrl: `${baseUrl}/api/file/${item.filename}`,
          originalPreview: item.preview,
        }));
      }

      const mediaLabel =
        mediaType === "carousel"
          ? `Carousel Album (${instaloaderRes.mediaCount || formattedItems?.length || 1} items)`
          : mediaType === "highlight"
          ? `Story Highlight (${instaloaderRes.mediaCount || formattedItems?.length || 1} items)`
          : mediaType === "photo"
          ? "Photo"
          : mediaType === "story"
          ? "Story"
          : "Reel";

      const finalFilePath = path.join(DOWNLOAD_DIR, filename);
      let audioUrl: string | undefined = undefined;
      const audioFilename = `${path.parse(filename).name}.mp3`;
      const audioFilePath = path.join(DOWNLOAD_DIR, audioFilename);

      if (mediaType === "reel" || mediaType === "video" || filename.endsWith(".mp4")) {
        extractAudio(finalFilePath, audioFilePath).catch(() => {});
        audioUrl = `${baseUrl}/api/file/${audioFilename}`;
      }

      // Record in Supabase
      await recordDownload({
        deviceId,
        url,
        title: mediaLabel,
        mediaType,
        filename,
        fileSize: instaloaderRes.fileSize,
        owner: instaloaderRes.owner,
        caption: instaloaderRes.caption,
        downloadUrl,
        accountUsed: matchedAccount,
      });

      return {
        id: instaloaderRes.shortcode || instaloaderRes.highlightId || id,
        mediaType,
        contentType:
          instaloaderRes.contentType || (mediaType === "photo" ? "image/jpeg" : "video/mp4"),
        filename,
        highlightId: instaloaderRes.highlightId,
        highlightTitle: instaloaderRes.highlightTitle,
        mediaCount:
          instaloaderRes.mediaCount || (formattedItems ? formattedItems.length : 1),
        items: formattedItems,
        browserUsed: `Account: @${matchedAccount}`,
        accountUsed: matchedAccount,
        owner: instaloaderRes.owner,
        caption: instaloaderRes.caption,
        preview: instaloaderRes.preview || downloadUrl,
        fileSize: instaloaderRes.fileSize,
        downloadUrl,
        videoUrl: downloadUrl,
        audioUrl,
        hasAudio: Boolean(audioUrl),
      };
    } else {
      lastError = instaloaderRes?.error || "Access denied";
    }
  }

  // 2. yt-dlp cookie fallback for Reels
  const isStory = url.toLowerCase().includes("/stories/");
  if (!isStory) {
    for (let i = 0; i < sessionCandidates.length; i++) {
      const candidate = sessionCandidates[i];
      const tempCookieFile = path.join(DOWNLOAD_DIR, `cookie_${id}_${i}.txt`);
      const netscapeContent = `# Netscape HTTP Cookie File\n.instagram.com\tTRUE\t/\tTRUE\t2147483647\tsessionid\t${candidate.sessionid}\n`;
      fs.writeFileSync(tempCookieFile, netscapeContent, "utf8");

      const outputTemplate = path.join(DOWNLOAD_DIR, `${id}.%(ext)s`);
      const outputFile = path.join(DOWNLOAD_DIR, `${id}.mp4`);
      const audioFile = path.join(DOWNLOAD_DIR, `${id}.mp3`);

      const args = [
        "-f",
        "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
        "--merge-output-format",
        "mp4",
        "--no-playlist",
        "--cookies",
        tempCookieFile,
        "-o",
        outputTemplate,
        url,
      ];

      const ytExit = await new Promise<number>((r) => {
        const child = spawn("yt-dlp", args);
        child.on("close", (code) => r(code || 0));
        child.on("error", () => r(1));
      });

      try {
        fs.unlinkSync(tempCookieFile);
      } catch {}

      if (ytExit === 0 && fs.existsSync(outputFile)) {
        const stats = fs.statSync(outputFile);
        if (stats.size > 100 * 1024) {
          const filename = path.basename(outputFile);
          const videoUrl = `${baseUrl}/api/file/${filename}`;
          const audioUrl = `${baseUrl}/api/file/${id}.mp3`;

          extractAudio(outputFile, audioFile).catch(() => {});

          await recordDownload({
            deviceId,
            url,
            title: "Instagram Reel",
            mediaType: "reel",
            format: "MP4",
            quality: "HD",
            filename,
            fileSize: stats.size,
            downloadUrl: videoUrl,
            accountUsed: candidate.username,
          });

          return {
            id,
            filename,
            browserUsed: `Session: @${candidate.username}`,
            accountUsed: candidate.username,
            mediaType: "reel",
            contentType: "video/mp4",
            fileSize: stats.size,
            downloadUrl: videoUrl,
            videoUrl,
            audioUrl,
            hasAudio: true,
            preview: videoUrl,
          };
        }
      }
    }
  }

  const validNames = sessionCandidates
    .filter((c) => c.sessionid && c.username !== "Device Browser")
    .map((c) => `@${c.username}`);

  if (lastError && !lastError.includes("None of the active accounts")) {
    throw new Error(lastError);
  }

  if (validNames.length > 0) {
    throw new Error(
      `Access Denied: Connected accounts (${validNames.join(", ")}) do not have permission to view this private story or highlight. Please make sure your connected Instagram account follows this private profile.`
    );
  }

  throw new Error(
    "Instagram Restriction: Instagram requires a connected account session to view and download Story Highlights (even on public accounts). Please click 'Connect Account' in the header to paste your sessionid or log in."
  );
}
