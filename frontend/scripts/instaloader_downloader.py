import sys
import os
import re
import glob
import json
import sqlite3
import shutil
import tempfile
import ctypes
import base64
from ctypes import wintypes
from http.cookiejar import MozillaCookieJar
from concurrent.futures import ThreadPoolExecutor
import instaloader

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    HAS_AESGCM = True
except ImportError:
    HAS_AESGCM = False

class DATA_BLOB(ctypes.Structure):
    _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_char))]

def dpapi_decrypt(encrypted_bytes):
    if not encrypted_bytes:
        return None
    try:
        blob_in = DATA_BLOB(len(encrypted_bytes), ctypes.create_string_buffer(encrypted_bytes, len(encrypted_bytes)))
        blob_out = DATA_BLOB()
        if ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)):
            data = ctypes.string_at(blob_out.pbData, blob_out.cbData)
            ctypes.windll.kernel32.LocalFree(blob_out.pbData)
            return data
    except Exception:
        pass
    return None

def get_chromium_key(local_state_path):
    if not os.path.exists(local_state_path):
        return None
    try:
        with open(local_state_path, 'r', encoding='utf-8') as f:
            state = json.load(f)
        enc_key = base64.b64decode(state['os_crypt']['encrypted_key'])[5:]
        return dpapi_decrypt(enc_key)
    except Exception:
        return None

def decrypt_chromium_cookie(encrypted_val, key):
    if not encrypted_val:
        return ''
    if HAS_AESGCM and key and (encrypted_val.startswith(b'v10') or encrypted_val.startswith(b'v11')):
        try:
            nonce = encrypted_val[3:15]
            ciphertext = encrypted_val[15:]
            aesgcm = AESGCM(key)
            return aesgcm.decrypt(nonce, ciphertext, None).decode('utf-8', errors='ignore')
        except Exception:
            pass
    dec = dpapi_decrypt(encrypted_val)
    if dec:
        try:
            return dec.decode('utf-8', errors='ignore')
        except Exception:
            pass
    return ''

def copy_locked_file(src, dst):
    if not os.path.exists(src):
        return False
    try:
        shutil.copy2(src, dst)
        return True
    except Exception:
        pass
    
    if os.name == 'nt':
        try:
            GENERIC_READ = 0x80000000
            FILE_SHARE_READ = 0x00000001
            FILE_SHARE_WRITE = 0x00000002
            FILE_SHARE_DELETE = 0x00000004
            OPEN_EXISTING = 3
            FILE_ATTRIBUTE_NORMAL = 0x80

            handle = ctypes.windll.kernel32.CreateFileW(
                src,
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None
            )
            if handle != -1 and handle != 0:
                with open(dst, 'wb') as out_f:
                    buf = ctypes.create_string_buffer(64 * 1024)
                    bytes_read = wintypes.DWORD()
                    while True:
                        success = ctypes.windll.kernel32.ReadFile(handle, buf, len(buf), ctypes.byref(bytes_read), None)
                        if not success or bytes_read.value == 0:
                            break
                        out_f.write(buf.raw[:bytes_read.value])
                ctypes.windll.kernel32.CloseHandle(handle)
                return os.path.exists(dst) and os.path.getsize(dst) > 0
        except Exception as win_err:
            sys.stderr.write(f"Win32 shared read error: {win_err}\n")
    return False

def extract_cookies_from_chromium(user_data_dir):
    local_state = os.path.join(user_data_dir, 'Local State')
    key = get_chromium_key(local_state)
    
    profiles = glob.glob(os.path.join(user_data_dir, 'Default')) + glob.glob(os.path.join(user_data_dir, 'Profile *'))
    cookies = {}
    
    for prof in profiles:
        cookie_candidates = [
            os.path.join(prof, 'Network', 'Cookies'),
            os.path.join(prof, 'Cookies')
        ]
        for cpath in cookie_candidates:
            if not os.path.exists(cpath):
                continue
            temp_db = tempfile.mktemp(prefix='insta_cookie_', suffix='.db')
            try:
                if not copy_locked_file(cpath, temp_db):
                    continue
                conn = sqlite3.connect(temp_db)
                cursor = conn.cursor()
                cursor.execute("SELECT name, encrypted_value, value FROM cookies WHERE host_key LIKE '%instagram.com%'")
                for name, enc_val, plain_val in cursor.fetchall():
                    val = plain_val
                    if (not val) and enc_val:
                        val = decrypt_chromium_cookie(enc_val, key)
                    if val and (name not in cookies):
                        cookies[name] = val
                conn.close()
            except Exception as e:
                sys.stderr.write(f"Error reading browser cookies: {e}\n")
            finally:
                if os.path.exists(temp_db):
                    try:
                        os.remove(temp_db)
                    except Exception:
                        pass
    return cookies

def extract_cookies_from_firefox():
    """
    Directly extracts Instagram session from Mozilla Firefox profiles on the device.
    Searches standard AppData Roaming, Local, and Windows Store package locations.
    """
    cookies = {}
    appdata = os.getenv("APPDATA", "")
    localappdata = os.getenv("LOCALAPPDATA", "")
    
    candidate_profile_dirs = [
        os.path.join(appdata, "Mozilla", "Firefox", "Profiles"),
        os.path.join(localappdata, "Mozilla", "Firefox", "Profiles"),
        os.path.join(localappdata, "Packages", "Mozilla.Firefox_n80bbvh6b1yt2", "LocalCache", "Roaming", "Mozilla", "Firefox", "Profiles")
    ]
    
    for base_dir in candidate_profile_dirs:
        if not os.path.exists(base_dir):
            continue
        for prof in glob.glob(os.path.join(base_dir, "*")):
            cpath = os.path.join(prof, "cookies.sqlite")
            if os.path.exists(cpath):
                temp_db = tempfile.mktemp(prefix='ff_cookie_', suffix='.sqlite')
                try:
                    shutil.copy2(cpath, temp_db)
                    conn = sqlite3.connect(temp_db)
                    cursor = conn.cursor()
                    cursor.execute("SELECT name, value FROM moz_cookies WHERE host LIKE '%instagram.com%'")
                    for name, val in cursor.fetchall():
                        if val and (name not in cookies):
                            cookies[name] = val
                    conn.close()
                    if cookies.get("sessionid"):
                        sys.stderr.write(f"Found active Instagram session in Firefox profile: {os.path.basename(prof)}\n")
                        break
                except Exception as e:
                    sys.stderr.write(f"Firefox cookie read error in {prof}: {e}\n")
                finally:
                    if os.path.exists(temp_db):
                        try:
                            os.remove(temp_db)
                        except Exception:
                            pass
        if cookies.get("sessionid"):
            break
            
    return cookies

def auto_extract_device_cookies():
    """
    Directly extracts Instagram session from local browsers (browser_cookie3, Chrome, Edge, Firefox).
    """
    try:
        import browser_cookie3
        for b_fn, name in [
            (browser_cookie3.chrome, "Google Chrome"),
            (browser_cookie3.edge, "Microsoft Edge"),
            (browser_cookie3.brave, "Brave Browser"),
            (browser_cookie3.firefox, "Mozilla Firefox")
        ]:
            try:
                cj = b_fn(domain_name="instagram.com")
                cookies = {c.name: c.value for c in cj}
                if cookies.get("sessionid"):
                    sys.stderr.write(f"Found active Instagram session from {name} via browser_cookie3!\n")
                    return name, cookies
            except Exception:
                pass
    except Exception:
        pass

    # Direct extraction fallback
    localappdata = os.getenv("LOCALAPPDATA", "")
    browsers = [
        ("Google Chrome", os.path.join(localappdata, "Google", "Chrome", "User Data")),
        ("Microsoft Edge", os.path.join(localappdata, "Microsoft", "Edge", "User Data")),
        ("Brave Browser", os.path.join(localappdata, "BraveSoftware", "Brave-Browser", "User Data")),
        ("Opera", os.path.join(os.getenv("APPDATA", ""), "Opera Software", "Opera Stable"))
    ]
    
    for b_name, b_dir in browsers:
        if os.path.exists(b_dir):
            cookies = extract_cookies_from_chromium(b_dir)
            if cookies.get("sessionid"):
                return b_name, cookies
                
    ff_cookies = extract_cookies_from_firefox()
    if ff_cookies.get("sessionid"):
        return "Mozilla Firefox", ff_cookies
        
    return None, {}

