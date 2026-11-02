#!/usr/bin/env python3
"""
Master A/B Tournament - Blind Mastering Shootout & King-of-the-Hill Evaluator
A sleek modern GUI tool for critical audio mastering A/B comparison.
"""

import os
import sys
import json
import time
import random
import re
import subprocess
import struct
import hashlib
import urllib.parse
import mimetypes
import threading
import webbrowser
import argparse
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from concurrent.futures import ThreadPoolExecutor

# Supported audio extensions
AUDIO_EXTENSIONS = {'.wav', '.aif', '.aiff', '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.caf', '.wma'}

# App root and web directories (resolving symlinks)
APP_DIR = Path(__file__).resolve().parent
WEB_DIR = APP_DIR / "web"

# Regex for master matching and strict unmastered exclusion
MASTER_REGEX = re.compile(r'master(?:ed)?', re.IGNORECASE)
UNMASTERED_REGEX = re.compile(r'un[\W_]?master(?:ed)?', re.IGNORECASE)

class AudioInspector:
    @staticmethod
    def probe_track(file_path: str) -> dict:
        """Probe audio file using ffprobe to get duration, format, sample rate, bit depth."""
        path_obj = Path(file_path)
        size_bytes = path_obj.stat().st_size
        size_mb = round(size_bytes / (1024 * 1024), 2)
        
        resolved_path = str(path_obj.resolve())
        stable_id = f"trk_{hashlib.sha256(resolved_path.encode('utf-8')).hexdigest()[:10]}"
        
        info = {
            "id": stable_id,
            "filename": path_obj.name,
            "filepath": resolved_path,
            "extension": path_obj.suffix.lower(),
            "size_mb": size_mb,
            "duration": 30.0,
            "sample_rate": 44100,
            "channels": 2,
            "bit_depth": 16,
            "codec_name": "unknown",
            "format_desc": f"{path_obj.suffix.upper()[1:]}",
            "midpoint": 15.0,
            "clip_start": 7.5,
            "clip_duration": 15.0
        }
        
        try:
            cmd = [
                'ffprobe', '-v', 'error',
                '-show_entries', 'format=duration,size,bit_rate',
                '-show_entries', 'stream=codec_name,sample_rate,channels,bits_per_raw_sample,bits_per_sample',
                '-of', 'json', file_path
            ]
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
            if res.returncode == 0:
                data = json.loads(res.stdout)
                fmt = data.get('format', {})
                streams = data.get('streams', [])
                audio_stream = next((s for s in streams if s.get('codec_name')), {})
                
                dur = float(fmt.get('duration', audio_stream.get('duration', 30.0)))
                info["duration"] = round(dur, 2)
                
                sr = int(audio_stream.get('sample_rate', 44100))
                info["sample_rate"] = sr
                
                ch = int(audio_stream.get('channels', 2))
                info["channels"] = ch
                
                # Bit depth detection
                bits = audio_stream.get('bits_per_raw_sample') or audio_stream.get('bits_per_sample')
                if bits and str(bits).isdigit():
                    info["bit_depth"] = int(bits)
                elif '24' in audio_stream.get('codec_name', ''):
                    info["bit_depth"] = 24
                elif '32' in audio_stream.get('codec_name', ''):
                    info["bit_depth"] = 32
                else:
                    info["bit_depth"] = 16
                    
                codec = audio_stream.get('codec_name', path_obj.suffix.lstrip('.')).upper()
                info["codec_name"] = codec
                
                # Format summary string, e.g. "WAV 24-bit 48kHz"
                sr_khz = f"{sr/1000:g}kHz"
                ch_str = "Stereo" if ch == 2 else ("Mono" if ch == 1 else f"{ch}ch")
                if "PCM" in codec or path_obj.suffix.lower() in ('.wav', '.aif', '.aiff'):
                    info["format_desc"] = f"WAV {info['bit_depth']}-bit {sr_khz} {ch_str}"
                else:
                    info["format_desc"] = f"{codec} {sr_khz} {ch_str}"
                    
                # Calculate midpoint 15s window
                mid = dur / 2.0
                info["midpoint"] = round(mid, 2)
                clip_dur = min(15.0, dur)
                info["clip_duration"] = round(clip_dur, 2)
                clip_start = max(0.0, mid - (clip_dur / 2.0))
                info["clip_start"] = round(clip_start, 2)
        except Exception:
            pass
            
        return info


