# 🎛️ Master Clash — Blind Mastering Shootout & A/B Tournament

> **100% In-Browser & GitHub Pages Ready**: A sleek, client-side audio mastering A/B comparison console. Upload any batch of audio files to run an unbiased, blind king-of-the-hill tournament. Compare 15-second middle segments with seamless zero-latency A/B switching.

---

## 🌐 Deploy to GitHub Pages in 60 Seconds

Because **Master Clash** runs 100% in client-side Web Audio API (no server or backend needed), you can host it for free on GitHub Pages so anyone in the world can run blind master shootouts directly in their browser!

### Step 1: Create a GitHub Repository
1. Go to [github.com/new](https://github.com/new).
2. Name your repository (e.g. `master-clash` or `master-tournament`).
3. Leave it Public and click **Create repository**.

### Step 2: Push this Project
Run these commands in your terminal:
```bash
cd /Users/bryngordon/.gemini/antigravity/scratch/master-tournament

# Add your GitHub repository remote
git remote add origin https://github.com/<YOUR-USERNAME>/<YOUR-REPO>.git
git branch -M main
git add .
git commit -m "Initial commit: Master Clash GitHub Pages Shootout"
git push -u origin main
```

### Step 3: Enable GitHub Pages
1. In your GitHub repo, go to **Settings** → **Pages** (in the left sidebar).
2. Under **Build and deployment** → **Source**, select **Deploy from a branch**.
3. Under **Branch**, select **`main`** and folder **`/ (root)`**, then click **Save**.
4. In about 30 seconds, GitHub Pages will give you your live URL:
   `https://<YOUR-USERNAME>.github.io/<YOUR-REPO>/`

Share this link with your friends, clients, or bandmates!

---

## 🎧 Features

### 🔒 100% Private & In-Browser
- Audio files are decoded directly in the browser's memory using the **Web Audio API**.
- **Zero server uploads**: Audio never leaves the user's machine. Zero bandwidth costs, complete privacy, infinite scale.

### 📁 Drag & Drop Batch Upload & Automatic Filtering
- **Drag & drop** any number of audio files (`.wav`, `.aif`, `.aiff`, `.flac`, `.mp3`, `.m4a`, `.aac`, `.ogg`) or an entire folder.
- **Smart Master Detection**: Automatically selects files containing **`MASTER`** or **`MASTERED`** while **strictly excluding anything containing `UNMASTERED`**.
- Filter toggle lets you compare unmastered mixes or stems if desired.
- **Built-in Demo Shootout**: Click **"✨ Try Demo Shootout"** to immediately test with 4 synthesized master revisions (Warm Analog, Bright Air, Punchy Club, and Balanced Reference) with zero uploads!

### 🙈 Strictly Blind Arena: "Option 1" vs "Option 2"
- **Zero Giveaways**: All file names, formats (e.g. WAV 24-bit 96k vs MP3), sample rates, bit depths, and sizes are completely hidden.
- Contenders are strictly masked as **Option 1** and **Option 2**.
- Contender positions are randomized (50/50) each round so the incumbent King isn't always Option 1.

### ⏱️ Sample-Accurate 15-Second Midpoint Shootout
- Automatically calculates the center of the track ($T / 2$) and loops the middle 15 seconds.
- Toggle between 10s, 15s (default), 20s, or 30s preview loops.
- **Instant 0-Latency A/B Switching**: Fades between Option 1 and Option 2 with a 5ms micro-crossfade at the **identical playback millisecond**, making EQ, transient, and compression differences immediately obvious without skipping a beat.

### ⚖️ Auto-RMS Loudness Matching
- A louder master often tricks the human ear into hearing "better" clarity.
- Built-in real-time RMS normalization levels the playing field so you judge tone and dynamics, not volume.

### 📊 Real-Time Visualizer & Transport
- 48-band FFT audio spectrum visualizer.
- Stereo Left/Right peak VU meters.
- Interactive loop timeline scrubber with live playhead.
- Auto A/B mode (flips between Option 1 and Option 2 every 15s).

### 👑 Crowning & Grand Reveal
- Confetti explosion upon picking the final winner!
- Pulls back the curtain: reveals the champion filename, format specs, duration, and file size.
- Interactive full-song audio player to listen to the winning master in its entirety.
- One-click **"Download Winning Master"** and **"Copy File Name"**.
- Full round-by-round elimination ladder history.

---

## ⌨️ Studio Keyboard Shortcuts

| Key | Action |
|---|---|
| <kbd>Space</kbd> | Play / Pause 15-second loop |
| <kbd>1</kbd> | Instant switch to **Option 1** (starts playback if paused) |
| <kbd>2</kbd> | Instant switch to **Option 2** (starts playback if paused) |
| <kbd>←</kbd> or <kbd>Shift+1</kbd> | Pick **Option 1** as Winner & Advance |
| <kbd>→</kbd> or <kbd>Shift+2</kbd> | Pick **Option 2** as Winner & Advance |
| <kbd>R</kbd> | Restart loop from 00:00.0 |

---

## 💻 Local Command Line Use

You can also run it locally via terminal:

```bash
# Launch GUI locally
master-ab

# Launch GUI pre-loaded with a folder
master-ab ~/Music/Logic/Album_Masters

# Scan current directory
master-ab .
```