def extract_media_info(url_or_code):
    """
    Parses URL or code and returns a dictionary with media type and target identifiers.
    Types: 'story', 'post', 'reel'
    """
    s = str(url_or_code).strip()
    
    # 1. Check for Highlight short-links: /s/<base64>/
    s_match = re.search(r'/s/([A-Za-z0-9_=-]+)', s)
    if s_match:
        b64 = s_match.group(1).replace('_', '/').replace('-', '+')
        b64 += '=' * ((4 - len(b64) % 4) % 4)
        try:
            decoded = base64.b64decode(b64).decode('utf-8', errors='ignore')
            m_hl = re.search(r'highlight:(\d+)', decoded)
            if m_hl:
                m_match = re.search(r'story_media_id=(\d+)', s)
                media_id = m_match.group(1) if m_match else None
                return {
                    "type": "highlight",
                    "highlight_id": m_hl.group(1),
                    "story_id": media_id,
                    "raw": s
                }
        except Exception:
            pass

    # 2. Check for Highlights: /stories/highlights/{highlight_id}/ or /highlight/{highlight_id}/
    hl_match = re.search(r'/(?:stories/highlights|highlights?)/([^/?#]+)', s)
    if hl_match:
        raw_hl = hl_match.group(1).replace("highlight:", "").replace("highlight%3A", "").strip()
        media_id = None
        m_match = re.search(r'story_media_id=(\d+)', s)
        if m_match:
            media_id = m_match.group(1)
        return {
            "type": "highlight",
            "highlight_id": raw_hl,
            "story_id": media_id,
            "raw": s
        }

    # 3. Check for general /username/highlight/{highlight_id}/
    u_hl_match = re.search(r'/[^/]+/highlight/([^/?#]+)', s)
    if u_hl_match:
        raw_hl = u_hl_match.group(1).replace("highlight:", "").replace("highlight%3A", "").strip()
        return {
            "type": "highlight",
            "highlight_id": raw_hl,
            "story_id": None,
            "raw": s
        }

    # 2. Check for story: /stories/username/story_id/
    story_match = re.search(r'/stories/([^/?#]+)(?:/(\d+|[A-Za-z0-9_-]+))?', s)
    if story_match:
        username_or_hl = story_match.group(1)
        story_id = story_match.group(2)
        return {
            "type": "story",
            "username": username_or_hl,
            "story_id": story_id,
            "raw": s
        }
        
    # Check for post / reel / tv
    match = re.search(r'/(?:reel|reels|p|tv)/([A-Za-z0-9_-]+)', s)
    if match:
        sc = match.group(1)
        is_p = "/p/" in s
        return {
            "type": "post" if is_p else "reel",
            "shortcode": sc,
            "raw": s
        }
        
    clean = s.split('?')[0].strip('/')
    if '/' in clean:
        clean = clean.split('/')[-1]
    return {
        "type": "post",
        "shortcode": clean,
        "raw": s
    }

def extract_shortcode(url_or_code):
    info = extract_media_info(url_or_code)
    return info.get("shortcode") or info.get("story_id") or str(url_or_code)

def find_available_sessions():
    candidate_dirs = [
        os.path.join(os.getenv("LOCALAPPDATA", ""), "Instaloader"),
        os.path.expanduser(r"~\AppData\Local\Instaloader"),
        os.path.expanduser("~/.config/instaloader"),
        os.path.dirname(os.path.abspath(__file__)),
        os.getcwd(),
        tempfile.gettempdir()
    ]
    
    found_sessions = []
    for directory in candidate_dirs:
        if directory and os.path.exists(directory):
            matches = glob.glob(os.path.join(directory, "session-*"))
            for m in matches:
                if os.path.isfile(m) and m not in [s[1] for s in found_sessions]:
                    username = os.path.basename(m).replace("session-", "")
                    found_sessions.append((username, m))
    return found_sessions

def apply_cookies_txt(L, cookie_path):
    if os.path.exists(cookie_path):
        try:
            jar = MozillaCookieJar(cookie_path)
            jar.load(ignore_discard=True, ignore_expires=True)
            L.context._session.cookies.update(jar)
            sys.stderr.write(f"Loaded cookies from: {cookie_path}\n")
            return True
        except Exception as e:
            sys.stderr.write(f"Failed to load cookie file {cookie_path}: {e}\n")
    return False

def extract_video_direct_from_html(session, reel_url):
    """
    Extracts video or photo stream URL directly from Instagram authenticated page HTML.
    """
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer": "https://www.instagram.com/",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin"
    }
    try:
        resp = session.get(reel_url, headers=headers, timeout=25)
        if resp.status_code != 200:
            return None
        
        html_text = resp.text
        
        # 1. Search for og:video / og:image meta tag
        og_video = re.search(r'<meta property="og:video" content="([^"]+)"', html_text)
        if og_video:
            return og_video.group(1).replace("&amp;", "&")
            
        og_image = re.search(r'<meta property="og:image" content="([^"]+)"', html_text)
        if og_image:
            return og_image.group(1).replace("&amp;", "&")
            
        # 2. Search for video_url in embedded JSON
        v_matches = re.findall(r'"video_url":\s*"([^"]+)"', html_text)
        if v_matches:
            for v in v_matches:
                cleaned = v.replace(r"\u0026", "&").replace(r"\/", "/")
                if "mp4" in cleaned or "cdninstagram.com" in cleaned or "fbcdn.net" in cleaned:
                    return cleaned
                    
        # 3. Search for any direct mp4 link on cdninstagram / fbcdn
        mp4_matches = re.findall(r'https:[^"\'<>\s]+?\.(?:mp4|mp4\?[^"\'<>\s]+)', html_text)
        for m in mp4_matches:
            cleaned = m.replace(r"\u0026", "&").replace(r"\/", "/")
            if "cdninstagram" in cleaned or "fbcdn" in cleaned:
                return cleaned
                
        # 4. Search for video_versions or display_url in embedded JSON
        json_matches = re.findall(r'<script type="application/json"[^>]*>(.*?)</script>', html_text, re.DOTALL)
        for jm in json_matches:
            if "video_versions" in jm or "video_url" in jm or "display_url" in jm:
                try:
                    data = json.loads(jm)
                    def find_media_url(obj):
                        if isinstance(obj, dict):
                            if "video_versions" in obj and isinstance(obj["video_versions"], list) and len(obj["video_versions"]) > 0:
                                return obj["video_versions"][0].get("url")
                            if "video_url" in obj and obj["video_url"]:
                                return obj["video_url"]
                            if "display_url" in obj and obj["display_url"]:
                                return obj["display_url"]
                            for val in obj.values():
                                res = find_media_url(val)
                                if res: return res
                        elif isinstance(obj, list):
                            for item in obj:
                                res = find_media_url(item)
                                if res: return res
                        return None
                    found = find_media_url(data)
                    if found:
                        return found.replace(r"\u0026", "&").replace(r"\/", "/")
                except Exception:
                    pass
    except Exception as e:
        sys.stderr.write(f"HTML stream extraction error: {e}\n")
        
    return None

def is_valid_media_file(filepath, min_size_bytes=50*1024):
    """
    Validates that the file is a complete, valid MP4 video or JPG/PNG image file.
    """
    if not filepath or not os.path.exists(filepath):
        return False
    try:
        size = os.path.getsize(filepath)
        if size < min_size_bytes:
            return False
        with open(filepath, "rb") as f:
            header = f.read(128)
            # MP4 validation
            if b"moof" in header[:16]:
                return False
            if b"ftyp" in header or b"moov" in header:
                return True
            # JPEG validation (FF D8) or PNG validation (89 50 4E 47) or WebP
            if header.startswith(b"\xff\xd8") or header.startswith(b"\x89PNG") or b"WEBP" in header:
                return True
    except Exception:
        pass
    return False

def is_valid_mp4_file(filepath, min_size_bytes=200*1024):
    return is_valid_media_file(filepath, min_size_bytes)

