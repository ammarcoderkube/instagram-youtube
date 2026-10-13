"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  Clapperboard,
  Clipboard,
  Download,
  Heart,
  Instagram,
  Link2,
  Menu,
  Play,
  ShieldCheck,
  Sparkles,
  Star,
  X,
  Youtube,
  Zap,
  Loader2,
  Key,
  Copy,
  Music,
  Video,
  Film
} from "lucide-react";

interface MediaItem {
  index: number;
  type: "video" | "image";
  filename: string;
  fileSize: number;
  downloadUrl: string;
  previewUrl: string;
}

interface DownloadResult {
  id: string;
  filename: string;
  downloadUrl: string;
  videoUrl?: string;
  audioUrl?: string;
  hasAudio?: boolean;
  fileSize?: number;
  mediaType?: "reel" | "story" | "highlight" | "photo" | "carousel" | "youtube" | "video";
  contentType?: string;
  owner?: string;
  caption?: string;
  accountUsed?: string;
  items?: MediaItem[];
  mediaCount?: number;
  preview?: string;
}

const platforms = [
  { name: "Instagram Reels", short: "Reels", detail: "Keep the good ones", icon: Clapperboard, tone: "reels" },
  { name: "Instagram Stories", short: "Stories", detail: "More than 24 hours", icon: Instagram, tone: "stories" },
  { name: "Instagram Highlights", short: "Highlights", detail: "Save every collection", icon: Star, tone: "highlights" },
  { name: "YouTube Videos", short: "YouTube", detail: "Watch on your terms", icon: Youtube, tone: "youtube" },
];

const faqs = [
  ["Which links are supported?", "Linkly supports public and private Instagram Reels, Posts, Stories, Highlights, and Carousel Albums, plus YouTube video and Shorts links."],
  ["How does the Reel video and audio feature work?", "When you paste an Instagram Reel, Linkly immediately provides both the HD Video (MP4) and the extracted Audio (MP3) format so you can choose which one to save."],
  ["Can I download all videos from an Instagram Highlight?", "Yes! When you paste a highlight link, Linkly extracts every video and photo in that collection, allowing you to preview and download each one individually or all at once."],
  ["Can I download private Instagram content?", "Yes. Connect your Instagram account via 'Account / Session' settings. Linkly securely uses your session to download reels, stories, and carousels you have access to, with zero tracking."],
  ["Where are downloaded files saved?", "Downloaded videos and audio files are directly saved to your device's default Downloads folder."],
];