def scan_master_tracks(folder_path: str) -> list:
    """Scan directory (and up to 2 subfolder levels) for master audio tracks."""
    found_files = []
    folder = Path(folder_path).expanduser().resolve()
    
    if not folder.exists() or not folder.is_dir():
        return []
        
    # Walk directory up to 2 levels deep
    root_depth = len(folder.parts)
    for root, dirs, files in os.walk(folder):
        current_depth = len(Path(root).parts)
        if current_depth - root_depth > 2:
            dirs.clear() # don't recurse deeper
            continue
            
        for file in files:
            # Skip hidden files or macOS resource forks
            if file.startswith('.') or file.startswith('._'):
                continue
                
            # Exclude anything that contains UNMASTERED (in filename or path)
            if UNMASTERED_REGEX.search(file) or UNMASTERED_REGEX.search(root):
                continue
                
            suffix = Path(file).suffix.lower()
            if suffix in AUDIO_EXTENSIONS:
                if MASTER_REGEX.search(file):
                    found_files.append(os.path.join(root, file))
                    
    # Probe all found tracks in parallel
    with ThreadPoolExecutor(max_workers=8) as executor:
        tracks = list(executor.map(AudioInspector.probe_track, found_files))
        
    # Sort tracks alphabetically by filename
    tracks.sort(key=lambda x: x["filename"].lower())
    return tracks


class TournamentManager:
    """Manages King-of-the-Hill elimination tournament state with strict blind testing."""
    def __init__(self):
        self.lock = threading.Lock()
        self.folder_path = ""
        self.all_tracks = []
        self.active_tracks = []
        self.queue = []
        self.current_king = None
        self.current_challenger = None
        self.current_match_index = 0
        self.total_matches = 0
        self.preview_duration = 15.0
        self.blind_map = {} # {'A': track_dict, 'B': track_dict}
        self.history = []
        self.status = "idle" # 'idle', 'ready', 'in_progress', 'completed'
        self.winner = None

    def load_folder(self, folder_path: str):
        with self.lock:
            self.folder_path = str(Path(folder_path).expanduser().resolve())
            self.all_tracks = scan_master_tracks(self.folder_path)
            self.status = "ready" if len(self.all_tracks) >= 2 else "insufficient"
            self.current_king = None
            self.current_challenger = None
            self.winner = None
            self.history = []
            return {
                "folder": self.folder_path,
                "total_found": len(self.all_tracks),
                "status": self.status,
                "tracks": self.all_tracks
            }

    def start_tournament(self, selected_ids: list, preview_duration: float = 15.0):
        with self.lock:
            tracks_by_id = {t["id"]: t for t in self.all_tracks}
            selected = [tracks_by_id[tid] for tid in selected_ids if tid in tracks_by_id]
            
            if len(selected) < 2:
                raise ValueError("At least 2 tracks are required to start a tournament.")
                
            self.preview_duration = preview_duration
            self.active_tracks = list(selected)
            # Shuffle contenders to ensure fairness
            shuffled = list(selected)
            random.shuffle(shuffled)
            
            # King of the hill: first 2 contenders face off
            self.current_king = shuffled[0]
            self.current_challenger = shuffled[1]
            self.queue = shuffled[2:]
            
            self.current_match_index = 1
            self.total_matches = len(selected) - 1
            self.history = []
            self.winner = None
            self.status = "in_progress"
            
            self._setup_current_match()
            return self.get_match_payload()

    def _setup_current_match(self):
        """Randomly assign King and Challenger to Candidate A and Candidate B."""
        options = [self.current_king, self.current_challenger]
        random.shuffle(options)
        self.blind_map = {
            'A': options[0],
            'B': options[1]
        }

    def vote(self, chosen_side: str):
        """Record winner of current match and advance tournament."""
        with self.lock:
            if self.status != "in_progress":
                raise ValueError("No tournament is currently in progress.")
                
            if chosen_side not in ('A', 'B'):
                raise ValueError("Invalid vote side. Must be 'A' or 'B'.")
                
            winning_track = self.blind_map[chosen_side]
            losing_side = 'B' if chosen_side == 'A' else 'A'
            losing_track = self.blind_map[losing_side]
            
            # Record match history
            match_record = {
                "match_number": self.current_match_index,
                "chosen_side": chosen_side,
                "winner_filename": winning_track["filename"],
                "winner_id": winning_track["id"],
                "loser_filename": losing_track["filename"],
                "loser_id": losing_track["id"],
                "side_a_filename": self.blind_map['A']["filename"],
                "side_b_filename": self.blind_map['B']["filename"],
            }
            self.history.append(match_record)
            
            # The winning track retains/becomes the King
            self.current_king = winning_track
            
            # Check if more challengers remain
            if self.queue:
                self.current_challenger = self.queue.pop(0)
                self.current_match_index += 1
                self._setup_current_match()
                return {
                    "completed": False,
                    "match": self.get_match_payload()
                }
            else:
                # Tournament finished! Crown the king!
                self.status = "completed"
                self.winner = self.current_king
                self.current_challenger = None
                return {
                    "completed": True,
                    "winner": self.winner,
                    "history": self.history,
                    "total_matches": self.total_matches
                }

    def get_match_payload(self):
        """Return match details for the GUI with filenames strictly blinded."""
        if not self.current_king or not self.current_challenger:
            return None
            
        track_a = self.blind_map['A']
        track_b = self.blind_map['B']
        
        # Calculate synchronized preview segment (middle 15s)
        dur_a = track_a["duration"]
        dur_b = track_b["duration"]
        
        mid_a = dur_a / 2.0
        mid_b = dur_b / 2.0
        clip_dur = self.preview_duration
        
        start_a = max(0.0, mid_a - (clip_dur / 2.0))
        start_b = max(0.0, mid_b - (clip_dur / 2.0))
        
        return {
            "match_number": self.current_match_index,
            "total_matches": self.total_matches,
            "preview_duration": clip_dur,
            "candidate_a": {
                "label": "Option 1",
                "clip_duration": round(clip_dur, 2),
            },
            "candidate_b": {
                "label": "Option 2",
                "clip_duration": round(clip_dur, 2),
            }
        }

    def get_clip_audio_data(self, side: str, custom_start: float = None, custom_duration: float = None) -> bytes:
        """Extract exact 15-second WAV clip for blind Candidate A or B using ffmpeg."""
        with self.lock:
            if side not in self.blind_map:
                raise ValueError(f"Unknown side: {side}")
            track = self.blind_map[side]
            
        filepath = track["filepath"]
        duration = custom_duration if custom_duration is not None else self.preview_duration
        
        if custom_start is not None:
            start_time = custom_start
        else:
            mid = track["duration"] / 2.0
            start_time = max(0.0, mid - (duration / 2.0))
            
        return extract_pcm_wav_clip(filepath, start_time, duration)