def download_private_reel(url_or_code, output_dir="downloads", explicit_sessionid=None):
    """
    Universal Downloader for Reels, Posts, Photos, Carousels, and Stories.
    """
    media_info = extract_media_info(url_or_code)
    media_type = media_info.get("type", "reel")
    raw_shortcode = media_info.get("shortcode") or media_info.get("story_id") or "media"
    os.makedirs(output_dir, exist_ok=True)
    
    # Candidate shortcodes (full and clean 11-character for mobile share URLs)
    candidate_shortcodes = [raw_shortcode]
    if len(raw_shortcode) > 11:
        candidate_shortcodes.append(raw_shortcode[:11])

    shortcode = candidate_shortcodes[-1] if len(raw_shortcode) > 11 else raw_shortcode
    
    if media_type == "story":
        full_url = str(url_or_code).strip()
    elif media_type == "post":
        full_url = f"https://www.instagram.com/p/{shortcode}/"
    else:
        full_url = f"https://www.instagram.com/reel/{shortcode}/"

    L = instaloader.Instaloader(
        dirname_pattern=output_dir,
        filename_pattern="{shortcode}",
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        compress_json=False,
        post_metadata_txt_pattern="",
        quiet=True,
        max_connection_attempts=1,
        request_timeout=8.0
    )
    L.context.max_connection_attempts = 1
    L.context.request_timeout = 8.0

    logged_in_user = None
    session_loaded = False

    # 1. Try explicit sessionid if provided in request
    if explicit_sessionid and len(str(explicit_sessionid).strip()) > 0:
        clean_sid = str(explicit_sessionid).strip().replace("sessionid=", "")
        L.context._session.cookies.set("sessionid", clean_sid, domain=".instagram.com")
        if "%3A" in clean_sid or ":" in clean_sid:
            uid = clean_sid.split("%3A")[0].split(":")[0]
            if uid.isdigit():
                L.context._session.cookies.set("ds_user_id", uid, domain=".instagram.com")
        session_loaded = True
        logged_in_user = "Connected Account Session"
        sys.stderr.write("Applied provided sessionid cookie from client request\n")

    # 2. Try loading Instaloader saved session file
    if not session_loaded:
        sessions = find_available_sessions()
        for uname, session_path in sessions:
            try:
                L.load_session_from_file(uname, session_path)
                sid_check = L.context._session.cookies.get("sessionid")
                if sid_check and len(str(sid_check).strip()) > 5:
                    logged_in_user = uname
                    session_loaded = True
                    sys.stderr.write(f"Loaded valid Instaloader session for user: @{uname} from {session_path}\n")
                    break
            except Exception:
                pass
    # 3. Try auto-extracting from device browsers (browser_cookie3, Chrome, Edge, Firefox)
    if not session_loaded:
        try:
            b_name, b_cookies = auto_extract_device_cookies()
            if b_cookies and b_cookies.get("sessionid"):
                sid_val = str(b_cookies["sessionid"]).strip()
                if len(sid_val) > 10:
                    L.context._session.cookies.set("sessionid", sid_val, domain=".instagram.com")
                    if b_cookies.get("ds_user_id"):
                        L.context._session.cookies.set("ds_user_id", str(b_cookies["ds_user_id"]), domain=".instagram.com")
                    session_loaded = True
                    logged_in_user = f"{b_name} Browser"
                    sys.stderr.write(f"Auto-applied active Instagram session from {b_name} on device!\n")
        except Exception as be:
            sys.stderr.write(f"Device browser cookie extraction notice: {be}\n")

    if not session_loaded:
        if media_type == "highlight":
            return {
                "success": False,
                "error": "Instagram Restriction: Instagram requires a connected account session to view and download Story Highlights (even on public accounts). Please click 'Connect Account' in the header to paste your sessionid or log in."
            }
        elif media_type == "story":
            return {
                "success": False,
                "error": "Instagram Restriction: Instagram requires a connected account session to view and download Stories (even on public accounts). Please click 'Connect Account' in the header to paste your sessionid or log in."
            }
        return {
            "success": False,
            "error": "Authentication required: This media requires a connected Instagram account. Please click 'Connect Account' in the header to connect your account or paste your sessionid."
        }

    # ==================== STORIES PIPELINE (ULTRA-FAST DIRECT API + GRAPHQL) ====================
    if media_type == "story":
        story_username = media_info.get("username", "").strip()
        story_target_id = media_info.get("story_id", "")
        sys.stderr.write(f"[Story Engine] Fast processing story for @{story_username} (Target ID: {story_target_id})...\n")
        
        api_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            "x-ig-app-id": "936619743392459",
            "Referer": f"https://www.instagram.com/stories/{story_username}/"
        }
        dl_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            "Accept": "*/*"
        }

        user_id = None

        # --- STEP 1: RESOLVE USER ID VIA FAST UNTHROTTLED TOPSEARCH ---
        try:
            search_url = f"https://www.instagram.com/api/v1/web/search/topsearch/?context=blended&query={story_username}"
            s_res = L.context._session.get(search_url, headers=api_headers, timeout=6)
            if s_res.status_code == 200:
                s_data = s_res.json()
                for u in s_data.get("users", []):
                    u_info = u.get("user", {})
                    if str(u_info.get("username", "")).lower() == story_username.lower():
                        user_id = str(u_info.get("pk") or u_info.get("id"))
                        sys.stderr.write(f"[Story Engine] Resolved user ID {user_id} for @{story_username} via topsearch!\n")
                        break
        except Exception as se:
            sys.stderr.write(f"[Story Engine] Topsearch lookup error: {se}\n")

        # --- STEP 2: FALLBACK USER ID LOOKUP VIA REELS TRAY ---
        if not user_id:
            try:
                tray_res = L.context._session.get("https://i.instagram.com/api/v1/feed/reels_tray/", headers=api_headers, timeout=6)
                if tray_res.status_code == 200:
                    tray_data = tray_res.json()
                    for item in tray_data.get("tray", []):
                        u_info = item.get("user", {})
                        if str(u_info.get("username", "")).lower() == story_username.lower():
                            user_id = str(item.get("id") or u_info.get("pk"))
                            sys.stderr.write(f"[Story Engine] Resolved user ID {user_id} for @{story_username} via reels tray!\n")
                            break
            except Exception as te:
                sys.stderr.write(f"[Story Engine] Reels tray lookup error: {te}\n")

        # --- STEP 3: FALLBACK USER ID LOOKUP VIA WEB PROFILE INFO ---
        if not user_id:
            try:
                prof_res = L.context._session.get(f"https://www.instagram.com/api/v1/users/web_profile_info/?username={story_username}", headers=api_headers, timeout=6)
                if prof_res.status_code == 200:
                    p_data = prof_res.json()
                    user_id = p_data.get("data", {}).get("user", {}).get("id")
                    if user_id:
                        sys.stderr.write(f"[Story Engine] Resolved user ID {user_id} for @{story_username} via profile info\n")
            except Exception as pe:
                sys.stderr.write(f"[Story Engine] Profile API lookup error: {pe}\n")

        # --- STEP 4: FETCH STORY ITEMS VIA REELS MEDIA API ---
        if user_id:
            try:
                reels_res = L.context._session.get(f"https://i.instagram.com/api/v1/feed/reels_media/?reel_ids={user_id}", headers=api_headers, timeout=8)
                if reels_res.status_code == 200:
                    reels_data = reels_res.json()
                    reels_media = reels_data.get("reels_media", [])
                    if reels_media and len(reels_media) > 0:
                        items = reels_media[0].get("items", [])
                        matching_item = None
                        if story_target_id:
                            for it in items:
                                if str(it.get("pk", "")) == str(story_target_id) or str(it.get("id", "")).split("_")[0] == str(story_target_id):
                                    matching_item = it
                                    break
                        if not matching_item and items:
                            matching_item = items[-1] # latest story

                        if matching_item:
                            is_vid = matching_item.get("media_type") == 2 or "video_versions" in matching_item
                            media_url = None
                            if is_vid and matching_item.get("video_versions"):
                                media_url = matching_item["video_versions"][0].get("url")
                            elif matching_item.get("image_versions2", {}).get("candidates"):
                                media_url = matching_item["image_versions2"]["candidates"][0].get("url")

                            if media_url:
                                ext = "mp4" if is_vid else "jpg"
                                pk = matching_item.get("pk") or story_target_id or "latest"
                                story_filename = f"story_{story_username}_{pk}.{ext}"
                                story_filepath = os.path.join(output_dir, story_filename)

                                sys.stderr.write(f"[Story Engine] Downloading story media: {media_url[:60]}...\n")
                                dl_res = L.context._session.get(media_url, headers=dl_headers, stream=True, timeout=20)
                                if dl_res.status_code == 200:
                                    with open(story_filepath, "wb") as f:
                                        for chunk in dl_res.iter_content(128 * 1024):
                                            if chunk: f.write(chunk)
                                    if is_valid_media_file(story_filepath, min_size_bytes=10*1024):
                                        stats = os.stat(story_filepath)
                                        return {
                                            "success": True,
                                            "mediaType": "story",
                                            "contentType": "video" if is_vid else "image",
                                            "filename": story_filename,
                                            "fileSize": stats.st_size,
                                            "owner": story_username,
                                            "caption": f"Instagram Story by @{story_username}",
                                            "preview": media_url,
                                            "accountUsed": logged_in_user or story_username
                                        }
            except Exception as rme:
                sys.stderr.write(f"[Story Engine] Reels media API error: {rme}\n")

        # --- STEP 5: PLAYWRIGHT HEADLESS INTERCEPTION (FOR CONFIRMATION DIALOGS & PRIVATE ACCOUNTS) ---
        try:
            from playwright.sync_api import sync_playwright
            sys.stderr.write(f"[Story Engine] Launching Playwright stream interceptor for story @{story_username}...\n")
            captured_story_media = []
            
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                context = browser.new_context(
                    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                    viewport={"width": 1280, "height": 800}
                )
                
                cookie_list = []
                for c_name, c_val in L.context._session.cookies.items():
                    cookie_list.append({
                        "name": c_name,
                        "value": c_val,
                        "domain": ".instagram.com",
                        "path": "/"
                    })
                context.add_cookies(cookie_list)
                page = context.new_page()

                def on_story_response(response):
                    try:
                        r_url = response.url
                        ct = response.headers.get("content-type", "")
                        cl = int(response.headers.get("content-length", "0") or "0")
                        
                        # GraphQL story response
                        if "graphql" in r_url or "reels_media" in r_url or "api/v1" in r_url:
                            try:
                                g_data = response.json()
                                def parse_g_media(obj):
                                    if isinstance(obj, dict):
                                        if "video_versions" in obj and isinstance(obj["video_versions"], list) and len(obj["video_versions"]) > 0:
                                            return obj["video_versions"][0].get("url"), "video"
                                        if "image_versions2" in obj and "candidates" in obj["image_versions2"] and len(obj["image_versions2"]["candidates"]) > 0:
                                            return obj["image_versions2"]["candidates"][0].get("url"), "image"
                                        for v in obj.values():
                                            res = parse_g_media(v)
                                            if res: return res
                                    elif isinstance(obj, list):
                                        for el in obj:
                                            res = parse_g_media(el)
                                            if res: return res
                                    return None
                                g_found = parse_g_media(g_data)
                                if g_found:
                                    captured_story_media.append((5000000, g_found[0], g_found[1]))
                            except Exception:
                                pass

                        # Direct video / image response
                        if ("cdninstagram.com" in r_url or "fbcdn.net" in r_url) and ("video" in ct or ".mp4" in r_url):
                            captured_story_media.append((cl or 2000000, r_url, "video"))
                        elif ("cdninstagram.com" in r_url or "fbcdn.net" in r_url) and ("image" in ct or ".jpg" in r_url or ".webp" in r_url):
                            if cl > 40 * 1024 or "1080x" in r_url:
                                captured_story_media.append((cl or 100000, r_url, "image"))
                    except Exception:
                        pass

                page.on("response", on_story_response)
                
                story_nav_url = f"https://www.instagram.com/stories/{story_username}/"
                if story_target_id:
                    story_nav_url = f"https://www.instagram.com/stories/{story_username}/{story_target_id}/"

                sys.stderr.write(f"[Story Engine] Navigating to {story_nav_url}...\n")
                page.goto(story_nav_url, wait_until="domcontentloaded", timeout=10000)

                # Click "View story" button if present
                try:
                    view_btn = page.locator("button:has-text('View story'), div[role='button']:has-text('View story'), text='View story'").first
                    if view_btn.is_visible(timeout=2500):
                        view_btn.click(timeout=2500)
                        sys.stderr.write("[Story Engine] Clicked 'View story' confirmation button\n")
                except Exception:
                    pass

                page.wait_for_timeout(3000)
                browser.close()

            if captured_story_media:
                videos = [m for m in captured_story_media if m[2] == "video"]
                images = [m for m in captured_story_media if m[2] == "image"]
                
                target_media = None
                if videos:
                    target_media = sorted(videos, key=lambda x: x[0], reverse=True)[0]
                elif images:
                    target_media = sorted(images, key=lambda x: x[0], reverse=True)[0]

                if target_media:
                    m_len, m_url, m_type = target_media
                    is_vid = (m_type == "video")
                    ext = "mp4" if is_vid else "jpg"
                    pk = story_target_id or "latest"
                    story_filename = f"story_{story_username}_{pk}.{ext}"
                    story_filepath = os.path.join(output_dir, story_filename)

                    sys.stderr.write(f"[Story Engine] Downloading intercepted {m_type} stream: {m_url[:60]}...\n")
                    dl_res = L.context._session.get(m_url, headers=dl_headers, stream=True, timeout=20)
                    if dl_res.status_code == 200:
                        with open(story_filepath, "wb") as f:
                            for chunk in dl_res.iter_content(128 * 1024):
                                if chunk: f.write(chunk)
                        if is_valid_media_file(story_filepath, min_size_bytes=10*1024):
                            stats = os.stat(story_filepath)
                            return {
                                "success": True,
                                "mediaType": "story",
                                "contentType": "video" if is_vid else "image",
                                "filename": story_filename,
                                "fileSize": stats.st_size,
                                "owner": story_username,
                                "caption": f"Instagram Story by @{story_username}",
                                "preview": m_url,
                                "accountUsed": logged_in_user or story_username
                            }
        except Exception as pw_err:
            sys.stderr.write(f"[Story Engine Playwright Error]: {pw_err}\n")

        # Early return for stories so it does NOT hang on post/reel fallbacks!
        return {
            "success": False,
            "error": f"No active story found for @{story_username} in the last 24 hours (or this account is private and not followed by your connected account)."
        }

    # ==================== HIGHLIGHTS PIPELINE (DIRECT REELS MEDIA + PLAYWRIGHT) ====================
    if media_type == "highlight":
        highlight_id = media_info.get("highlight_id", "").strip()
        story_target_id = media_info.get("story_id", "")
        sys.stderr.write(f"[Highlight Engine] Processing highlight {highlight_id} (Target Item: {story_target_id})...\n")

        api_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            "x-ig-app-id": "936619743392459",
            "Referer": f"https://www.instagram.com/stories/highlights/{highlight_id}/"
        }
        dl_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            "Accept": "*/*"
        }

        # --- STRATEGY A: DIRECT REELS MEDIA API (INSTANT < 1 SECOND) ---
        try:
            hl_query_id = f"highlight:{highlight_id}" if not highlight_id.startswith("highlight:") else highlight_id
            reels_res = None
            for base_domain in ["https://www.instagram.com", "https://i.instagram.com"]:
                try:
                    r_candidate = L.context._session.get(f"{base_domain}/api/v1/feed/reels_media/?reel_ids={hl_query_id}", headers=api_headers, timeout=8)
                    if r_candidate.status_code == 200:
                        reels_res = r_candidate
                        break
                except Exception:
                    pass

            if reels_res and reels_res.status_code == 200:
                reels_data = reels_res.json()
                reels_media = reels_data.get("reels_media")
                if not reels_media and "reels" in reels_data:
                    reels_media = list(reels_data["reels"].values())
                
                if reels_media and len(reels_media) > 0:
                    reel_obj = reels_media[0]
                    items = reel_obj.get("items", [])
                    owner_name = reel_obj.get("user", {}).get("username") or "creator"
                    hl_title = reel_obj.get("title") or "Story Highlight"

                    if items:
                        sys.stderr.write(f"[Highlight Engine] Found {len(items)} items in highlight '{hl_title}' by @{owner_name}\n")
                        
                        tasks = []
                        idx = 1
                        for it in items:
                            it_pk = str(it.get("pk") or it.get("id") or idx)
                            is_vid = it.get("media_type") == 2 or "video_versions" in it
                            media_url = None
                            if is_vid and it.get("video_versions"):
                                media_url = it["video_versions"][0].get("url")
                            elif it.get("image_versions2", {}).get("candidates"):
                                media_url = it["image_versions2"]["candidates"][0].get("url")

                            if media_url:
                                ext = "mp4" if is_vid else "jpg"
                                item_filename = f"highlight_{highlight_id}_{idx}_{it_pk}.{ext}"
                                item_filepath = os.path.join(output_dir, item_filename)
                                is_target = not story_target_id or it_pk == str(story_target_id) or str(it.get("id", "")).split("_")[0] == str(story_target_id)
                                tasks.append((idx, is_vid, media_url, item_filename, item_filepath, is_target))
                            idx += 1

                        targeted_tasks = [t for t in tasks if t[5]]
                        final_tasks = [(t[0], t[1], t[2], t[3], t[4]) for t in (targeted_tasks if targeted_tasks else tasks)]

                        def download_single_highlight(task):
                            t_idx, t_is_vid, t_url, t_fname, t_fpath = task
                            # Check if already downloaded and valid
                            if is_valid_media_file(t_fpath, min_size_bytes=10*1024):
                                return {
                                    "index": t_idx,
                                    "type": "video" if t_is_vid else "image",
                                    "filename": t_fname,
                                    "fileSize": os.path.getsize(t_fpath),
                                    "preview": t_url
                                }
                            try:
                                dl_res = L.context._session.get(t_url, headers=dl_headers, stream=True, timeout=30)
                                if dl_res.status_code == 200:
                                    with open(t_fpath, "wb") as f:
                                        for chunk in dl_res.iter_content(128 * 1024):
                                            if chunk: f.write(chunk)
                                    if is_valid_media_file(t_fpath, min_size_bytes=10*1024):
                                        return {
                                            "index": t_idx,
                                            "type": "video" if t_is_vid else "image",
                                            "filename": t_fname,
                                            "fileSize": os.path.getsize(t_fpath),
                                            "preview": t_url
                                        }
                            except Exception as dl_e:
                                sys.stderr.write(f"[Highlight Engine] Error downloading item {t_idx}: {dl_e}\n")
                            return None

                        sys.stderr.write(f"[Highlight Engine] Starting parallel download of {len(final_tasks)} items using thread pool...\n")
                        with ThreadPoolExecutor(max_workers=8) as executor:
                            results = list(executor.map(download_single_highlight, final_tasks))

                        downloaded_items = [r for r in results if r is not None]
                        downloaded_items.sort(key=lambda x: x["index"])

                        if downloaded_items:
                            total_size = sum(it.get("fileSize", 0) for it in downloaded_items)
                            return {
                                "success": True,
                                "mediaType": "highlight",
                                "contentType": downloaded_items[0]["type"],
                                "highlightId": highlight_id,
                                "highlightTitle": hl_title,
                                "shortcode": highlight_id,
                                "filename": downloaded_items[0]["filename"],
                                "fileSize": total_size,
                                "mediaCount": len(downloaded_items),
                                "items": downloaded_items,
                                "owner": owner_name,
                                "caption": f"Instagram Highlight: {hl_title} by @{owner_name}",
                                "preview": downloaded_items[0]["preview"],
                                "accountUsed": logged_in_user or owner_name
                            }
        except Exception as he:
            sys.stderr.write(f"[Highlight Engine API Error]: {he}\n")

        # --- STRATEGY B: PLAYWRIGHT HEADLESS INTERCEPTION ---
        try:
            from playwright.sync_api import sync_playwright
            sys.stderr.write(f"[Highlight Engine] Launching Playwright interceptor for highlight {highlight_id}...\n")
            captured_hl_media = []

            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                context = browser.new_context(
                    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                    viewport={"width": 1280, "height": 800}
                )

                cookie_list = []
                for c_name, c_val in L.context._session.cookies.items():
                    cookie_list.append({
                        "name": c_name,
                        "value": c_val,
                        "domain": ".instagram.com",
                        "path": "/"
                    })
                context.add_cookies(cookie_list)
                page = context.new_page()

                def on_hl_response(response):
                    try:
                        r_url = response.url
                        ct = response.headers.get("content-type", "")
                        cl = int(response.headers.get("content-length", "0") or "0")

                        # Intercept GraphQL / reels_media JSON
                        if "graphql" in r_url or "reels_media" in r_url or "api/v1" in r_url:
                            try:
                                g_data = response.json()
                                def parse_g_media(obj):
                                    found = []
                                    if isinstance(obj, dict):
                                        if "video_versions" in obj and isinstance(obj["video_versions"], list) and len(obj["video_versions"]) > 0:
                                            found.append((obj["video_versions"][0].get("url"), "video"))
                                        if "image_versions2" in obj and "candidates" in obj["image_versions2"] and len(obj["image_versions2"]["candidates"]) > 0:
                                            found.append((obj["image_versions2"]["candidates"][0].get("url"), "image"))
                                        for v in obj.values():
                                            found.extend(parse_g_media(v))
                                    elif isinstance(obj, list):
                                        for el in obj:
                                            found.extend(parse_g_media(el))
                                    return found
                                g_items = parse_g_media(g_data)
                                for m_url, m_type in g_items:
                                    if not any(x[1] == m_url for x in captured_hl_media):
                                        captured_hl_media.append((5000000, m_url, m_type))
                            except Exception:
                                pass

                        # Direct stream response
                        if ("cdninstagram.com" in r_url or "fbcdn.net" in r_url) and ("video" in ct or ".mp4" in r_url):
                            if not any(x[1] == r_url for x in captured_hl_media):
                                captured_hl_media.append((cl or 2000000, r_url, "video"))
                        elif ("cdninstagram.com" in r_url or "fbcdn.net" in r_url) and ("image" in ct or ".jpg" in r_url or ".webp" in r_url):
                            if (cl > 40 * 1024 or "1080x" in r_url) and not any(x[1] == r_url for x in captured_hl_media):
                                captured_hl_media.append((cl or 100000, r_url, "image"))
                    except Exception:
                        pass

                page.on("response", on_hl_response)
                hl_nav_url = f"https://www.instagram.com/stories/highlights/{highlight_id}/"
                sys.stderr.write(f"[Highlight Engine] Navigating to {hl_nav_url}...\n")
                page.goto(hl_nav_url, wait_until="domcontentloaded", timeout=10000)

                try:
                    view_btn = page.locator("button:has-text('View story'), div[role='button']:has-text('View story'), text='View story'").first
                    if view_btn.is_visible(timeout=2500):
                        view_btn.click(timeout=2500)
                        sys.stderr.write("[Highlight Engine] Clicked 'View story' button\n")
                except Exception:
                    pass

                page.wait_for_timeout(3500)
                browser.close()

            if captured_hl_media:
                downloaded_items = []
                idx = 1
                for m_len, m_url, m_type in captured_hl_media:
                    is_vid = (m_type == "video")
                    ext = "mp4" if is_vid else "jpg"
                    item_filename = f"highlight_{highlight_id}_{idx}.{ext}"
                    item_filepath = os.path.join(output_dir, item_filename)

                    sys.stderr.write(f"[Highlight Engine] Downloading intercepted item {idx}: {m_url[:60]}...\n")
                    dl_res = L.context._session.get(m_url, headers=dl_headers, stream=True, timeout=20)
                    if dl_res.status_code == 200:
                        with open(item_filepath, "wb") as f:
                            for chunk in dl_res.iter_content(128 * 1024):
                                if chunk: f.write(chunk)
                        if is_valid_media_file(item_filepath, min_size_bytes=10*1024):
                            downloaded_items.append({
                                "index": idx,
                                "type": m_type,
                                "filename": item_filename,
                                "fileSize": os.path.getsize(item_filepath),
                                "preview": m_url
                            })
                            idx += 1

                if downloaded_items:
                    total_size = sum(it.get("fileSize", 0) for it in downloaded_items)
                    return {
                        "success": True,
                        "mediaType": "highlight",
                        "contentType": downloaded_items[0]["type"],
                        "highlightId": highlight_id,
                        "highlightTitle": "Story Highlight",
                        "shortcode": highlight_id,
                        "filename": downloaded_items[0]["filename"],
                        "fileSize": total_size,
                        "mediaCount": len(downloaded_items),
                        "items": downloaded_items,
                        "owner": "Instagram User",
                        "caption": f"Instagram Highlight {highlight_id}",
                        "preview": downloaded_items[0]["preview"],
                        "accountUsed": logged_in_user or "Connected Account"
                    }
        except Exception as pw_err:
            sys.stderr.write(f"[Highlight Engine Playwright Error]: {pw_err}\n")

        return {
            "success": False,
            "error": f"No active story items found in highlight {highlight_id} (or this account is private and not followed by your connected account)."
        }

    final_file = os.path.join(output_dir, f"{shortcode}.mp4")

    # --- STRATEGY 1: INSTALOADER ENGINE ---
    for sc_try in candidate_shortcodes:
        try:
            sys.stderr.write(f"Querying Instaloader Post object for shortcode: {sc_try}...\n")
            post = instaloader.Post.from_shortcode(L.context, sc_try)
            
            # A. Carousel Album (Multi-Photo / Video Sidecar)
            if post.typename == 'GraphSidecar':
                sys.stderr.write(f"Detected Carousel Post with multiple items for {sc_try}!\n")
                items = []
                idx = 1
                for node in post.get_sidecar_nodes():
                    is_vid = node.is_video
                    ext = "mp4" if is_vid else "jpg"
                    item_filename = f"{sc_try}_{idx}.{ext}"
                    item_path = os.path.join(output_dir, item_filename)
                    item_url = node.video_url if is_vid else node.display_url
                    
                    if item_url:
                        headers = {
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                            "Referer": "https://www.instagram.com/"
                        }
                        resp = L.context._session.get(item_url, headers=headers, stream=True, timeout=35)
                        if resp.status_code == 200:
                            with open(item_path, "wb") as f:
                                for chunk in resp.iter_content(128 * 1024):
                                    if chunk: f.write(chunk)
                                    
                            if is_valid_media_file(item_path, min_size_bytes=10*1024):
                                items.append({
                                    "index": idx,
                                    "type": "video" if is_vid else "image",
                                    "filename": item_filename,
                                    "fileSize": os.path.getsize(item_path),
                                    "preview": node.display_url
                                })
                    idx += 1
                    
                if items:
                    return {
                        "success": True,
                        "mediaType": "carousel",
                        "shortcode": sc_try,
                        "filename": items[0]["filename"],
                        "fileSize": sum(it.get("fileSize", 0) for it in items),
                        "mediaCount": len(items),
                        "items": items,
                        "owner": post.owner_username,
                        "caption": (post.caption[:120] + "...") if post.caption else "",
                        "accountUsed": logged_in_user or post.owner_username
                    }

            # B. Single Photo Post
            elif not post.is_video:
                sys.stderr.write(f"Detected Single Photo Post for {sc_try}!\n")
                photo_filename = f"{sc_try}.jpg"
                photo_path = os.path.join(output_dir, photo_filename)
                
                headers = {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                    "Referer": "https://www.instagram.com/"
                }
                resp = L.context._session.get(post.url, headers=headers, stream=True, timeout=35)
                if resp.status_code == 200:
                    with open(photo_path, "wb") as f:
                        for chunk in resp.iter_content(128 * 1024):
                            if chunk: f.write(chunk)
                            
                    if is_valid_media_file(photo_path, min_size_bytes=10*1024):
                        stats = os.stat(photo_path)
                        return {
                            "success": True,
                            "mediaType": "photo",
                            "contentType": "image",
                            "shortcode": sc_try,
                            "filename": photo_filename,
                            "fileSize": stats.st_size,
                            "owner": post.owner_username,
                            "caption": (post.caption[:120] + "...") if post.caption else "",
                            "preview": post.url,
                            "accountUsed": logged_in_user or post.owner_username
                        }

            # C. Single Video / Reel
            else:
                video_url = post.video_url
                if video_url:
                    sys.stderr.write(f"Downloading video stream from Instaloader Post: {video_url[:60]}...\n")
                    headers = {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                        "Referer": "https://www.instagram.com/"
                    }
                    resp = L.context._session.get(video_url, headers=headers, stream=True, timeout=45)
                    if resp.status_code == 200:
                        with open(final_file, "wb") as f:
                            for chunk in resp.iter_content(chunk_size=128 * 1024):
                                if chunk: f.write(chunk)

                if is_valid_mp4_file(final_file, min_size_bytes=200*1024):
                    stats = os.stat(final_file)
                    return {
                        "success": True,
                        "mediaType": "video",
                        "contentType": "video",
                        "shortcode": sc_try,
                        "filename": os.path.basename(final_file),
                        "fileSize": stats.st_size,
                        "accountUsed": logged_in_user or (post.owner_username if post else "Active Account"),
                        "caption": (post.caption[:120] + "...") if post.caption else "",
                        "owner": post.owner_username,
                        "downloadMethod": "Instaloader Engine"
                    }
                else:
                    if os.path.exists(final_file):
                        try: os.remove(final_file)
                        except: pass
        except Exception as err:
            sys.stderr.write(f"Instaloader strategy error for {sc_try}: {err}\n")

    # --- STRATEGY 2: DIRECT AUTHENTICATED HTML PAGE STREAM ---
    for sc_try in candidate_shortcodes:
        try_url = full_url
        direct_stream_url = extract_video_direct_from_html(L.context._session, try_url)
        if direct_stream_url:
            sys.stderr.write(f"Extracted direct stream URL for {sc_try}: {direct_stream_url[:60]}...\n")
            try:
                is_img = ".jpg" in direct_stream_url or ".png" in direct_stream_url or ".webp" in direct_stream_url
                ext = "jpg" if is_img else "mp4"
                target_f = os.path.join(output_dir, f"{sc_try}.{ext}")
                
                stream_headers = {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                    "Referer": "https://www.instagram.com/"
                }
                v_resp = L.context._session.get(direct_stream_url, headers=stream_headers, stream=True, timeout=40)
                if v_resp.status_code == 200:
                    with open(target_f, "wb") as vf:
                        for chunk in v_resp.iter_content(chunk_size=128 * 1024):
                            if chunk: vf.write(chunk)
                    if is_valid_media_file(target_f, min_size_bytes=10*1024):
                        stats = os.stat(target_f)
                        return {
                            "success": True,
                            "mediaType": "photo" if is_img else "video",
                            "shortcode": sc_try,
                            "filename": os.path.basename(target_f),
                            "fileSize": stats.st_size,
                            "accountUsed": logged_in_user or "Active Account",
                            "downloadMethod": "Direct Stream Extractor"
                        }
                    else:
                        if os.path.exists(target_f):
                            try: os.remove(target_f)
                            except: pass
            except Exception as se:
                sys.stderr.write(f"Stream download error: {se}\n")

    # --- STRATEGY 3: PLAYWRIGHT HEADLESS DOM / GRAPHQL MEDIA INTERCEPTOR ---
    try:
        from playwright.sync_api import sync_playwright
        sys.stderr.write(f"Attempting headless stream interception via Playwright for {full_url}...\n")
        captured_stream_candidates = []
        target_nav_url = full_url
        
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
            )
            
            cookie_list = []
            for c_name, c_val in L.context._session.cookies.items():
                cookie_list.append({
                    "name": c_name,
                    "value": c_val,
                    "domain": ".instagram.com",
                    "path": "/"
                })
            context.add_cookies(cookie_list)
            page = context.new_page()

            def on_response(response):
                try:
                    r_url = response.url
                    ct = response.headers.get("content-type", "")
                    cl = int(response.headers.get("content-length", "0") or "0")

                    # 1. Video response on CDN
                    if ("fbcdn.net" in r_url or "cdninstagram.com" in r_url) and ("video" in ct or ".mp4" in r_url):
                        captured_stream_candidates.append((cl, r_url, "video"))

                    # 2. Image response on CDN
                    elif ("fbcdn.net" in r_url or "cdninstagram.com" in r_url) and ("image" in ct or ".jpg" in r_url):
                        if cl > 50 * 1024:
                            captured_stream_candidates.append((cl, r_url, "image"))

                    # 3. Intercept GraphQL media response
                    if "graphql" in r_url or "api/v1" in r_url:
                        try:
                            g_data = response.json()
                            def find_media_in_json(obj):
                                if isinstance(obj, dict):
                                    if "video_versions" in obj and isinstance(obj["video_versions"], list) and len(obj["video_versions"]) > 0:
                                        return obj["video_versions"][0].get("url"), "video"
                                    if "video_url" in obj and obj["video_url"]:
                                        return obj["video_url"], "video"
                                    if "display_url" in obj and obj["display_url"]:
                                        return obj["display_url"], "image"
                                    for v in obj.values():
                                        res = find_media_in_json(v)
                                        if res: return res
                                elif isinstance(obj, list):
                                    for el in obj:
                                        res = find_media_in_json(el)
                                        if res: return res
                                return None
                            g_res = find_media_in_json(g_data)
                            if g_res:
                                captured_stream_candidates.append((10000000, g_res[0], g_res[1]))
                        except Exception:
                            pass
                except Exception:
                    pass

            page.on("response", on_response)
            try:
                page.goto(target_nav_url, wait_until="domcontentloaded", timeout=25000)
                page.wait_for_timeout(2000)

                # Auto-dismiss scraping warning or security checkpoints
                if "scraping_warning" in page.url or "challenge" in page.url or "checkpoint" in page.url:
                    try:
                        page.click('button:has-text("Dismiss"), [role="button"]:has-text("Dismiss"), button:has-text("Continue")', timeout=3000)
                        page.wait_for_timeout(2000)
                    except Exception:
                        pass
                    page.goto(target_nav_url, wait_until="networkidle", timeout=30000)
                    page.wait_for_timeout(3000)

                try:
                    page.click('button:has-text("Allow all cookies"), button:has-text("Accept")', timeout=2000)
                except Exception:
                    pass
                try:
                    page.click('article, [role="presentation"], video, img, svg[aria-label="Play"]', timeout=2000)
                except Exception:
                    pass
                page.wait_for_timeout(3500)
            except Exception:
                pass

            browser.close()

        # Sort candidate streams by content length descending
        captured_stream_candidates.sort(key=lambda x: x[0], reverse=True)
        for cl_try, stream_url, m_type in captured_stream_candidates[:4]:
            sys.stderr.write(f"Playwright attempting stream ({cl_try} bytes, {m_type}): {stream_url[:60]}...\n")
            try:
                ext = "jpg" if m_type == "image" else "mp4"
                pw_file = os.path.join(output_dir, f"{shortcode}.{ext}")
                s_headers = {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                    "Referer": "https://www.instagram.com/"
                }
                p_resp = L.context._session.get(stream_url, headers=s_headers, stream=True, timeout=40)
                if p_resp.status_code == 200:
                    with open(pw_file, "wb") as pf:
                        for chunk in p_resp.iter_content(chunk_size=128 * 1024):
                            if chunk: pf.write(chunk)
                    if is_valid_media_file(pw_file, min_size_bytes=10*1024):
                        stats = os.stat(pw_file)
                        return {
                            "success": True,
                            "mediaType": "photo" if m_type == "image" else "video",
                            "shortcode": shortcode,
                            "filename": os.path.basename(pw_file),
                            "fileSize": stats.st_size,
                            "accountUsed": logged_in_user or "Connected Session",
                            "downloadMethod": "Playwright Stream Interceptor"
                        }
                    else:
                        if os.path.exists(pw_file):
                            try: os.remove(pw_file)
                            except: pass
            except Exception as stream_err:
                sys.stderr.write(f"Stream candidate download error: {stream_err}\n")
    except Exception as pe:
        sys.stderr.write(f"Playwright interception error: {pe}\n")

    acc_info = f" (@{logged_in_user})" if (logged_in_user and logged_in_user not in ["Connected Account Session", "Connected Session", "Device Browser"]) else ""
    return {
        "success": False,
        "error": f"Instagram reported 'Content isn\\'t available'. Make sure your connected account{acc_info} follows this private account on Instagram (or verify that the post or highlight is still active).",
        "accountUsed": logged_in_user,
        "sessionFound": session_loaded
    }

