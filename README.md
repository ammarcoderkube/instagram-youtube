# 📥 Linkly — Instagram & YouTube Downloader (Next.js + Supabase)

A high-performance media downloader for Instagram Reels, Stories, Highlights, and YouTube videos. Built with **Next.js 15 (App Router)** and **Supabase**, featuring the editorial Lovable "Linkly" design system.

The entire backend and media processing engine runs directly inside **Next.js API route handlers** and **Supabase** — with **zero separate Node.js backend servers** required.

---

## 📂 Project Structure

```
instagram-reel-downloader/
├── frontend/                          # Next.js 15 Full-Stack Web Application
│   ├── app/
│   │   ├── api/
│   │   │   ├── download/route.ts      # POST /api/download (Reels, Stories, Highlights, YouTube)
│   │   │   ├── file/[filename]/route.ts# GET /api/file/:filename (Streaming + on-the-fly MP3 conversion)
│   │   │   ├── auth/
│   │   │   │   ├── login/route.ts     # POST /api/auth/login (Instagram 2FA login)
│   │   │   │   ├── session/route.ts   # POST /api/auth/session (Save sessionid cookie)
│   │   │   │   ├── status/route.ts    # GET /api/auth/status (Device session status)
│   │   │   │   └── disconnect/route.ts# POST /api/auth/disconnect (Disconnect session)
│   │   │   └── history/route.ts       # GET /api/history (Download history from Supabase)
│   │   ├── layout.tsx                 # Root layout with DM Sans & Manrope fonts
│   │   ├── page.tsx                   # Linkly landing page & downloader
│   │   └── globals.css                # Custom CSS tokens & Tailwind styles
│   ├── lib/
│   │   ├── mediaProcessor.ts          # yt-dlp, FFmpeg audio extraction & Instaloader engine
│   │   ├── supabaseServer.ts          # Server-side Supabase client & fallback store
│   │   └── supabase.ts                # Client-side Supabase helper
│   ├── scripts/
│   │   └── instaloader_downloader.py  # Python engine for Stories, Highlights & Private media
│   ├── public/
│   │   ├── assets/coast.jpg           # Sample preview image
│   │   └── favicon.svg
│   ├── next.config.mjs                # Next.js configuration & route rewrites
│   ├── tailwind.config.js
│   ├── tsconfig.json
│   ├── package.json
│   └── .env.example
│
├── supabase_schema.sql                # Supabase schema for user_sessions & download_history
├── .env.example                       # Root environment variables template
├── .gitignore                         # Git ignore configuration
└── README.md                          # Documentation
```

---

## ⚡ Features

- **Instagram Reels**: Instant video preview with dual download formats — **Download Video (MP4 · HD)** and **Download Audio (MP3)**.
- **Instagram Highlights**: Displays all highlight videos and photos in a responsive grid with individual download and **"Download All"** batch buttons.
- **Instagram Stories**: High-speed direct HD preview and download for video stories and photos.
- **YouTube Videos**: Video and audio extraction.
- **Supabase Integration**: Persistent session pooling and download history with built-in resilient database fallback.
- **Unified Architecture**: Everything runs in Next.js without needing any external Node.js backend processes or ports.

---

## 🗄️ Supabase Database Setup

Linkly uses Supabase for storing active Instagram sessions and user download history.

1. Create a free project on [Supabase](https://supabase.com/).
2. In the Supabase Dashboard, go to **SQL Editor** -> **New query**.
3. Copy the entire contents of [`supabase_schema.sql`](./supabase_schema.sql) and click **Run**:
   - `public.user_sessions`: Stores connected Instagram accounts and session tokens per device.
   - `public.download_history`: Stores media download logs.
   - Enables Row Level Security (RLS) with permissive access policies.
4. Obtain your API credentials from **Project Settings** -> **API**:
   - **Project URL**
   - **anon / public key** or **service_role key**
5. Create `.env.local` inside `frontend/`:
   ```env
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   ```
   *(If not provided, Linkly runs automatically with its built-in resilient in-memory database store so you can start right away).*

---

## 🚀 Running the Application

### Prerequisites
- **Node.js** (v18 or higher)
- **Python 3** (with `instaloader`, `cryptography`, `yt-dlp`)
- **FFmpeg** (installed and in PATH)

### Start the Application (1 Command)
```bash
cd frontend
npm install
npm run dev
# or for production:
npm run build && npm start
```

Open your browser at **`http://localhost:5173`**.

---

## 📡 Next.js API Routes

| Method | Route | Description |
| :--- | :--- | :--- |
| `POST` | `/api/download` | Processes media URL and returns `videoUrl`, `audioUrl`, `items`, etc. |
| `GET` | `/api/file/:filename` | Streams media files with Range headers and instant MP3 conversion |
| `GET` | `/api/history` | Fetches download history for the current device from Supabase |
| `POST` | `/api/auth/login` | Connects Instagram account (with 2FA support) |
| `POST` | `/api/auth/session` | Saves custom Instagram `sessionid` cookie |
| `GET` | `/api/auth/status` | Checks active session status for device |
| `POST` | `/api/auth/disconnect` | Disconnects device session |