def extract_pcm_wav_clip(filepath: str, start_time: float, duration: float) -> bytes:
    """Run ffmpeg to extract an exact audio slice and return a fully compliant 16-bit PCM WAV."""
    cmd = [
        'ffmpeg', '-y',
        '-ss', f'{start_time:.3f}',
        '-t', f'{duration:.3f}',
        '-i', filepath,
        '-vn',
        '-c:a', 'pcm_s16le',
        '-ar', '44100',
        '-ac', '2',
        '-f', 'wav',
        'pipe:1'
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.decode('utf-8', errors='ignore')}")
        
    data = bytearray(proc.stdout)
    # Fix streaming WAV headers if length is 0xffffffff
    if len(data) >= 44 and data[:4] == b'RIFF':
        total_len = len(data)
        data[4:8] = struct.pack('<I', total_len - 8)
        pos = data.find(b'data')
        if pos != -1 and pos + 8 <= len(data):
            data[pos+4:pos+8] = struct.pack('<I', total_len - (pos + 8))
            
    return bytes(data)


# Global tournament instance
tournament = TournamentManager()


class AppServerHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Silence routine static polling logs for clean console
        if "/api/audio" in str(args):
            return
        super().log_message(format, *args)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        params = urllib.parse.parse_qs(parsed.query)

        if path == "/":
            self.serve_file("index.html", "text/html; charset=utf-8")
        elif path == "/app.css":
            self.serve_file("app.css", "text/css; charset=utf-8")
        elif path == "/app.js":
            self.serve_file("app.js", "application/javascript; charset=utf-8")
        elif path == "/api/status":
            self.send_json({
                "status": tournament.status,
                "folder": tournament.folder_path,
                "total_tracks": len(tournament.all_tracks),
                "tracks": tournament.all_tracks,
                "winner": tournament.winner,
                "match": tournament.get_match_payload() if tournament.status == "in_progress" else None
            })
        elif path == "/api/audio/clip":
            # Extract 15s clip for Option 1 (side A) or Option 2 (side B)
            side = params.get("side", ["A"])[0]
            try:
                clip_bytes = tournament.get_clip_audio_data(side)
                self.send_bytes_with_range(clip_bytes, "audio/wav")
            except Exception as e:
                self.send_error(500, f"Error generating audio clip: {str(e)}")
        elif path == "/api/audio/track_clip":
            # Track list audition preview before tournament starts
            track_id = params.get("track_id", [""])[0]
            tracks_by_id = {t["id"]: t for t in tournament.all_tracks}
            track = tracks_by_id.get(track_id)
            if not track:
                self.send_error(404, "Track not found")
                return
            try:
                mid = track["duration"] / 2.0
                start_time = max(0.0, mid - 7.5)
                clip_bytes = extract_pcm_wav_clip(track["filepath"], start_time, 15.0)
                self.send_bytes_with_range(clip_bytes, "audio/wav")
            except Exception as e:
                self.send_error(500, f"Error: {str(e)}")
        elif path == "/api/audio/full":
            # Stream full audio file with HTTP Range support for winner playback
            track_id = params.get("track_id", [""])[0]
            tracks_by_id = {t["id"]: t for t in tournament.all_tracks}
            track = tracks_by_id.get(track_id)
            if not track:
                self.send_error(404, "Track not found")
                return
            self.stream_audio_file(track["filepath"])
        else:
            self.send_error(404, "Not Found")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length > 0 else b"{}"
        try:
            data = json.loads(body.decode("utf-8")) if body else {}
        except Exception:
            data = {}

        if path == "/api/browse_folder":
            # Trigger native macOS folder picker dialog via osascript
            selected_path = prompt_native_mac_folder_picker()
            if selected_path:
                result = tournament.load_folder(selected_path)
                self.send_json({"success": True, "folder": selected_path, "data": result})
            else:
                self.send_json({"success": False, "cancelled": True})

        elif path == "/api/scan":
            folder_path = data.get("folder", "")
            if not folder_path:
                self.send_json({"error": "No folder provided"}, status=400)
                return
            result = tournament.load_folder(folder_path)
            self.send_json(result)

        elif path == "/api/tournament/start":
            track_ids = data.get("tracks") or [t["id"] for t in tournament.all_tracks]
            duration = float(data.get("duration", 15.0))
            try:
                match_data = tournament.start_tournament(track_ids, duration)
                self.send_json({"success": True, "match": match_data})
            except Exception as e:
                self.send_json({"error": str(e)}, status=400)

        elif path == "/api/tournament/vote":
            side = data.get("winner", "A")
            try:
                res = tournament.vote(side)
                self.send_json({"success": True, **res})
            except Exception as e:
                self.send_json({"error": str(e)}, status=400)

        elif path == "/api/reveal_in_finder":
            filepath = data.get("filepath", "")
            if filepath and os.path.exists(filepath):
                subprocess.run(['open', '-R', filepath])
                self.send_json({"success": True})
            else:
                self.send_json({"error": "File not found"}, status=404)

        elif path == "/api/copy_path":
            filepath = data.get("filepath", "")
            if filepath:
                proc = subprocess.Popen(['pbcopy'], stdin=subprocess.PIPE)
                proc.communicate(filepath.encode('utf-8'))
                self.send_json({"success": True})
            else:
                self.send_json({"error": "No path provided"}, status=400)

        else:
            self.send_error(404, "Not Found")

    def serve_file(self, filename: str, content_type: str):
        target_path = WEB_DIR / filename
        if not target_path.exists():
            fallback = Path("/Users/bryngordon/.gemini/antigravity/scratch/master-tournament/web") / filename
            if fallback.exists():
                target_path = fallback
            else:
                self.send_error(404, f"File {filename} not found (searched: {WEB_DIR})")
                return
            
        with open(target_path, "rb") as f:
            content = f.read()
            
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)

    def send_json(self, payload: dict, status: int = 200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def send_bytes_with_range(self, data: bytes, content_type: str = "audio/wav"):
        """Send byte array with HTTP 206 Partial Content / Range support for Safari/Chrome."""
        file_size = len(data)
        range_header = self.headers.get("Range")
        if range_header:
            match = re.match(r"bytes=(\d+)-(\d*)", range_header)
            if match:
                start = int(match.group(1))
                end = int(match.group(2)) if match.group(2) else file_size - 1
                end = min(end, file_size - 1)
                chunk = data[start:end+1]
                
                self.send_response(206)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                self.send_header("Content-Length", str(len(chunk)))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(chunk)
                return

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(file_size))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def stream_audio_file(self, filepath: str):
        """Stream audio with HTTP 206 Partial Content support."""
        if not os.path.exists(filepath):
            self.send_error(404, "Audio file not found")
            return
            
        file_size = os.path.getsize(filepath)
        mime, _ = mimetypes.guess_type(filepath)
        mime = mime or "audio/wav"
        
        range_header = self.headers.get("Range")
        if range_header:
            match = re.match(r"bytes=(\d+)-(\d*)", range_header)
            if match:
                start = int(match.group(1))
                end = int(match.group(2)) if match.group(2) else file_size - 1
                length = end - start + 1
                
                self.send_response(206)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                self.send_header("Content-Length", str(length))
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                
                with open(filepath, "rb") as f:
                    f.seek(start)
                    self.wfile.write(f.read(length))
                return

        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(file_size))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        with open(filepath, "rb") as f:
            while chunk := f.read(65536):
                self.wfile.write(chunk)