def launch_browser_login(username=None, password=None):
    """
    Launches an official Instagram login browser window for 1-click on-device Instagram authentication.
    Automatically captures the session and saves it locally.
    """
    session_dir = tempfile.mkdtemp(prefix="ig_browser_login_")
    
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return {"success": False, "error": "Playwright is not installed."}

    try:
        import time
        with sync_playwright() as p:
            context = None
            for ch in ["chrome", "msedge", None]:
                try:
                    kw = {
                        "user_data_dir": session_dir,
                        "headless": False,
                        "args": [
                            "--window-size=560,780",
                            "--disable-blink-features=AutomationControlled",
                            "--no-sandbox"
                        ]
                    }
                    if ch:
                        kw["channel"] = ch
                    context = p.chromium.launch_persistent_context(**kw)
                    sys.stderr.write(f"Launched browser context using {ch or 'bundled chromium'}!\n")
                    break
                except Exception as b_err:
                    sys.stderr.write(f"Could not launch context with channel {ch}: {b_err}\n")

            if not context:
                return {"success": False, "error": "Could not launch Chrome or Edge browser window."}

            page = context.pages[0] if context.pages else context.new_page()
            try:
                page.goto("https://www.instagram.com/accounts/login/", timeout=30000)
                page.bring_to_front()
            except Exception as nav_err:
                sys.stderr.write(f"Navigation warning: {nav_err}\n")

            sys.stderr.write("Instagram login window opened. Waiting for login...\n")

            # If username and password are provided, auto-fill them into the login page
            if username and password:
                try:
                    sys.stderr.write(f"Auto-filling credentials for @{username}...\n")
                    # Accept cookies dialog if present
                    try:
                        page.click('button:has-text("Allow all cookies"), button:has-text("Accept"), button:has-text("Allow")', timeout=1500)
                    except Exception:
                        pass

                    user_input = page.locator('input[name="username"], input[name="email"], input[type="text"]').first
                    user_input.wait_for(timeout=8000)
                    user_input.fill(username)
                    page.wait_for_timeout(300)

                    pass_input = page.locator('input[name="password"], input[name="pass"], input[type="password"]').first
                    pass_input.wait_for(timeout=5000)
                    pass_input.fill(password)
                    page.wait_for_timeout(400)

                    submit_btn = page.locator('[role="button"]:has-text("Log in"), [role="button"]:has-text("Log In"), button[type="submit"]').first
                    if submit_btn.count() > 0 and submit_btn.is_visible():
                        submit_btn.click()
                    else:
                        page.keyboard.press("Enter")
                    sys.stderr.write("Credentials submitted in login browser window!\n")
                except Exception as fill_err:
                    sys.stderr.write(f"Auto-fill notice (user can enter manually): {fill_err}\n")
            
            captured_session = None
            user_id = ""
            consecutive_closed = 0

            def extract_active_cookies():
                nonlocal captured_session, user_id
                try:
                    for c in context.cookies():
                        if c.get("name") == "sessionid" and c.get("value") and len(str(c["value"]).strip()) > 5:
                            captured_session = str(c["value"]).strip()
                        if c.get("name") == "ds_user_id" and c.get("value") and len(str(c["value"]).strip()) > 0:
                            user_id = str(c["value"]).strip()
                except Exception:
                    pass

            for cycle in range(300): # wait up to 5 minutes
                try:
                    time.sleep(1)
                    extract_active_cookies()
                    if captured_session:
                        sys.stderr.write(f"Captured active Instagram session cookie for User {user_id}!\n")
                        break

                    has_open_page = False
                    try:
                        pages_list = context.pages
                        for pg in pages_list:
                            if not pg.is_closed():
                                has_open_page = True
                                try:
                                    pg.click('button:has-text("This Was Me"), button:has-text("This was me"), [role="button"]:has-text("This Was Me")', timeout=100)
                                except Exception:
                                    pass
                                try:
                                    pg.click('button:has-text("Not Now"), button:has-text("Save info"), button:has-text("Save Info"), [role="button"]:has-text("Save info"), [role="button"]:has-text("Not now")', timeout=100)
                                except Exception:
                                    pass
                    except Exception:
                        pass

                    if not has_open_page:
                        consecutive_closed += 1
                        if consecutive_closed >= 4:
                            sys.stderr.write("Browser window closed by user.\n")
                            break
                    else:
                        consecutive_closed = 0

                except Exception:
                    pass

            if captured_session:
                try:
                    L = instaloader.Instaloader(quiet=True)
                    L.context._session.cookies.set("sessionid", captured_session, domain=".instagram.com")
                    if user_id:
                        L.context._session.cookies.set("ds_user_id", str(user_id), domain=".instagram.com")
                    save_name = user_id or username or "connected"
                    L.save_session_to_file(os.path.join(os.path.dirname(os.path.abspath(__file__)), f"session-{save_name}"))
                except Exception:
                    pass

            try:
                context.close()
            except Exception:
                pass

            if captured_session:
                return {
                    "success": True,
                    "message": "Instagram account connected successfully on this device!",
                    "account": username or (f"User {user_id}" if user_id else "Active Account"),
                    "sessionid": captured_session
                }
            else:
                return {
                    "success": False,
                    "error": "Login window was closed before Instagram login was completed. Please log in directly with your account credentials or paste your sessionid."
                }
    except Exception as e:
        return {
            "success": False,
            "error": f"Browser login error: {str(e)}"
        }
    finally:
        if os.path.exists(session_dir):
            try:
                shutil.rmtree(session_dir, ignore_errors=True)
            except Exception:
                pass