export default function Home() {
  const [platform, setPlatform] = useState(0);
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState("");
  const [sample, setSample] = useState(false);
  const [menu, setMenu] = useState(false);
  const [faq, setFaq] = useState<number | null>(null);

  // Download & State Management
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DownloadResult | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [authAccount, setAuthAccount] = useState<string | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);

  // Auth Modal State
  const [authTab, setAuthTab] = useState<"direct" | "cookie">("cookie");
  const [loginUser, setLoginUser] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [login2FA, setLogin2FA] = useState("");
  const [cookieSession, setCookieSession] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const resultRef = useRef<HTMLDivElement>(null);

  // Initialize Device ID & load authentication status
  useEffect(() => {
    let id = localStorage.getItem("linkly_device_id");
    if (!id) {
      id = "device_" + Math.random().toString(36).substring(2, 12) + Date.now().toString(36);
      localStorage.setItem("linkly_device_id", id);
    }
    setDeviceId(id);

    // Check auth status from Next.js + Supabase API
    fetch(`/api/auth/status`, {
      headers: { "x-device-id": id }
    })
      .then(r => r.json())
      .then(d => {
        if (d.success && d.loggedIn && d.account) {
          setAuthAccount(d.account);
        }
      })
      .catch(() => {});
  }, []);

  const triggerDownload = (downloadUrl: string, filename: string) => {
    const a = document.createElement("a");
    a.href = `${downloadUrl}?download=true`;
    a.download = filename || "linkly-media.mp4";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const handleDownloadAll = async (items: MediaItem[]) => {
    for (const item of items) {
      triggerDownload(item.downloadUrl, item.filename);
      await new Promise(r => setTimeout(r, 450));
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!url.trim()) {
      setMessage("Add a video or reel link to continue.");
      return;
    }

    try {
      const parsed = new URL(url);
      const parsedHost = parsed.hostname.replace(/^www\./, "");
      if (!["instagram.com", "instagr.am", "youtube.com", "m.youtube.com", "youtu.be"].includes(parsedHost)) {
        setMessage("Please enter a valid Instagram or YouTube link.");
        return;
      }
    } catch {
      setMessage("Please enter a complete Instagram or YouTube link.");
      return;
    }

    setLoading(true);
    setMessage("");
    setResult(null);

    try {
      const response = await fetch("/api/download", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-id": deviceId
        },
        body: JSON.stringify({
          url,
          deviceId
        })
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || "Failed to download media.");
      }

      setResult(data.data);
      setMessage(`🎉 Media ready! Choose your format below.`);

      // Smooth scroll to result
      setTimeout(() => {
        resultRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }, 100);

    } catch (err: any) {
      setMessage(`❌ ${err.message || "Failed to process download"}`);
    } finally {
      setLoading(false);
    }
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        setUrl(text.trim());
        setMessage("");
      }
    } catch {
      setMessage("Clipboard access unavailable. Please paste directly into the field.");
    }
  };

  const handleConnectAccount = async () => {
    if (!loginUser || !loginPass) {
      alert("Please enter Instagram username and password.");
      return;
    }
    setAuthLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-id": deviceId
        },
        body: JSON.stringify({
          username: loginUser,
          password: loginPass,
          verificationCode: login2FA || undefined,
          deviceId
        })
      });
      const data = await res.json();
      if (data.success && data.account) {
        setAuthAccount(data.account);
        alert(`🎉 Connected successfully as @${data.account}!`);
        setShowAuthModal(false);
      } else {
        alert(data.error || "Authentication failed. Check your credentials.");
      }
    } catch (e: any) {
      alert(`Network error: ${e.message}`);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSaveCookie = async () => {
    if (!cookieSession.trim()) {
      alert("Please enter a valid sessionid cookie.");
      return;
    }
    setAuthLoading(true);
    try {
      const res = await fetch("/api/auth/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-id": deviceId
        },
        body: JSON.stringify({
          sessionid: cookieSession.trim(),
          deviceId
        })
      });
      const data = await res.json();
      if (data.success) {
        setAuthAccount(data.account || "Connected Session");
        alert("✅ Session cookie saved successfully!");
        setShowAuthModal(false);
      } else {
        alert(data.error || "Failed to save cookie.");
      }
    } catch (e: any) {
      alert(`Network error: ${e.message}`);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm("Disconnect active Instagram session from this device?")) return;
    try {
      await fetch("/api/auth/disconnect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-id": deviceId
        },
        body: JSON.stringify({ deviceId })
      });
      setAuthAccount(null);
      alert("Session disconnected.");
      setShowAuthModal(false);
    } catch {}
  };

  const isHighlight =
    result &&
    (result.mediaType === "highlight" ||
      Boolean(result.highlightId) ||
      (result.items &&
        result.items.length > 0 &&
        (url.includes("/highlights/") ||
          url.includes("/s/") ||
          url.includes("highlight") ||
          platform === 2)));
  const isStory =
    result &&
    !isHighlight &&
    (result.mediaType === "story" || (url.includes("/stories/") && !url.includes("highlight")));
  const isReel =
    result &&
    !isHighlight &&
    !isStory &&
    (result.mediaType === "reel" ||
      result.mediaType === "video" ||
      result.hasAudio ||
      url.includes("/reel/") ||
      url.includes("/reels/") ||
      platform === 0);

  return (
    <div className="site-shell">
      {/* HEADER */}
      <header className="site-header">
        <a className="wordmark" href="/" aria-label="Linkly home">
          <span className="brand-icon">
            <ArrowDownToLine />
          </span>
          linkly<span className="brand-dot">.</span>
        </a>

        <nav className="desktop-nav" aria-label="Main navigation">
          <a href="#downloader" className="nav-current">Downloader</a>
          <a href="#formats">Formats</a>
          <a href="#faq">FAQs</a>
        </nav>

        <div className="header-end">
          {authAccount ? (
            <button
              onClick={() => setShowAuthModal(true)}
              className="free-label"
              style={{ background: "none", border: 0, cursor: "pointer", color: "var(--primary)" }}
              title="Instagram Account Connected"
            >
              <span style={{ background: "#10b981" }} /> @{authAccount}
            </button>
          ) : (
            <span className="free-label">
              <span /> Free. Always.
            </span>
          )}

          <button
            type="button"
            className="header-cta"
            onClick={() => setShowAuthModal(true)}
          >
            <Key size={13} /> {authAccount ? "Account Active" : "Connect Account"}
          </button>

          <button
            type="button"
            className="mobile-menu"
            aria-label={menu ? "Close menu" : "Open menu"}
            onClick={() => setMenu(!menu)}
          >
            {menu ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </header>

      {menu && (
        <nav className="mobile-nav" aria-label="Mobile navigation">
          <a href="#downloader" onClick={() => setMenu(false)}>Downloader</a>
          <a href="#formats" onClick={() => setMenu(false)}>Formats</a>
          <a href="#faq" onClick={() => setMenu(false)}>FAQs</a>
          <a href="#settings" onClick={() => { setMenu(false); setShowAuthModal(true); }}>Account Settings</a>
        </nav>
      )}

      {/* MAIN CONTENT */}
      <main>
        {/* INTRO & DOWNLOADER SECTION */}
        <section className="intro" id="downloader">
          <div className="intro-badge">
            <Sparkles size={14} /> A little link. Endless possibilities.
          </div>

          <h1>
            Save something <span>good.</span>
            <svg className="headline-spark" width="37" height="40" viewBox="0 0 37 40" aria-hidden="true">
              <path d="M8 20 1 15M15 11 15 2M25 15 34 8" />
            </svg>
          </h1>

          <p>
            Your favorite reels, stories, and videos.
            <br className="mobile-break" /> One link away from being yours.
          </p>

          <div className="downloader-wrap">
            {/* PLATFORM TABS */}
            <div className="platform-grid" role="group" aria-label="Choose content type">
              {platforms.map((item, index) => {
                const IconComponent = item.icon;
                return (
                  <button
                    key={item.name}
                    type="button"
                    className={`platform-card ${item.tone} ${platform === index ? "selected" : ""}`}
                    onClick={() => {
                      setPlatform(index);
                      setMessage("");
                    }}
                    aria-pressed={platform === index}
                  >
                    <span className="platform-icon">
                      <IconComponent size={24} />
                    </span>
                    <span className="platform-name">{item.name}</span>
                    <span className="platform-detail">{item.detail}</span>
                    {platform === index && (
                      <span className="selected-check">
                        <Check size={10} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* DOWNLOAD FORM (CLEAN: NO UPFRONT FORMAT/QUALITY DROPDOWNS) */}
            <form className="download-form" onSubmit={submit}>
              <label className="field-label" htmlFor="media-link">
                Paste your {platform === 3 ? "YouTube video" : `Instagram ${platforms[platform]?.short.toLowerCase()}`} link
              </label>

              <div className="link-field">
                <Link2 size={20} />
                <input
                  id="media-link"
                  type="text"
                  inputMode="url"
                  value={url}
                  onChange={e => {
                    setUrl(e.target.value);
                    setMessage("");
                  }}
                  placeholder={
                    platform === 3
                      ? "https://www.youtube.com/watch?v=..."
                      : platform === 1
                        ? "https://www.instagram.com/stories/..."
                        : platform === 2
                          ? "https://www.instagram.com/stories/highlights/..."
                          : "https://www.instagram.com/reel/..."
                  }
                  autoComplete="off"
                />
                <button type="button" className="paste-button" onClick={paste}>
                  <Clipboard size={13} /> Paste
                </button>
              </div>

              {/* ACTION BUTTON (NO DROPDOWNS BEFOREHAND) */}
              <div className="form-bottom" style={{ marginTop: "16px", display: "flex", justifyContent: "stretch" }}>
                <button
                  type="submit"
                  className="download-cta"
                  disabled={loading}
                  style={{ width: "100%", height: "46px", justifyContent: "center", fontSize: "13px" }}
                >
                  {loading ? (
                    <>
                      <Loader2 size={18} className="animate-spin" /> Processing media fast...
                    </>
                  ) : (
                    <>
                      <Download size={18} /> Get download
                    </>
                  )}
                </button>
              </div>

              {message && (
                <div
                  className="form-message"
                  role="status"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                    alignItems: "flex-start",
                    padding: "12px 16px",
                    background: "var(--secondary)",
                    borderRadius: "8px",
                    border: "1px solid var(--border)",
                    width: "100%",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <CircleHelp size={16} style={{ marginTop: "2px", flexShrink: 0 }} />
                    <span style={{ fontSize: "12px", lineHeight: "1.5" }}>{message}</span>
                  </div>
                  {message.includes("Instagram Restriction") ||
                  message.includes("Authentication required") ||
                  message.includes("Connect Account") ? (
                    <button
                      type="button"
                      className="download-cta"
                      style={{
                        padding: "6px 14px",
                        fontSize: "12px",
                        height: "34px",
                        marginTop: "4px",
                      }}
                      onClick={() => {
                        setAuthTab("cookie");
                        setShowAuthModal(true);
                      }}
                    >
                      <Key size={14} /> Connect Account / Paste Session ID
                    </button>
                  ) : null}
                </div>
              )}
            </form>

            {/* INSTANT HIGH-SPEED SKELETON (DISPLAYS WITHIN 0.05s) */}
            {loading && !result && (
              <div className="real-result-card animate-fadeIn" style={{ marginTop: "24px", border: "1px dashed var(--primary)" }}>
                <div className="real-result-header" style={{ background: "var(--violet)" }}>
                  <span className="real-result-title" style={{ color: "var(--primary)", display: "flex", alignItems: "center", gap: "8px" }}>
                    <Loader2 size={18} className="animate-spin" />
                    Fetching Media & Direct HD Stream...
                  </span>
                  <span style={{ fontSize: "11px", color: "var(--primary)", fontWeight: 600 }}>
                    ⚡ Linkly Sub-Second Engine
                  </span>
                </div>
                <div className="real-result-body" style={{ padding: "20px" }}>
                  <div style={{ height: "220px", background: "var(--secondary)", borderRadius: "8px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "10px" }}>
                    <div style={{ width: "42px", height: "42px", borderRadius: "50%", background: "var(--primary)", opacity: 0.25 }} className="animate-pulse" />
                    <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--foreground)" }}>Connecting to direct CDN streams...</div>
                    <div style={{ fontSize: "11px", color: "var(--muted-foreground)" }}>Usually ready within 1 - 3 seconds</div>
                  </div>
                </div>
              </div>
            )}

            {/* REAL DOWNLOAD RESULT CARD */}
            {result && (
              <div ref={resultRef} className="real-result-card animate-fadeIn" style={{ marginTop: "24px" }}>
                <div className="real-result-header">
                  <span className="real-result-title">
                    <Check size={18} />
                    {isHighlight
                      ? `🌟 Instagram Highlight (${result.mediaCount || result.items?.length || 1} videos)`
                      : isStory
                        ? "✨ Instagram Story Ready"
                        : isReel
                          ? "🎬 Instagram Reel Ready (Video & Audio)"
                          : "🎥 Video Ready"}
                  </span>
                  <span style={{ fontSize: "11px", color: "var(--primary)", fontWeight: 600 }}>
                    ⚡ Linkly High-Speed Engine
                  </span>
                </div>

                <div className="real-result-body">
                  <div className="media-meta-grid">
                    <div className="media-meta-item">
                      <div className="media-meta-label">File / Title</div>
                      <div className="media-meta-value" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {result.filename}
                      </div>
                    </div>
                    {result.fileSize ? (
                      <div className="media-meta-item">
                        <div className="media-meta-label">Size</div>
                        <div className="media-meta-value">{(result.fileSize / (1024 * 1024)).toFixed(2)} MB</div>
                      </div>
                    ) : null}
                    {result.owner ? (
                      <div className="media-meta-item">
                        <div className="media-meta-label">Author</div>
                        <div className="media-meta-value">@{result.owner}</div>
                      </div>
                    ) : null}
                    <div className="media-meta-item">
                      <div className="media-meta-label">Quality</div>
                      <div className="media-meta-value">Original HD (1080p)</div>
                    </div>
                  </div>

                  {/* 1. HIGHLIGHTS: SHOW ALL VIDEOS DIRECTLY IN A GRID OR SINGLE PLAYER */}
                  {isHighlight ? (
                    result.items && result.items.length > 0 ? (
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
                          <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--foreground)" }}>
                            Highlight Videos & Media ({result.items.length} items):
                          </span>
                          <button
                            type="button"
                            className="btn-action-primary"
                            style={{ padding: "8px 14px", fontSize: "11px" }}
                            onClick={() => handleDownloadAll(result.items!)}
                          >
                            <Download size={13} /> Download All Highlight Videos
                          </button>
                        </div>

                        <div className="carousel-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
                          {result.items.map((item, idx) => {
                            const isVid = item.type === "video" || item.filename.endsWith(".mp4");
                            return (
                              <div key={idx} className="carousel-cell" style={{ borderRadius: "8px", border: "1px solid var(--border)" }}>
                                {isVid ? (
                                  <video
                                    src={item.downloadUrl}
                                    controls
                                    playsInline
                                    preload="metadata"
                                    style={{ width: "100%", height: "200px", objectFit: "cover", background: "#000" }}
                                  />
                                ) : (
                                  <img
                                    src={item.previewUrl || item.downloadUrl}
                                    alt={`Highlight ${idx + 1}`}
                                    loading="lazy"
                                    style={{ width: "100%", height: "200px", objectFit: "cover" }}
                                  />
                                )}
                                <div className="carousel-cell-footer" style={{ padding: "10px", background: "var(--card)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                  <span style={{ fontSize: "11px", fontWeight: 600 }}>#{idx + 1} {isVid ? "🎬 Video" : "🖼 Photo"}</span>
                                  <button
                                    type="button"
                                    className="btn-action-primary"
                                    style={{ padding: "6px 10px", fontSize: "10px" }}
                                    onClick={() => triggerDownload(item.downloadUrl, item.filename)}
                                  >
                                    ⬇ Save
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      <div>
                        <div className="preview-player-wrap" style={{ borderRadius: "8px", overflow: "hidden", maxHeight: "520px" }}>
                          {result.filename?.endsWith(".jpg") || result.contentType?.includes("image") ? (
                            <img src={result.downloadUrl} alt="Highlight Preview" style={{ maxHeight: "520px", width: "100%", objectFit: "contain" }} />
                          ) : (
                            <video src={result.videoUrl || result.downloadUrl} controls playsInline autoPlay muted style={{ maxHeight: "520px", width: "100%" }} />
                          )}
                        </div>
                        <div className="action-buttons-row" style={{ marginTop: "16px" }}>
                          <button
                            type="button"
                            className="btn-action-primary"
                            onClick={() => triggerDownload(result.downloadUrl, result.filename)}
                          >
                            <Download size={15} /> Download Highlight (HD)
                          </button>
                          <button
                            type="button"
                            className="btn-action-secondary"
                            onClick={() => {
                              navigator.clipboard.writeText(result.downloadUrl);
                              setCopiedLink(true);
                              setTimeout(() => setCopiedLink(false), 2000);
                            }}
                          >
                            {copiedLink ? <Check size={14} /> : <Copy size={14} />}
                            {copiedLink ? "Link Copied!" : "Copy Link"}
                          </button>
                        </div>
                      </div>
                    )
                  ) : isStory ? (
                    /* 2. STORIES: DIRECT STORY VIDEO / PHOTO PREVIEW */
                    <div>
                      <div className="preview-player-wrap" style={{ borderRadius: "8px", overflow: "hidden", maxHeight: "520px" }}>
                        {result.filename?.endsWith(".jpg") || result.contentType?.includes("image") ? (
                          <img src={result.downloadUrl} alt="Story Preview" style={{ maxHeight: "520px", width: "100%", objectFit: "contain" }} />
                        ) : (
                          <video src={result.videoUrl || result.downloadUrl} controls playsInline autoPlay muted style={{ maxHeight: "520px", width: "100%" }} />
                        )}
                      </div>

                      <div className="action-buttons-row" style={{ marginTop: "16px" }}>
                        <button
                          type="button"
                          className="btn-action-primary"
                          onClick={() => triggerDownload(result.downloadUrl, result.filename)}
                        >
                          <Download size={15} /> Download Story (HD)
                        </button>
                        <button
                          type="button"
                          className="btn-action-secondary"
                          onClick={() => {
                            navigator.clipboard.writeText(result.downloadUrl);
                            setCopiedLink(true);
                            setTimeout(() => setCopiedLink(false), 2000);
                          }}
                        >
                          {copiedLink ? <Check size={14} /> : <Copy size={14} />}
                          {copiedLink ? "Link Copied!" : "Copy Link"}
                        </button>
                        <button
                          type="button"
                          className="btn-action-secondary"
                          onClick={() => { setResult(null); setUrl(""); }}
                        >
                          Download Another
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* 3. REELS & VIDEOS: DIRECT VIDEO PREVIEW + DUAL VIDEO & AUDIO FORMAT OPTIONS! */
                    <div>
                      <div className="preview-player-wrap" style={{ borderRadius: "8px", overflow: "hidden", maxHeight: "480px" }}>
                        <video
                          src={result.videoUrl || result.downloadUrl}
                          controls
                          playsInline
                          autoPlay
                          muted
                          style={{ maxHeight: "480px", width: "100%" }}
                        />
                      </div>

                      {/* DUAL FORMAT DOWNLOAD OPTIONS FOR REELS */}
                      <div style={{ marginTop: "18px", padding: "16px", background: "var(--violet)", borderRadius: "8px", border: "1px solid var(--border)" }}>
                        <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--primary)", marginBottom: "12px", display: "flex", alignItems: "center", gap: "6px" }}>
                          <Sparkles size={14} /> Choose your download format for this Reel:
                        </div>

                        <div className="action-buttons-row" style={{ marginTop: "0" }}>
                          {/* VIDEO FORMAT */}
                          <button
                            type="button"
                            className="btn-action-primary"
                            style={{ padding: "12px 20px", fontSize: "12px", gap: "8px" }}
                            onClick={() => triggerDownload(result.videoUrl || result.downloadUrl, result.filename)}
                          >
                            <Video size={16} /> Download Video (MP4 · HD)
                          </button>

                          {/* AUDIO FORMAT (ONLY IN REELS) */}
                          <button
                            type="button"
                            className="btn-action-primary"
                            style={{
                              background: "linear-gradient(135deg, #8134af 0%, #dd2a7b 100%)",
                              padding: "12px 20px",
                              fontSize: "12px",
                              gap: "8px"
                            }}
                            onClick={() => {
                              const audioUrl = result.audioUrl || `/api/file/${result.id}.mp3`;
                              triggerDownload(audioUrl, `reel-audio-${result.id}.mp3`);
                            }}
                          >
                            <Music size={16} /> Download Audio (MP3)
                          </button>

                          {/* COPY LINK */}
                          <button
                            type="button"
                            className="btn-action-secondary"
                            onClick={() => {
                              navigator.clipboard.writeText(result.videoUrl || result.downloadUrl);
                              setCopiedLink(true);
                              setTimeout(() => setCopiedLink(false), 2000);
                            }}
                          >
                            {copiedLink ? <Check size={14} /> : <Copy size={14} />}
                            {copiedLink ? "Copied" : "Copy Link"}
                          </button>

                          <button
                            type="button"
                            className="btn-action-secondary"
                            onClick={() => { setResult(null); setUrl(""); }}
                          >
                            Download Another
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* UNDER FORM CONTROLS */}
            <div className="under-form">
              <span>
                <ShieldCheck size={14} /> No sign-up required. Saved with Supabase.
              </span>
              <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                <button type="button" onClick={() => setShowAuthModal(true)}>
                  <Key size={12} /> {authAccount ? `@${authAccount}` : "Instagram Session"}
                </button>
                <button type="button" onClick={() => setSample(!sample)}>
                  {sample ? "Close sample" : "Try a sample"} <ArrowRight size={13} />
                </button>
              </div>
            </div>

            {/* SAMPLE PREVIEW */}
            {sample && (
              <div className="sample-result animate-fadeIn">
                <img
                  src="/assets/coast.jpg"
                  alt="Sample: sunny Amalfi coast"
                  width={1536}
                  height={1024}
                  loading="lazy"
                />
                <div>
                  <span className="sample-tag">SAMPLE PREVIEW</span>
                  <h3>A moment on the Amalfi Coast</h3>
                  <p>MP4 · 1080p · Sample image preview</p>
                  <a href="/assets/coast.jpg" download="linkly-sample-coast.jpg">
                    <Download size={12} /> Download sample image
                  </a>
                </div>
              </div>
            )}
          </div>

          <div className="trust-row">
            <span><Zap /> Quick & effortless</span>
            <span><ShieldCheck /> Privacy first</span>
            <span><Check /> Original quality</span>
            <span><Heart /> Made for everyone</span>
          </div>
        </section>

        {/* POSSIBILITIES SECTION */}
        <section className="possibilities" id="formats">
          <div className="section-heading">
            <div>
              <span className="eyebrow">LESS SCROLLING. MORE KEEPING.</span>
              <h2>Your favorites, without limits.</h2>
            </div>
            <p>
              From a fleeting story to a video worth rewatching.
              <br />
              Make room for the things you love.
            </p>
          </div>

          <div className="feature-grid">
            <article className="feature-card visual-card">
              <img
                src="/assets/coast.jpg"
                alt="Sunlit Amalfi coast, a moment worth keeping"
                width={1536}
                height={1024}
                loading="lazy"
              />
              <div className="video-tag">
                <Clapperboard size={12} /> REELS
              </div>
              <span className="photo-play">
                <Play size={18} fill="currentColor" />
              </span>
              <div className="photo-caption">
                <span>A moment worth keeping.</span>
                <span>00:24</span>
              </div>
            </article>

            <article className="feature-card quality-card">
              <div className="quality-art">
                <span className="quality-small">HD</span>
                <span className="quality-main">
                  4K<span>ULTRA HD</span>
                </span>
                <Sparkles className="quality-spark" size={21} />
                <span className="quality-check">
                  <Check size={15} />
                </span>
              </div>
              <h3>Every detail. Intact.</h3>
              <p>
                The quality you love,
                <br />
                just the way it was.
              </p>
              <span className="feature-foot">
                Original resolution <Check size={13} />
              </span>
            </article>

            <article className="feature-card format-card">
              <div className="file-art">
                <span className="file back-file">MP3</span>
                <span className="file front-file">
                  <Play size={19} />
                  <b>MP4</b>
                </span>
                <span className="file-format-badge">+ more</span>
              </div>
              <h3>Your video. Your format.</h3>
              <p>
                Video or audio.
                <br />
                Whatever fits your day.
              </p>
              <span className="feature-foot">
                MP4 & MP3 Audio <ArrowRight size={13} />
              </span>
            </article>

            <article className="feature-card anywhere-card">
              <div className="device-art">
                <div className="mini-screen">
                  <img src="/assets/coast.jpg" alt="" width={1536} height={1024} loading="lazy" />
                  <Play size={12} />
                </div>
                <div className="mini-phone">
                  <img src="/assets/coast.jpg" alt="" width={1536} height={1024} loading="lazy" />
                </div>
                <span className="device-download">
                  <ArrowDown size={14} />
                </span>
              </div>
              <h3>Big screen. Small screen.</h3>
              <p>
                At your desk or on the go.
                <br />
                Always within reach.
              </p>
              <span className="feature-foot">
                All your devices <Check size={13} />
              </span>
            </article>
          </div>
        </section>

        {/* FAQS SECTION */}
        <section className="faq-section" id="faq">
          <div>
            <span className="eyebrow">A FEW GOOD ANSWERS</span>
            <h2>Wondering something?</h2>
            <p>Let’s clear it up.</p>
          </div>
          <div className="faq-list">
            {faqs.map(([question, answer], i) => (
              <div className="faq-item" key={question}>
                <button
                  type="button"
                  onClick={() => setFaq(faq === i ? null : i)}
                  aria-expanded={faq === i}
                >
                  {question}
                  <ChevronDown className={faq === i ? "rotated" : ""} />
                </button>
                {faq === i && <p>{answer}</p>}
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* FOOTER */}
      <footer>
        <a className="wordmark" href="/">
          <span className="brand-icon">
            <ArrowDownToLine />
          </span>
          linkly<span className="brand-dot">.</span>
        </a>
        <p>Keep the moment. Respect the creator.</p>
        <span>
          © 2026 Linkly <Heart size={12} />
        </span>
      </footer>

      {/* INSTAGRAM ACCOUNT / SESSION MODAL */}
      {showAuthModal && (
        <div className="auth-modal-overlay" onClick={() => setShowAuthModal(false)}>
          <div className="auth-modal" onClick={e => e.stopPropagation()}>
            <div className="auth-modal-header">
              <h3>Instagram Account & Session</h3>
              <button
                type="button"
                className="auth-modal-close"
                onClick={() => setShowAuthModal(false)}
              >
                ✕
              </button>
            </div>

            {authAccount && (
              <div style={{ marginBottom: "16px", padding: "10px 14px", background: "var(--violet)", borderRadius: "6px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "12px", color: "var(--primary)", fontWeight: 600 }}>
                  🟢 Connected as @{authAccount}
                </span>
                <button
                  type="button"
                  className="paste-button"
                  style={{ color: "#ef4444" }}
                  onClick={handleDisconnect}
                >
                  Disconnect
                </button>
              </div>
            )}

            <div style={{ display: "flex", gap: "8px", borderBottom: "1px solid var(--border)", paddingBottom: "10px", marginBottom: "14px" }}>
              <button
                type="button"
                className="paste-button"
                style={{ background: authTab === "direct" ? "var(--violet)" : "transparent", borderColor: authTab === "direct" ? "var(--primary)" : "var(--border)" }}
                onClick={() => setAuthTab("direct")}
              >
                Direct Account Login
              </button>
              <button
                type="button"
                className="paste-button"
                style={{ background: authTab === "cookie" ? "var(--violet)" : "transparent", borderColor: authTab === "cookie" ? "var(--primary)" : "var(--border)" }}
                onClick={() => setAuthTab("cookie")}
              >
                Cookie / Session ID
              </button>
            </div>

            {authTab === "direct" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <p style={{ fontSize: "11px", color: "var(--muted-foreground)" }}>
                  Connect your Instagram account to download private reels, posts, and stories seamlessly.
                </p>
                <input
                  type="text"
                  placeholder="Instagram Username or Email"
                  value={loginUser}
                  onChange={e => setLoginUser(e.target.value)}
                  style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: "6px", background: "var(--background)" }}
                />
                <input
                  type="password"
                  placeholder="Instagram Password"
                  value={loginPass}
                  onChange={e => setLoginPass(e.target.value)}
                  style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: "6px", background: "var(--background)" }}
                />
                <input
                  type="text"
                  placeholder="2FA Verification Code (if enabled)"
                  value={login2FA}
                  onChange={e => setLogin2FA(e.target.value)}
                  style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: "6px", background: "var(--background)" }}
                />
                <button
                  type="button"
                  className="download-cta"
                  style={{ width: "100%", justifyContent: "center" }}
                  disabled={authLoading}
                  onClick={handleConnectAccount}
                >
                  {authLoading ? <Loader2 size={14} className="animate-spin" /> : <Key size={14} />} Connect Account
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <p style={{ fontSize: "11px", color: "var(--muted-foreground)" }}>
                  Instagram requires an active account session to view and download Story Highlights (even on public accounts). You can safely sync your session in 10 seconds without sharing your password:
                </p>
                <div style={{ background: "var(--secondary)", padding: "10px 14px", borderRadius: "8px", border: "1px solid var(--border)", fontSize: "11px", lineHeight: "1.6" }}>
                  <strong>How to copy your sessionid (3 easy steps):</strong>
                  <ol style={{ margin: "4px 0 0 16px", padding: 0 }}>
                    <li>Open <code>instagram.com</code> in Chrome or Edge (where you are logged in).</li>
                    <li>Press <kbd style={{ background: "var(--background)", padding: "2px 4px", borderRadius: "4px", border: "1px solid var(--border)" }}>F12</kbd> &rarr; Go to <strong>Application</strong> &rarr; <strong>Cookies</strong> &rarr; <code>instagram.com</code>.</li>
                    <li>Double-click the value of <strong>sessionid</strong>, copy it, and paste below.</li>
                  </ol>
                </div>
                <input
                  type="password"
                  placeholder="Paste sessionid cookie..."
                  value={cookieSession}
                  onChange={e => setCookieSession(e.target.value)}
                  style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: "6px", background: "var(--background)" }}
                />
                <button
                  type="button"
                  className="download-cta"
                  style={{ width: "100%", justifyContent: "center" }}
                  disabled={authLoading}
                  onClick={handleSaveCookie}
                >
                  {authLoading ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save Session & Enable Highlights
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