def prompt_native_mac_folder_picker() -> str:
    """Open native macOS Cocoa folder picker."""
    apple_script = 'POSIX path of (choose folder with prompt "Select Folder Containing Master Tracks")'
    try:
        proc = subprocess.run(['osascript', '-e', apple_script], capture_output=True, text=True, timeout=60)
        if proc.returncode == 0:
            return proc.stdout.strip()
    except Exception:
        pass
    return ""


def main():
    parser = argparse.ArgumentParser(
        description="Master A/B Tournament - Blind Mastering Shootout & King-of-the-Hill Evaluator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  master-ab                          # Open GUI and select folder
  master-ab ~/Music/Logic/Masters    # Launch GUI directly loaded with masters folder
  master-ab .                        # Scan current working directory
"""
    )
    parser.add_argument("folder", nargs="?", default=None, help="Path to folder containing MASTER/MASTERED tracks")
    parser.add_argument("--port", type=int, default=8282, help="Port to run GUI server on (default: 8282)")
    parser.add_argument("--no-browser", action="store_true", help="Do not automatically launch web browser")
    args = parser.parse_args()

    # Pre-scan if folder is supplied
    initial_folder = None
    if args.folder:
        folder_p = Path(args.folder).expanduser().resolve()
        if folder_p.exists() and folder_p.is_dir():
            initial_folder = str(folder_p)
            print(f"🎵 Pre-loading folder: {initial_folder}")
            tournament.load_folder(initial_folder)
            print(f"✅ Found {len(tournament.all_tracks)} master tracks.")
        else:
            print(f"⚠️ Warning: Specified folder '{args.folder}' does not exist or is not a directory.")

    # Find open port if 8282 is busy
    port = args.port
    server = None
    for p in range(port, port + 20):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", p), AppServerHandler)
            port = p
            break
        except OSError:
            continue
            
    if not server:
        print("❌ Could not bind to an available local port.")
        sys.exit(1)

    url = f"http://127.0.0.1:{port}"
    print("=" * 65)
    print(" 🎛️  MASTER A/B TOURNAMENT - STUDIO EVALUATION CONSOLE")
    print("=" * 65)
    print(f" 🚀 Running at: {url}")
    if initial_folder:
        print(f" 📁 Active folder: {initial_folder} ({len(tournament.all_tracks)} tracks detected)")
    print(" ⌨️  Press Ctrl+C to stop the server.")
    print("=" * 65)

    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 Stopping Master A/B Tournament. Have a great session!")
        server.server_close()


if __name__ == "__main__":
    main()
