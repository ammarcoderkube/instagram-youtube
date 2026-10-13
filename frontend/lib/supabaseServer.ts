import { createClient, SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  "";

const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "";

export const isConfigured = Boolean(
  supabaseUrl && supabaseKey && supabaseUrl.startsWith("http")
);

let supabaseInstance: SupabaseClient | null = null;

if (isConfigured) {
  try {
    supabaseInstance = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
    console.log(`[Supabase] Connected successfully to ${supabaseUrl}`);
  } catch (err: any) {
    console.warn(`[Supabase] Connection error: ${err.message}. Using resilient memory store.`);
  }
} else {
  console.log(
    `[Supabase] Credentials not set in .env.local (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY). Using resilient database store.`
  );
}

export const supabaseServer = supabaseInstance;

// In-memory resilient store for zero-config development or before Supabase keys are entered
interface SessionRecord {
  id: string;
  deviceId: string;
  sessionid: string;
  username: string;
  ds_user_id?: string | null;
  isDeviceLinked: boolean;
  isActive: boolean;
  lastActiveAt: string;
}

interface DownloadHistoryRecord {
  id?: string;
  deviceId?: string;
  url: string;
  title?: string;
  mediaType?: string;
  format?: string;
  quality?: string;
  filename: string;
  fileSize?: number;
  owner?: string;
  caption?: string;
  downloadUrl: string;
  previewUrl?: string;
  accountUsed?: string;
  createdAt?: string;
}

const memoryStore = {
  user_sessions: [] as SessionRecord[],
  download_history: [] as DownloadHistoryRecord[],
};

/**
 * Get active session for a specific device from Supabase
 */
export async function getSessionByDeviceId(deviceId: string) {
  if (!deviceId) return null;
  const cleanId = deviceId.trim();

  if (isConfigured && supabaseServer) {
    try {
      const { data, error } = await supabaseServer
        .from("user_sessions")
        .select("*")
        .eq("device_id", cleanId)
        .eq("is_device_linked", true)
        .eq("is_active", true)
        .order("last_active_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!error && data) {
        // Touch last_active_at
        supabaseServer
          .from("user_sessions")
          .update({ last_active_at: new Date().toISOString() })
          .eq("id", data.id)
          .then();

        return {
          id: data.id,
          deviceId: data.device_id,
          sessionid: data.sessionid,
          username: data.username,
          ds_user_id: data.ds_user_id,
          isDeviceLinked: data.is_device_linked,
          isActive: data.is_active,
          lastActiveAt: data.last_active_at,
        };
      }
    } catch (e: any) {
      console.warn(`[Supabase] getSessionByDeviceId error:`, e.message);
    }
  }

  // Memory fallback
  const found = memoryStore.user_sessions
    .filter((s) => s.deviceId === cleanId && s.isDeviceLinked && s.isActive)
    .sort(
      (a, b) =>
        new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
    )[0];

  if (found) {
    found.lastActiveAt = new Date().toISOString();
    return found;
  }
  return null;
}

let cachedSessionsPool: { data: any[]; timestamp: number } | null = null;
const SESSIONS_CACHE_TTL = 30000; // 30s cache

export function invalidateSessionCache() {
  cachedSessionsPool = null;
}

/**
 * Get all active sessions pool from Supabase (prioritizing current device)
 */
export async function getAllActiveSessions(deviceId?: string) {
  const cleanId = deviceId ? deviceId.trim() : null;

  if (cachedSessionsPool && Date.now() - cachedSessionsPool.timestamp < SESSIONS_CACHE_TTL) {
    const pool = [...cachedSessionsPool.data];
    if (cleanId) {
      pool.sort((a, b) => {
        const aCur = a.deviceId === cleanId;
        const bCur = b.deviceId === cleanId;
        if (aCur && !bCur) return -1;
        if (!aCur && bCur) return 1;
        return 0;
      });
    }
    return pool;
  }

  if (isConfigured && supabaseServer) {
    try {
      const { data, error } = await supabaseServer
        .from("user_sessions")
        .select("*")
        .eq("is_active", true)
        .order("last_active_at", { ascending: false });

      if (!error && data) {
        const pool = data.map((doc: any) => ({
          id: doc.id,
          deviceId: doc.device_id,
          sessionid: doc.sessionid,
          username: doc.username,
          ds_user_id: doc.ds_user_id,
          isCurrentDevice: cleanId ? doc.device_id === cleanId : false,
        }));

        cachedSessionsPool = { data: pool, timestamp: Date.now() };

        pool.sort((a, b) => {
          if (a.isCurrentDevice && !b.isCurrentDevice) return -1;
          if (!a.isCurrentDevice && b.isCurrentDevice) return 1;
          return 0;
        });

        return pool;
      }
    } catch (e: any) {
      console.warn(`[Supabase] getAllActiveSessions error:`, e.message);
    }
  }

  // Memory fallback
  const pool = memoryStore.user_sessions
    .filter((s) => s.isActive)
    .map((s) => ({
      ...s,
      isCurrentDevice: cleanId ? s.deviceId === cleanId : false,
    }));

  pool.sort((a, b) => {
    if (a.isCurrentDevice && !b.isCurrentDevice) return -1;
    if (!a.isCurrentDevice && b.isCurrentDevice) return 1;
    return 0;
  });

  return pool;
}

/**
 * Upsert Instagram session into Supabase linked to device
 */
export async function upsertSession(
  deviceId: string,
  username: string,
  sessionid: string
) {
  if (!sessionid) throw new Error("sessionid is required");
  const cleanDeviceId = deviceId ? deviceId.trim() : "global_pool";
  const cleanSessionId = sessionid.trim().replace(/^sessionid=/, "");
  const cleanUsername = username ? username.trim() : "Connected Account";

  let ds_user_id: string | null = null;
  const match = cleanSessionId.match(/^(\d+)(?:%3A|:)/);
  if (match) {
    ds_user_id = match[1];
  }

  const now = new Date().toISOString();

  if (isConfigured && supabaseServer) {
    try {
      // Unlink other sessions for this device
      if (cleanDeviceId !== "global_pool") {
        await supabaseServer
          .from("user_sessions")
          .update({ is_device_linked: false })
          .eq("device_id", cleanDeviceId)
          .neq("sessionid", cleanSessionId);
      }

      // Check if session already exists
      const { data: existing } = await supabaseServer
        .from("user_sessions")
        .select("id")
        .eq("sessionid", cleanSessionId)
        .maybeSingle();

      let savedData = null;

      if (existing) {
        const { data, error } = await supabaseServer
          .from("user_sessions")
          .update({
            device_id: cleanDeviceId,
            username: cleanUsername,
            ds_user_id,
            is_device_linked: true,
            is_active: true,
            last_active_at: now,
          })
          .eq("id", existing.id)
          .select()
          .single();

        if (!error && data) savedData = data;
      } else {
        const { data, error } = await supabaseServer
          .from("user_sessions")
          .insert({
            device_id: cleanDeviceId,
            username: cleanUsername,
            sessionid: cleanSessionId,
            ds_user_id,
            is_device_linked: true,
            is_active: true,
            last_active_at: now,
          })
          .select()
          .single();

        if (!error && data) savedData = data;
      }

      if (savedData) {
        return {
          deviceId: savedData.device_id,
          sessionid: savedData.sessionid,
          username: savedData.username,
          ds_user_id: savedData.ds_user_id,
        };
      }
    } catch (e: any) {
      console.warn(`[Supabase] upsert error:`, e.message);
    }
  }

  // Memory fallback
  if (cleanDeviceId !== "global_pool") {
    memoryStore.user_sessions.forEach((s) => {
      if (s.deviceId === cleanDeviceId && s.sessionid !== cleanSessionId) {
        s.isDeviceLinked = false;
      }
    });
  }

  const existing = memoryStore.user_sessions.find(
    (s) => s.sessionid === cleanSessionId
  );
  if (existing) {
    existing.deviceId = cleanDeviceId;
    existing.username = cleanUsername;
    existing.isDeviceLinked = true;
    existing.isActive = true;
    existing.lastActiveAt = now;
    return existing;
  }

  const newDoc: SessionRecord = {
    id: "mem_" + Math.random().toString(36).substring(2, 10),
    deviceId: cleanDeviceId,
    sessionid: cleanSessionId,
    username: cleanUsername,
    ds_user_id,
    isDeviceLinked: true,
    isActive: true,
    lastActiveAt: now,
  };
  memoryStore.user_sessions.push(newDoc);
  return newDoc;
}

/**
 * Disconnect session for a device in Supabase
 */
export async function disconnectSession(deviceId: string) {
  if (!deviceId) return false;
  const cleanId = deviceId.trim();

  if (isConfigured && supabaseServer) {
    try {
      const { data, error } = await supabaseServer
        .from("user_sessions")
        .update({ is_device_linked: false, is_active: false })
        .eq("device_id", cleanId)
        .select();

      return !error && data && data.length > 0;
    } catch (e: any) {
      console.warn(`[Supabase] disconnect error:`, e.message);
    }
  }

  // Memory fallback
  let count = 0;
  memoryStore.user_sessions.forEach((s) => {
    if (s.deviceId === cleanId) {
      s.isDeviceLinked = false;
      s.isActive = false;
      count++;
    }
  });
  return count > 0;
}

/**
 * Record a completed download in Supabase
 */
export async function recordDownload(record: DownloadHistoryRecord) {
  if (isConfigured && supabaseServer) {
    try {
      const { data, error } = await supabaseServer
        .from("download_history")
        .insert({
          device_id: record.deviceId || null,
          url: record.url,
          title: record.title || "Media Download",
          media_type: record.mediaType || "video",
          format: record.format || "MP4",
          quality: record.quality || "HD",
          filename: record.filename,
          file_size: record.fileSize || 0,
          owner: record.owner || null,
          caption: record.caption || null,
          download_url: record.downloadUrl,
          preview_url: record.previewUrl || record.downloadUrl,
          account_used: record.accountUsed || null,
        })
        .select()
        .single();

      if (!error && data) return data;
    } catch (e: any) {
      console.warn(`[Supabase] recordDownload error:`, e.message);
    }
  }

  // Memory fallback
  const memRecord: DownloadHistoryRecord = {
    ...record,
    id: "mem_dl_" + Math.random().toString(36).substring(2, 10),
    createdAt: new Date().toISOString(),
  };
  memoryStore.download_history.unshift(memRecord);
  if (memoryStore.download_history.length > 100) {
    memoryStore.download_history.pop();
  }
  return memRecord;
}

/**
 * Get recent downloads for a device from Supabase
 */
export async function getRecentDownloads(deviceId: string, limit = 20) {
  if (!deviceId) return [];
  const cleanId = deviceId.trim();

  if (isConfigured && supabaseServer) {
    try {
      const { data, error } = await supabaseServer
        .from("download_history")
        .select("*")
        .eq("device_id", cleanId)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (!error && data) return data;
    } catch (e: any) {
      console.warn(`[Supabase] getRecentDownloads error:`, e.message);
    }
  }

  return memoryStore.download_history
    .filter((h) => h.deviceId === cleanId)
    .slice(0, limit);
}