def direct_login_account(username, password, verification_code=None):
    sys.stderr.write(f"[Auth Engine] Starting direct authentication for: @{username}...\n")
    
    # Strategy 1: Chrome Browser Stealth Login (Guaranteed sessionid capture)
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            stealth_args = [
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-infobars",
                "--disable-dev-shm-usage",
                "--lang=en-US,en"
            ]

            try:
                browser = p.chromium.launch(channel="chrome", headless=True, args=stealth_args)
            except Exception:
                browser = p.chromium.launch(headless=True, args=stealth_args)

            context = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                locale="en-US",
                viewport={"width": 1280, "height": 800}
            )

            # Mask automation fingerprints
            context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                window.chrome = { runtime: {} };
            """)

            page = context.new_page()
            sys.stderr.write("[Auth Engine] Navigating to Instagram login...\n")
            page.goto("https://www.instagram.com/accounts/login/", timeout=25000)
            page.wait_for_timeout(1000)

            # Accept cookies dialog if present
            try:
                page.click('button:has-text("Allow all cookies"), button:has-text("Accept"), button:has-text("Allow")', timeout=1500)
            except Exception:
                pass

            # Fill credentials (supports web React, modern mobile, and standard login forms)
            user_input = page.locator('input[name="username"], input[name="email"], input[type="text"]').first
            user_input.wait_for(timeout=10000)
            user_input.fill(username)
            page.wait_for_timeout(200)

            pass_input = page.locator('input[name="password"], input[name="pass"], input[type="password"]').first
            pass_input.wait_for(timeout=5000)
            pass_input.fill(password)
            page.wait_for_timeout(300)

            # Click Log in button
            submit_btn = page.locator('[role="button"]:has-text("Log in"), [role="button"]:has-text("Log In"), button[type="submit"], input[type="submit"]').first
            if submit_btn.count() > 0 and submit_btn.is_visible():
                submit_btn.click()
            else:
                page.keyboard.press("Enter")
            sys.stderr.write("[Auth Engine] Credentials submitted, waiting for Instagram authentication...\n")

            page.wait_for_timeout(3000)

            # Check for 2FA input
            is_2fa = False
            try:
                if page.locator('input[name="verificationCode"], input[name="security_code"]').is_visible(timeout=1500):
                    is_2fa = True
            except Exception:
                pass

            if is_2fa:
                if verification_code:
                    sys.stderr.write("[Auth Engine] Submitting 2FA verification code...\n")
                    two_fa_input = page.locator('input[name="verificationCode"], input[name="security_code"]').first
                    two_fa_input.fill(str(verification_code))
                    page.keyboard.press("Enter")
                    page.wait_for_timeout(3000)
                else:
                    browser.close()
                    return {
                        "success": False,
                        "twoFactorRequired": True,
                        "error": "Two-Factor Authentication (2FA) is enabled. Please enter the security code sent to your phone/authenticator."
                    }

            # Check for error text on page
            try:
                page_body = page.inner_text("body")
                if "login information you entered is incorrect" in page_body or "password was incorrect" in page_body or "Incorrect password" in page_body:
                    browser.close()
                    return {
                        "success": False,
                        "error": "The Instagram username or password entered is incorrect. Please check your credentials and try again."
                    }
            except Exception:
                pass

            # Wait dynamically up to 14 seconds for sessionid cookie
            sid_val = None
            user_id = ""
            for _ in range(14):
                # Auto-dismiss "This Was Me", "Save info", "Not Now"
                try:
                    page.click('button:has-text("This Was Me"), button:has-text("This was me"), [role="button"]:has-text("This Was Me")', timeout=300)
                except Exception:
                    pass
                try:
                    page.click('button:has-text("Not Now"), button:has-text("Save info"), button:has-text("Save Info"), [role="button"]:has-text("Save info"), [role="button"]:has-text("Not now")', timeout=300)
                except Exception:
                    pass

                cookies = context.cookies()
                sid_obj = next((c for c in cookies if c["name"] == "sessionid" and c.get("value") and len(str(c["value"]).strip()) > 5), None)
                if sid_obj and sid_obj.get("value"):
                    sid_val = sid_obj["value"].strip()
                    user_id = next((c["value"] for c in cookies if c["name"] == "ds_user_id"), "")
                    break

                curr_url = page.url
                if "challenge" in curr_url or "checkpoint" in curr_url or "auth_platform" in curr_url:
                    sys.stderr.write(f"[Auth Engine] Instagram challenge detected at: {curr_url}\n")
                    
                    try:
                        page.click('button:has-text("This Was Me"), button:has-text("This was me"), [role="button"]:has-text("This Was Me")', timeout=1000)
                        page.wait_for_timeout(1000)
                    except Exception:
                        pass

                    try:
                        send_btn = page.locator('button:has-text("Send security code"), button:has-text("Send code"), button:has-text("Send SMS"), button:has-text("Continue"), [role="button"]:has-text("Continue"), [role="button"]:has-text("Send security code")').first
                        if send_btn.count() > 0 and send_btn.is_visible():
                            send_btn.click()
                            page.wait_for_timeout(2000)
                    except Exception:
                        pass

                    if verification_code:
                        sys.stderr.write("[Auth Engine] Entering verification code on challenge page...\n")
                        code_input = page.locator('input[name="security_code"], input[name="verification_code"], input[type="tel"], input[inputmode="numeric"], input[name="verificationCode"]').first
                        if code_input.count() > 0 and code_input.is_visible():
                            code_input.fill(str(verification_code))
                            btn_sub = page.locator('button:has-text("Submit"), button:has-text("Confirm"), button:has-text("Next"), [role="button"]:has-text("Submit"), [role="button"]:has-text("Confirm")').first
                            if btn_sub.count() > 0 and btn_sub.is_visible():
                                btn_sub.click()
                            else:
                                page.keyboard.press("Enter")
                            page.wait_for_timeout(3500)
                            
                            cookies = context.cookies()
                            sid_obj = next((c for c in cookies if c["name"] == "sessionid" and c.get("value") and len(str(c["value"]).strip()) > 5), None)
                            if sid_obj and sid_obj.get("value"):
                                sid_val = sid_obj["value"].strip()
                                user_id = next((c["value"] for c in cookies if c["name"] == "ds_user_id"), "")
                                break

                    # Auto-dismiss / handle checkpoint for user
                    browser.close()
                    return {
                        "success": False,
                        "checkpoint": True,
                        "requiresCode": True,
                        "error": "Instagram Security Verification: Please open your Instagram app and tap 'This Was Me', or enter the 6-digit code sent to your phone/WhatsApp."
                    }

                page.wait_for_timeout(1000)

            browser.close()

            if sid_val:
                sys.stderr.write(f"[Auth Engine] Successfully captured active sessionid for @{username} (User {user_id})!\n")

                try:
                    L = instaloader.Instaloader(quiet=True)
                    L.context._session.cookies.set("sessionid", sid_val, domain=".instagram.com")
                    if user_id:
                        L.context._session.cookies.set("ds_user_id", str(user_id), domain=".instagram.com")
                    session_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), f"session-{username}")
                    L.save_session_to_file(session_file)
                except Exception:
                    pass

                return {
                    "success": True,
                    "account": username,
                    "sessionid": sid_val,
                    "message": f"Successfully connected as @{username}!"
                }
    except Exception as be:
        sys.stderr.write(f"[Auth Engine Headless Error]: {be}\n")

    # Strategy 2: Instaloader fallback login
    try:
        L = instaloader.Instaloader(quiet=True)
        session_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), f"session-{username}")
        if verification_code:
            L.two_factor_login(verification_code)
        else:
            L.login(username, password)
            
        L.save_session_to_file(session_file)
        
        sid = None
        for c in L.context._session.cookies:
            if c.name == "sessionid" and c.value and len(str(c.value).strip()) > 5:
                sid = c.value.strip()
                break

        if sid:
            L.save_session_to_file(session_file)
            return {
                "success": True,
                "account": username,
                "sessionid": sid,
                "message": f"Successfully connected as @{username}!"
            }
        else:
            if os.path.exists(session_file):
                try:
                    os.remove(session_file)
                except Exception:
                    pass
            return {
                "success": False,
                "error": "Instagram authentication did not issue an active session cookie. Please check your username/password or approve the login notification on your phone."
            }
    except instaloader.TwoFactorAuthRequiredException:
        return {
            "success": False,
            "twoFactorRequired": True,
            "error": "Two-Factor Authentication (2FA) is enabled. Please enter your 6-digit security code."
        }
    except Exception as e:
        err_msg = str(e)
        if "checkpoint" in err_msg.lower() or "auth_platform" in err_msg.lower():
            return {
                "success": False,
                "checkpoint": True,
                "requiresCode": True,
                "error": "Instagram Security Verification: Please open your Instagram app and tap 'This Was Me', or enter the 6-digit code sent to your phone/WhatsApp."
            }
        return {
            "success": False,
            "error": f"Login failed: {err_msg}"
        }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Reel URL or command is required"}))
        sys.exit(1)

    # Direct Account Login via JSON stdin (Immune to command line character corruption)
    if sys.argv[1] == "--account-login-stdin":
        try:
            raw_input = sys.stdin.read()
            data = json.loads(raw_input)
            uname = data.get("username", "")
            pwd = data.get("password", "")
            code = data.get("verificationCode", None)
            res = direct_login_account(uname, pwd, code)
            print(json.dumps(res))
        except Exception as err:
            print(json.dumps({"success": False, "error": f"Login input error: {str(err)}"}))
        sys.exit(0)

    # Direct Account Login Mode (Legacy CLI)
    if sys.argv[1] == "--account-login":
        uname = sys.argv[2] if len(sys.argv) > 2 else ""
        pwd = sys.argv[3] if len(sys.argv) > 3 else ""
        code = sys.argv[4] if len(sys.argv) > 4 else None
        res = direct_login_account(uname, pwd, code)
        print(json.dumps(res))
        sys.exit(0)

    # 1-Click Browser Login via JSON stdin
    if sys.argv[1] == "--browser-login-stdin":
        try:
            raw_input = sys.stdin.read()
            data = json.loads(raw_input) if raw_input.strip() else {}
            uname = data.get("username", None)
            pwd = data.get("password", None)
            res = launch_browser_login(uname, pwd)
            print(json.dumps(res))
        except Exception as err:
            print(json.dumps({"success": False, "error": f"Browser login input error: {str(err)}"}))
        sys.exit(0)

    # 1-Click Browser Login Mode (CLI)
    if sys.argv[1] == "--browser-login":
        uname = sys.argv[2] if len(sys.argv) > 2 else None
        pwd = sys.argv[3] if len(sys.argv) > 3 else None
        res = launch_browser_login(uname, pwd)
        print(json.dumps(res))
        sys.exit(0)

    # Check auth status mode
    if sys.argv[1] == "--check-auth":
        b_name, b_cookies = auto_extract_device_cookies()
        if b_name and b_cookies.get("sessionid"):
            u_id = b_cookies.get("ds_user_id", "")
            print(json.dumps({
                "success": True,
                "loggedIn": True,
                "account": f"User ID {u_id}" if u_id else "Active Browser",
                "source": f"{b_name} on device"
            }))
        else:
            sessions = find_available_sessions()
            if sessions:
                print(json.dumps({
                    "success": True,
                    "loggedIn": True,
                    "account": sessions[0][0],
                    "source": "Instaloader Session"
                }))
            else:
                print(json.dumps({
                    "success": True,
                    "loggedIn": False,
                    "account": None,
                    "source": None
                }))
        sys.exit(0)

    url_input = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "downloads"
    session_arg = sys.argv[3] if len(sys.argv) > 3 else None

    res = download_private_reel(url_input, out_dir, session_arg)
    print(json.dumps(res))

