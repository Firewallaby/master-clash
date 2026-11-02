/**
 * Master Clash — Blind Audio Shootout & A/B Tournament
 * 100% In-Browser & GitHub Pages Ready
 * Pure client-side Web Audio API decoding, 15s midpoint slicing,
 * zero-latency blind A/B switching, FFT spectrum visualizer, and ladder shootout.
 */

// Helper to decode audio safely across all WebKit / Chromium / Gecko browsers
function decodeAudioDataSafe(audioCtx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    const copy = arrayBuffer.slice(0);
    let isDone = false;
    try {
      const ret = audioCtx.decodeAudioData(
        copy,
        (decoded) => {
          if (!isDone) {
            isDone = true;
            resolve(decoded);
          }
        },
        (err) => {
          if (!isDone) {
            isDone = true;
            reject(err || new Error("decodeAudioData callback failed"));
          }
        }
      );
      if (ret && typeof ret.then === "function") {
        ret
          .then((buf) => {
            if (!isDone) {
              isDone = true;
              resolve(buf);
            }
          })
          .catch((err) => {
            if (!isDone) {
              isDone = true;
              reject(err);
            }
          });
      }
    } catch (e) {
      if (!isDone) {
        isDone = true;
        reject(e);
      }
    }
  });
}

// Slice an AudioBuffer in memory to extract an exact 15s segment
function sliceAudioBuffer(audioCtx, fullBuffer, startTime, duration) {
  const sampleRate = fullBuffer.sampleRate;
  const startSample = Math.floor(Math.max(0, startTime) * sampleRate);
  const numSamples = Math.min(
    Math.floor(duration * sampleRate),
    fullBuffer.length - startSample
  );
  const sliced = audioCtx.createBuffer(
    fullBuffer.numberOfChannels,
    Math.max(1, numSamples),
    sampleRate
  );

  for (let ch = 0; ch < fullBuffer.numberOfChannels; ch++) {
    const channelData = fullBuffer.getChannelData(ch);
    const sliceData = channelData.subarray(startSample, startSample + numSamples);
    sliced.copyToChannel(sliceData, ch);
  }
  return sliced;
}

// Compute RMS energy of an AudioBuffer
function computeBufferRMS(buffer) {
  if (!buffer) return 1.0;
  let sum = 0;
  let totalSamples = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    const step = 4;
    for (let i = 0; i < data.length; i += step) {
      sum += data[i] * data[i];
      totalSamples++;
    }
  }
  return Math.sqrt(sum / (totalSamples || 1));
}

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.bufferA = null; // Option 1 (15s slice)
    this.bufferB = null; // Option 2 (15s slice)
    this.sourceA = null;
    this.sourceB = null;
    this.gainA = null;
    this.gainB = null;
    this.masterGain = null;
    this.analyser = null;

    this.isPlaying = false;
    this.activeSide = 'A'; // 'A' = Option 1, 'B' = Option 2
    this.duration = 15.0;
    this.startTime = 0;
    this.pauseOffset = 0;
    this.autoLufsMatch = true;
    this.rmsRatioA = 1.0;
    this.rmsRatioB = 1.0;
    this.autoFlipEnabled = false;
    this.autoFlipTimer = null;

    // Table audition preview
    this.auditionSource = null;
    this.activeAuditionBtn = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContextClass();

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.9;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;

      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  setMatchBuffers(bufferOption1, bufferOption2, duration = 15.0) {
    this.stop();
    this.bufferA = bufferOption1;
    this.bufferB = bufferOption2;
    this.duration = duration;
    this.pauseOffset = 0;

    // Compute RMS loudness matching
    const rmsA = computeBufferRMS(this.bufferA);
    const rmsB = computeBufferRMS(this.bufferB);

    if (rmsA > 0.0001 && rmsB > 0.0001) {
      const targetRms = Math.min(rmsA, rmsB);
      this.rmsRatioA = targetRms / rmsA;
      this.rmsRatioB = targetRms / rmsB;

      const diffDb = 20 * Math.log10(rmsA / rmsB);
      const displayElem = document.getElementById('gain-trim-display');
      if (displayElem) {
        if (Math.abs(diffDb) < 0.2) {
          displayElem.innerHTML = `<span>Loudness: Matched (±0.1 dB)</span>`;
        } else if (diffDb > 0) {
          displayElem.innerHTML = `<span>Auto-Gain: Option 2 +${diffDb.toFixed(1)} dB to balance</span>`;
        } else {
          displayElem.innerHTML = `<span>Auto-Gain: Option 1 +${Math.abs(diffDb).toFixed(1)} dB to balance</span>`;
        }
      }
    } else {
      this.rmsRatioA = 1.0;
      this.rmsRatioB = 1.0;
    }
  }

  async play() {
    if (!this.bufferA || !this.bufferB) {
      console.warn("Audio buffers are not loaded yet.");
      return false;
    }

    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch (e) {}
    }

    if (this.isPlaying) return true;

    this.cleanupSources();

    this.sourceA = ctx.createBufferSource();
    this.sourceB = ctx.createBufferSource();
    this.sourceA.buffer = this.bufferA;
    this.sourceB.buffer = this.bufferB;
    this.sourceA.loop = true;
    this.sourceB.loop = true;

    this.gainA = ctx.createGain();
    this.gainB = ctx.createGain();

    this.sourceA.connect(this.gainA);
    this.sourceB.connect(this.gainB);

    this.gainA.connect(this.masterGain);
    this.gainB.connect(this.masterGain);

    this.applyGains(true);

    const offset = this.pauseOffset % this.duration;
    const now = ctx.currentTime;
    this.startTime = now - offset;

    try {
      this.sourceA.start(now, offset);
      this.sourceB.start(now, offset);
      this.isPlaying = true;

      if (this.autoFlipEnabled) {
        this.scheduleAutoFlip();
      }
      return true;
    } catch (err) {
      console.error("Playback start error:", err);
      this.isPlaying = false;
      return false;
    }
  }

  pause() {
    if (!this.isPlaying) return;
    if (this.ctx) {
      this.pauseOffset = (this.ctx.currentTime - this.startTime) % this.duration;
    }
    this.cleanupSources();
    this.isPlaying = false;
    clearTimeout(this.autoFlipTimer);
  }

  stop() {
    this.pause();
    this.pauseOffset = 0;
  }

  cleanupSources() {
    if (this.sourceA) {
      try { this.sourceA.stop(); } catch(e) {}
      try { this.sourceA.disconnect(); } catch(e) {}
      this.sourceA = null;
    }
    if (this.sourceB) {
      try { this.sourceB.stop(); } catch(e) {}
      try { this.sourceB.disconnect(); } catch(e) {}
      this.sourceB = null;
    }
  }

  async seek(targetSeconds) {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) {
      this.pause();
    }
    this.pauseOffset = Math.max(0, Math.min(targetSeconds, this.duration));
    if (wasPlaying) {
      await this.play();
    }
  }

  async switchSide(newSide) {
    this.activeSide = newSide;
    if (this.isPlaying) {
      this.applyGains(false); // seamless 5ms crossfade
    } else {
      await this.play();
    }
  }

  applyGains(immediate = false) {
    if (!this.gainA || !this.gainB || !this.ctx) return;

    const multA = this.autoLufsMatch ? this.rmsRatioA : 1.0;
    const multB = this.autoLufsMatch ? this.rmsRatioB : 1.0;

    const targetGainA = this.activeSide === 'A' ? 1.0 * multA : 0.0001;
    const targetGainB = this.activeSide === 'B' ? 1.0 * multB : 0.0001;

    const now = this.ctx.currentTime;
    if (immediate) {
      this.gainA.gain.setValueAtTime(targetGainA, now);
      this.gainB.gain.setValueAtTime(targetGainB, now);
    } else {
      this.gainA.gain.setTargetAtTime(targetGainA, now, 0.005);
      this.gainB.gain.setTargetAtTime(targetGainB, now, 0.005);
    }
  }

  getCurrentPlayhead() {
    if (!this.isPlaying) return this.pauseOffset;
    if (!this.ctx) return 0;
    return (this.ctx.currentTime - this.startTime) % this.duration;
  }

  scheduleAutoFlip() {
    clearTimeout(this.autoFlipTimer);
    if (!this.autoFlipEnabled || !this.isPlaying) return;

    const current = this.getCurrentPlayhead();
    const remaining = (this.duration - current) * 1000;

    this.autoFlipTimer = setTimeout(() => {
      if (this.isPlaying && this.autoFlipEnabled) {
        const nextSide = this.activeSide === 'A' ? 'B' : 'A';
        this.switchSide(nextSide);
        AppUI.updateActiveSideUI(nextSide);
        this.scheduleAutoFlip();
      }
    }, Math.max(500, remaining));
  }

  // Audition preview single track slice from table
  previewBuffer(buffer, btn) {
    this.ensureContext();
    if (this.auditionSource && this.activeAuditionBtn === btn) {
      this.stopAudition();
      return;
    }

    this.stopAudition();
    this.activeAuditionBtn = btn;
    btn.textContent = "⏹ Stop";

    try {
      this.auditionSource = this.ctx.createBufferSource();
      this.auditionSource.buffer = buffer;
      this.auditionSource.connect(this.masterGain);

      this.auditionSource.onended = () => {
        this.stopAudition();
      };

      this.auditionSource.start(0);
    } catch (e) {
      console.error(e);
      this.stopAudition();
    }
  }

  stopAudition() {
    if (this.auditionSource) {
      try { this.auditionSource.stop(); } catch(e) {}
      try { this.auditionSource.disconnect(); } catch(e) {}
      this.auditionSource = null;
    }
    if (this.activeAuditionBtn) {
      this.activeAuditionBtn.textContent = "▶ Preview";
      this.activeAuditionBtn = null;
    }
  }
}

const audio = new AudioEngine();

/* ==========================================================================
   Synthetic Demo Master Generator (0-upload instant test)
   ========================================================================== */

function generateDemoMasters(audioCtx) {
  const sr = audioCtx.sampleRate || 44100;
  const dur = 30.0;
  const total = Math.floor(sr * dur);

  // Musical chord notes in Hz (C major / A minor progression)
  const chords = [
    [261.63, 329.63, 392.00], // C
    [196.00, 246.94, 293.66], // G
    [220.00, 261.63, 329.63], // Am
    [174.61, 220.00, 261.63], // F
  ];

  const profiles = [
    { name: "SummerGroove_MASTER_v1_balanced.wav", bassGain: 1.0, trebleGain: 1.0, comp: 1.0 },
    { name: "SummerGroove_MASTERED_v2_warm_analog.wav", bassGain: 1.6, trebleGain: 0.85, comp: 1.1 },
    { name: "SummerGroove_MASTERED_v3_bright_air.wav", bassGain: 0.95, trebleGain: 1.7, comp: 1.05 },
    { name: "SummerGroove_MASTER_v4_punchy_club.wav", bassGain: 1.3, trebleGain: 1.25, comp: 1.4 }
  ];

  const tracks = [];

  profiles.forEach((prof, idx) => {
    const buf = audioCtx.createBuffer(2, total, sr);
    const left = buf.getChannelData(0);
    const right = buf.getChannelData(1);

    for (let i = 0; i < total; i++) {
      const t = i / sr;
      const chordIdx = Math.floor((t % 8) / 2);
      const chord = chords[chordIdx];

      // Chord synth
      let val = 0;
      chord.forEach((freq, fIdx) => {
        val += Math.sin(2 * Math.PI * freq * t) * 0.12;
        val += Math.sin(4 * Math.PI * freq * t) * (0.04 * prof.trebleGain);
      });

      // Bass note
      const bassFreq = chord[0] / 2;
      val += Math.sin(2 * Math.PI * bassFreq * t) * (0.22 * prof.bassGain);

      // Drum kick & snare pulse
      const beat = (t * 2) % 1;
      if (beat < 0.08) {
        val += Math.sin(2 * Math.PI * 65 * beat * 12) * (0.35 * prof.comp);
      }

      // Stereo width
      left[i] = Math.max(-0.95, Math.min(0.95, val * 0.85));
      right[i] = Math.max(-0.95, Math.min(0.95, val * 0.9));
    }

    const mid = dur / 2.0;
    const clipStart = mid - 7.5;
    const slice = sliceAudioBuffer(audioCtx, buf, clipStart, 15.0);

    tracks.push({
      id: `demo_${idx}`,
      filename: prof.name,
      duration: dur,
      sampleRate: sr,
      channels: 2,
      formatDesc: "WAV 16-bit 44.1kHz Stereo",
      sizeMb: 5.2,
      fullBuffer: buf,
      slicedBuffer: slice,
      clipStart: clipStart,
      clipDuration: 15.0
    });
  });

  return tracks;
}

/* ==========================================================================
   App UI & Client-Side Tournament Controller
   ========================================================================== */

const AppUI = {
  state: {
    tracks: [],
    selectedTrackIds: new Set(),
    previewDuration: 15.0,
    currentMatchIndex: 0,
    totalMatches: 0,
    currentKing: null,
    currentChallenger: null,
    queue: [],
    blindMap: {}, // { 'A': track, 'B': track }
    history: [],
    winner: null
  },

  elements: {},

  init() {
    this.cacheElements();
    this.bindEvents();
    this.initCanvasVisualizer();
  },

  cacheElements() {
    this.elements = {
      // Panels
      phaseScan: document.getElementById('phase-scan'),
      phaseArena: document.getElementById('phase-arena'),
      phaseVictory: document.getElementById('phase-victory'),

      // Header
      btnHeaderNew: document.getElementById('btn-header-new'),

      // Upload Phase
      uploadDropzone: document.getElementById('upload-dropzone'),
      fileUploadInput: document.getElementById('file-upload-input'),
      folderUploadInput: document.getElementById('folder-upload-input'),
      btnSelectFiles: document.getElementById('btn-select-files'),
      btnSelectFolder: document.getElementById('btn-select-folder'),
      toggleMasterFilter: document.getElementById('toggle-master-filter'),
      btnPresetDemo: document.getElementById('btn-preset-demo'),
      decodeProgressContainer: document.getElementById('decode-progress-container'),
      decodeProgressText: document.getElementById('decode-progress-text'),
      decodeProgressPct: document.getElementById('decode-progress-pct'),
      decodeProgressBar: document.getElementById('decode-progress-bar'),

      // Scan Results
      scanResults: document.getElementById('scan-results-container'),
      scanEmptyState: document.getElementById('scan-empty-state'),
      resultsCountText: document.getElementById('results-count-text'),
      resultsSubText: document.getElementById('results-sub-text'),
      trackListBody: document.getElementById('track-list-body'),
      btnToggleAll: document.getElementById('btn-toggle-all'),
      btnClearFiles: document.getElementById('btn-clear-files'),
      durationSelector: document.getElementById('duration-selector'),
      toggleLufsMatch: document.getElementById('toggle-lufs-match'),
      btnStartTournament: document.getElementById('btn-start-tournament'),

      // Arena Phase
      arenaMatchBadge: document.getElementById('arena-match-badge'),
      arenaStageTitle: document.getElementById('arena-stage-title'),
      arenaLadderProgress: document.getElementById('arena-ladder-progress'),
      cardCandA: document.getElementById('card-cand-a'),
      cardCandB: document.getElementById('card-cand-b'),
      playingPillA: document.getElementById('playing-pill-a'),
      playingPillB: document.getElementById('playing-pill-b'),
      btnListenA: document.getElementById('btn-listen-a'),
      btnListenB: document.getElementById('btn-listen-b'),
      btnPickA: document.getElementById('btn-pick-a'),
      btnPickB: document.getElementById('btn-pick-b'),
      btnToggleToA: document.getElementById('btn-toggle-to-a'),
      btnToggleToB: document.getElementById('btn-toggle-to-b'),

      // Transport
      btnPlayPause: document.getElementById('btn-play-pause'),
      playBtnText: document.getElementById('play-btn-text'),
      iconPlay: document.getElementById('icon-play'),
      iconPause: document.getElementById('icon-pause'),
      btnRestartLoop: document.getElementById('btn-restart-loop'),
      btnAutoFlip: document.getElementById('btn-auto-flip'),
      timelineScrubber: document.getElementById('timeline-scrubber'),
      timelineProgressBar: document.getElementById('timeline-progress-bar'),
      timelinePlayhead: document.getElementById('timeline-playhead'),
      timelineCurrentTime: document.getElementById('timeline-current-time'),
      timelineTotalTime: document.getElementById('timeline-total-time'),
      masterVolumeSlider: document.getElementById('master-volume-slider'),
      vuMeterL: document.getElementById('vu-meter-l'),
      vuMeterR: document.getElementById('vu-meter-r'),
      visualizerCanvas: document.getElementById('audio-visualizer-canvas'),

      // Victory Phase
      winnerFilename: document.getElementById('winner-filename'),
      winnerSpecsRow: document.getElementById('winner-specs-row'),
      winnerAudioPlayer: document.getElementById('winner-audio-player'),
      btnCopyWinnerName: document.getElementById('btn-copy-winner-name'),
      btnDownloadWinner: document.getElementById('btn-download-winner'),
      btnNewTournament: document.getElementById('btn-new-tournament'),
      tournamentHistoryList: document.getElementById('tournament-history-list'),

      // Toast
      toastContainer: document.getElementById('toast-container')
    };
  },

  bindEvents() {
    // Header
    this.elements.btnHeaderNew.addEventListener('click', () => {
      audio.ensureContext();
      this.switchPanel('scan');
    });

    // Upload Triggers
    this.elements.btnSelectFiles.addEventListener('click', (e) => {
      e.stopPropagation();
      audio.ensureContext();
      this.elements.fileUploadInput.click();
    });

    this.elements.btnSelectFolder.addEventListener('click', (e) => {
      e.stopPropagation();
      audio.ensureContext();
      this.elements.folderUploadInput.click();
    });

    this.elements.fileUploadInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        this.processUploadedFiles(Array.from(e.target.files));
      }
    });

    this.elements.folderUploadInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        this.processUploadedFiles(Array.from(e.target.files));
      }
    });

    // Dropzone Drag and Drop
    const dropzone = this.elements.uploadDropzone;
    ['dragenter', 'dragover'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add('drag-over');
      });
    });

    ['dragleave', 'drop'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove('drag-over');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      audio.ensureContext();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        this.processUploadedFiles(Array.from(e.dataTransfer.files));
      }
    });

    // Demo samples
    this.elements.btnPresetDemo.addEventListener('click', () => {
      audio.ensureContext();
      this.loadDemoTracks();
    });

    // Clear & Toggle all
    this.elements.btnToggleAll.addEventListener('click', () => this.toggleAllTracks());
    this.elements.btnClearFiles.addEventListener('click', () => {
      this.state.tracks = [];
      this.state.selectedTrackIds.clear();
      this.renderTrackList();
    });

    // Duration Selector
    this.elements.durationSelector.querySelectorAll('.segment-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        audio.ensureContext();
        this.elements.durationSelector.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.state.previewDuration = parseFloat(btn.dataset.sec);
        this.recomputeSlices(this.state.previewDuration);
      });
    });

    // Loudness match toggle
    this.elements.toggleLufsMatch.addEventListener('change', (e) => {
      audio.autoLufsMatch = e.target.checked;
      audio.applyGains(false);
    });

    // Start tournament button
    this.elements.btnStartTournament.addEventListener('click', () => {
      audio.ensureContext();
      this.startTournament();
    });

    // Arena Controls
    this.elements.btnListenA.addEventListener('click', async () => {
      audio.ensureContext();
      await audio.switchSide('A');
      this.updateActiveSideUI('A');
      this.updatePlayPauseBtn(audio.isPlaying);
    });

    this.elements.btnListenB.addEventListener('click', async () => {
      audio.ensureContext();
      await audio.switchSide('B');
      this.updateActiveSideUI('B');
      this.updatePlayPauseBtn(audio.isPlaying);
    });

    this.elements.btnToggleToA.addEventListener('click', async () => {
      audio.ensureContext();
      await audio.switchSide('A');
      this.updateActiveSideUI('A');
      this.updatePlayPauseBtn(audio.isPlaying);
    });

    this.elements.btnToggleToB.addEventListener('click', async () => {
      audio.ensureContext();
      await audio.switchSide('B');
      this.updateActiveSideUI('B');
      this.updatePlayPauseBtn(audio.isPlaying);
    });

    this.elements.btnPickA.addEventListener('click', () => {
      audio.ensureContext();
      this.castVote('A');
    });

    this.elements.btnPickB.addEventListener('click', () => {
      audio.ensureContext();
      this.castVote('B');
    });

    // Transport Controls
    this.elements.btnPlayPause.addEventListener('click', () => {
      audio.ensureContext();
      this.togglePlayPause();
    });

    this.elements.btnRestartLoop.addEventListener('click', async () => {
      audio.ensureContext();
      await audio.seek(0);
      if (!audio.isPlaying) await audio.play();
      this.updatePlayPauseBtn(audio.isPlaying);
    });

    this.elements.btnAutoFlip.addEventListener('click', () => {
      audio.autoFlipEnabled = !audio.autoFlipEnabled;
      this.elements.btnAutoFlip.classList.toggle('btn-primary', audio.autoFlipEnabled);
      this.elements.btnAutoFlip.classList.toggle('btn-ghost', !audio.autoFlipEnabled);
      if (audio.autoFlipEnabled) {
        audio.scheduleAutoFlip();
        this.showToast("Auto A/B Mode active (flips every 15s)");
      } else {
        clearTimeout(audio.autoFlipTimer);
        this.showToast("Auto A/B Mode off");
      }
    });

    // Timeline Scrubber Click
    this.elements.timelineScrubber.addEventListener('click', async (e) => {
      audio.ensureContext();
      const rect = this.elements.timelineScrubber.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const pct = Math.max(0, Math.min(1, clickX / rect.width));
      await audio.seek(pct * audio.duration);
      this.updatePlayPauseBtn(audio.isPlaying);
    });

    // Volume Slider
    this.elements.masterVolumeSlider.addEventListener('input', (e) => {
      if (audio.masterGain && audio.ctx) {
        audio.masterGain.gain.setValueAtTime(parseFloat(e.target.value), audio.ctx.currentTime);
      }
    });

    // Victory Actions
    this.elements.btnCopyWinnerName.addEventListener('click', () => {
      if (this.state.winner) {
        navigator.clipboard.writeText(this.state.winner.filename).then(() => {
          this.showToast("Copied winner file name! 📋");
        });
      }
    });

    this.elements.btnNewTournament.addEventListener('click', () => {
      audio.ensureContext();
      this.switchPanel('scan');
      if (this.elements.winnerAudioPlayer) {
        this.elements.winnerAudioPlayer.pause();
      }
    });

    // Global Keyboard Shortcuts
    window.addEventListener('keydown', async (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (this.elements.phaseArena.classList.contains('active')) {
        audio.ensureContext();

        if (e.code === 'Space') {
          e.preventDefault();
          this.togglePlayPause();
        } else if (e.key === '1' && !e.shiftKey) {
          e.preventDefault();
          await audio.switchSide('A');
          this.updateActiveSideUI('A');
          this.updatePlayPauseBtn(audio.isPlaying);
        } else if (e.key === '2' && !e.shiftKey) {
          e.preventDefault();
          await audio.switchSide('B');
          this.updateActiveSideUI('B');
          this.updatePlayPauseBtn(audio.isPlaying);
        } else if (e.key === 'ArrowLeft' || (e.key === '!' || (e.key === '1' && e.shiftKey))) {
          e.preventDefault();
          this.castVote('A');
        } else if (e.key === 'ArrowRight' || (e.key === '@' || (e.key === '2' && e.shiftKey))) {
          e.preventDefault();
          this.castVote('B');
        } else if (e.key === 'r' || e.key === 'R') {
          e.preventDefault();
          await audio.seek(0);
          if (!audio.isPlaying) await audio.play();
          this.updatePlayPauseBtn(audio.isPlaying);
        }
      }
    });
  },

  switchPanel(panelName) {
    audio.stop();
    audio.stopAudition();
    this.updatePlayPauseBtn(false);

    this.elements.phaseScan.classList.toggle('active', panelName === 'scan');
    this.elements.phaseArena.classList.toggle('active', panelName === 'arena');
    this.elements.phaseVictory.classList.toggle('active', panelName === 'victory');
  },

  /* ========================================================================
     Client-Side File Processing & Decoding
     ======================================================================== */

  async processUploadedFiles(fileList) {
    const ctx = audio.ensureContext();
    const isFilterActive = this.elements.toggleMasterFilter.checked;
    const masterRegex = /master(?:ed)?/i;
    const unmasteredRegex = /un[\W_]?master(?:ed)?/i;

    // Filter audio files
    const validAudioExtensions = ['.wav', '.aif', '.aiff', '.flac', '.mp3', '.m4a', '.aac', '.ogg'];
    const candidates = [];
    let excludedUnmasteredCount = 0;

    fileList.forEach(file => {
      const lowerName = file.name.toLowerCase();
      const hasAudioExt = validAudioExtensions.some(ext => lowerName.endsWith(ext));
      if (!hasAudioExt) return;

      if (isFilterActive) {
        if (unmasteredRegex.test(lowerName)) {
          excludedUnmasteredCount++;
          return;
        }
        if (!masterRegex.test(lowerName)) {
          return;
        }
      }
      candidates.push(file);
    });

    if (candidates.length === 0) {
      if (excludedUnmasteredCount > 0) {
        this.showToast(`Excluded ${excludedUnmasteredCount} UNMASTERED file(s). No master tracks found.`, true);
      } else {
        this.showToast("No master tracks found. Ensure filenames contain MASTER or MASTERED.", true);
      }
      return;
    }

    // Show Progress Bar
    this.elements.decodeProgressContainer.classList.remove('hidden');
    this.elements.decodeProgressBar.style.width = '0%';

    const newTracks = [];
    for (let i = 0; i < candidates.length; i++) {
      const file = candidates[i];
      const pct = Math.round(((i + 1) / candidates.length) * 100);

      this.elements.decodeProgressText.textContent = `Decoding: ${file.name} (${i + 1} of ${candidates.length})...`;
      this.elements.decodeProgressPct.textContent = `${pct}%`;
      this.elements.decodeProgressBar.style.width = `${pct}%`;

      try {
        const arrayBuf = await file.arrayBuffer();
        const fullBuffer = await decodeAudioDataSafe(ctx, arrayBuf);

        const dur = fullBuffer.duration;
        const mid = dur / 2.0;
        const clipDur = this.state.previewDuration;
        const clipStart = Math.max(0, mid - (clipDur / 2.0));
        const sliced = sliceAudioBuffer(ctx, fullBuffer, clipStart, clipDur);

        const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
        const srKhz = `${(fullBuffer.sampleRate / 1000).toFixed(1)}kHz`;
        const chStr = fullBuffer.numberOfChannels === 2 ? "Stereo" : "Mono";
        const fmt = `${file.name.split('.').pop().toUpperCase()} ${srKhz} ${chStr}`;

        newTracks.push({
          id: `trk_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          filename: file.name,
          duration: dur,
          sampleRate: fullBuffer.sampleRate,
          channels: fullBuffer.numberOfChannels,
          formatDesc: fmt,
          sizeMb: sizeMb,
          file: file,
          fullBuffer: fullBuffer,
          slicedBuffer: sliced,
          clipStart: clipStart,
          clipDuration: clipDur
        });
      } catch (e) {
        console.error(`Failed to decode ${file.name}:`, e);
      }
    }

    this.elements.decodeProgressContainer.classList.add('hidden');

    if (newTracks.length > 0) {
      this.state.tracks = newTracks;
      this.state.selectedTrackIds = new Set(newTracks.map(t => t.id));
      this.renderTrackList(excludedUnmasteredCount);
      this.showToast(`Loaded ${newTracks.length} master tracks!`);
    } else {
      this.showToast("Could not decode audio files.", true);
    }
  },

  loadDemoTracks() {
    const ctx = audio.ensureContext();
    this.showToast("Synthesizing 4 Demo Master Revisions...");
    const demoTracks = generateDemoMasters(ctx);
    this.state.tracks = demoTracks;
    this.state.selectedTrackIds = new Set(demoTracks.map(t => t.id));
    this.renderTrackList(0);
    this.showToast("4 Demo Masters loaded! Ready for shootout.");
  },

  recomputeSlices(newDuration) {
    const ctx = audio.ensureContext();
    this.state.tracks.forEach(track => {
      if (track.fullBuffer) {
        const mid = track.duration / 2.0;
        const clipStart = Math.max(0, mid - (newDuration / 2.0));
        track.clipStart = clipStart;
        track.clipDuration = newDuration;
        track.slicedBuffer = sliceAudioBuffer(ctx, track.fullBuffer, clipStart, newDuration);
      }
    });
    this.renderTrackList();
  },

  renderTrackList(excludedCount = 0) {
    const tracks = this.state.tracks;

    if (tracks.length === 0) {
      this.elements.scanResults.classList.add('hidden');
      this.elements.scanEmptyState.classList.remove('hidden');
      return;
    }

    this.elements.scanEmptyState.classList.add('hidden');
    this.elements.scanResults.classList.remove('hidden');

    let subText = "Select at least 2 tracks to run the blind shootout.";
    if (excludedCount > 0) {
      subText += ` (${excludedCount} UNMASTERED file${excludedCount > 1 ? 's' : ''} automatically excluded).`;
    }
    this.elements.resultsCountText.textContent = `Found ${tracks.length} Master Track${tracks.length > 1 ? 's' : ''}`;
    this.elements.resultsSubText.textContent = subText;

    this.elements.trackListBody.innerHTML = '';
    tracks.forEach(track => {
      const row = document.createElement('div');
      row.className = 'track-row';

      const durMin = Math.floor(track.duration / 60);
      const durSec = Math.floor(track.duration % 60).toString().padStart(2, '0');

      const midMin = Math.floor(track.clipStart / 60);
      const midSec = Math.floor(track.clipStart % 60).toString().padStart(2, '0');
      const endSec = Math.floor((track.clipStart + track.clipDuration) % 60).toString().padStart(2, '0');

      row.innerHTML = `
        <div class="col-check">
          <input type="checkbox" data-id="${track.id}" checked>
        </div>
        <div class="col-name track-name-cell text-truncate" title="${track.filename}">
          ${track.filename}
        </div>
        <div class="col-fmt">
          <span class="badge-format">${track.formatDesc}</span>
        </div>
        <div class="col-dur time-tag">${durMin}:${durSec}</div>
        <div class="col-mid time-tag">${midMin}:${midSec} - ${midMin}:${endSec} (${track.clipDuration}s)</div>
        <div class="col-size time-tag">${track.sizeMb} MB</div>
        <div class="col-action">
          <button class="btn btn-ghost btn-sm btn-audition-row" data-id="${track.id}">
            ▶ Preview
          </button>
        </div>
      `;

      // Checkbox
      const chk = row.querySelector('input[type="checkbox"]');
      chk.addEventListener('change', (e) => {
        if (e.target.checked) this.state.selectedTrackIds.add(track.id);
        else this.state.selectedTrackIds.delete(track.id);
        this.updateStartButtonState();
      });

      // Preview button
      const btn = row.querySelector('.btn-audition-row');
      btn.addEventListener('click', () => {
        audio.previewBuffer(track.slicedBuffer, btn);
      });

      this.elements.trackListBody.appendChild(row);
    });

    this.updateStartButtonState();
  },

  toggleAllTracks() {
    const checkboxes = this.elements.trackListBody.querySelectorAll('input[type="checkbox"]');
    const allChecked = Array.from(checkboxes).every(c => c.checked);
    checkboxes.forEach(c => {
      c.checked = !allChecked;
      const tid = c.dataset.id;
      if (!allChecked) this.state.selectedTrackIds.add(tid);
      else this.state.selectedTrackIds.delete(tid);
    });
    this.elements.btnToggleAll.textContent = allChecked ? "Select All" : "Deselect All";
    this.updateStartButtonState();
  },

  updateStartButtonState() {
    const count = this.state.selectedTrackIds.size;
    this.elements.btnStartTournament.disabled = count < 2;
    if (count < 2) {
      this.elements.btnStartTournament.innerHTML = `Select At Least 2 Tracks`;
    } else {
      this.elements.btnStartTournament.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>
        Start Blind Tournament (${count} Contenders)
      `;
    }
  },

  /* ========================================================================
     Blind Shootout Tournament Engine
     ======================================================================== */

  startTournament() {
    audio.stopAudition();

    const selected = this.state.tracks.filter(t => this.state.selectedTrackIds.has(t.id));
    if (selected.length < 2) {
      this.showToast("Select at least 2 tracks", true);
      return;
    }

    // Shuffle contenders for fairness
    const shuffled = [...selected].sort(() => Math.random() - 0.5);

    this.state.currentKing = shuffled[0];
    this.state.currentChallenger = shuffled[1];
    this.state.queue = shuffled.slice(2);

    this.state.currentMatchIndex = 1;
    this.state.totalMatches = selected.length - 1;
    this.state.history = [];
    this.state.winner = null;

    this.switchPanel('arena');
    this.setupArenaMatch();
  },

  setupArenaMatch() {
    const king = this.state.currentKing;
    const challenger = this.state.currentChallenger;

    // Randomize whether King is Option 1 or Option 2 (50/50)
    const flip = Math.random() < 0.5;
    this.state.blindMap = {
      'A': flip ? king : challenger,
      'B': flip ? challenger : king
    };

    // Update Arena Header
    this.elements.arenaMatchBadge.textContent = `Match ${this.state.currentMatchIndex} of ${this.state.totalMatches}`;
    this.elements.arenaStageTitle.textContent = this.state.currentMatchIndex === 1 ? "Opening Clash" : "King of the Hill Shootout";

    // Progress Dots
    this.elements.arenaLadderProgress.innerHTML = '';
    for (let i = 1; i <= this.state.totalMatches; i++) {
      const dot = document.createElement('div');
      dot.className = 'ladder-dot';
      if (i < this.state.currentMatchIndex) dot.classList.add('done');
      else if (i === this.state.currentMatchIndex) dot.classList.add('current');
      this.elements.arenaLadderProgress.appendChild(dot);
    }

    const durSec = Math.floor(this.state.previewDuration).toString().padStart(2, '0');
    this.elements.timelineTotalTime.textContent = `00:${durSec}.0`;

    // Load into Web Audio Engine
    audio.setMatchBuffers(
      this.state.blindMap['A'].slicedBuffer,
      this.state.blindMap['B'].slicedBuffer,
      this.state.previewDuration
    );

    // Reset UI to Option 1
    audio.activeSide = 'A';
    this.updateActiveSideUI('A');
    this.updatePlayPauseBtn(false);

    this.showToast(`Match ${this.state.currentMatchIndex} ready! Click Play or Press Space.`);
  },

  updateActiveSideUI(side) {
    const isA = side === 'A';
    this.elements.cardCandA.classList.toggle('active-play', isA);
    this.elements.cardCandB.classList.toggle('active-play', !isA);
    this.elements.playingPillA.classList.toggle('visible', isA && audio.isPlaying);
    this.elements.playingPillB.classList.toggle('visible', !isA && audio.isPlaying);

    this.elements.btnToggleToA.classList.toggle('active', isA);
    this.elements.btnToggleToB.classList.toggle('active', !isA);
  },

  async togglePlayPause() {
    if (audio.isPlaying) {
      audio.pause();
      this.updatePlayPauseBtn(false);
      this.updateActiveSideUI(audio.activeSide);
    } else {
      const started = await audio.play();
      this.updatePlayPauseBtn(started);
      this.updateActiveSideUI(audio.activeSide);
    }
  },

  updatePlayPauseBtn(playing) {
    this.elements.iconPlay.classList.toggle('hidden', playing);
    this.elements.iconPause.classList.toggle('hidden', !playing);
    this.elements.playBtnText.textContent = playing ? "Pause" : "Play Loop";
  },

  castVote(chosenSide) {
    audio.stop();
    this.updatePlayPauseBtn(false);

    const winningTrack = this.state.blindMap[chosenSide];
    const losingSide = chosenSide === 'A' ? 'B' : 'A';
    const losingTrack = this.state.blindMap[losingSide];

    // Log match record
    this.state.history.push({
      matchNumber: this.state.currentMatchIndex,
      chosenSide: chosenSide,
      winnerFilename: winningTrack.filename,
      loserFilename: losingTrack.filename
    });

    // The winning track stays/becomes the King
    this.state.currentKing = winningTrack;

    const optionLabel = chosenSide === 'A' ? 'Option 1' : 'Option 2';
    this.showToast(`👑 ${optionLabel} Wins! Advancing...`);

    if (this.state.queue.length > 0) {
      this.state.currentChallenger = this.state.queue.shift();
      this.state.currentMatchIndex++;
      this.setupArenaMatch();
    } else {
      // Finished! Crown the winner!
      this.state.winner = this.state.currentKing;
      this.showVictoryScreen();
    }
  },

  showVictoryScreen() {
    this.switchPanel('victory');

    const winner = this.state.winner;
    this.elements.winnerFilename.textContent = winner.filename;

    const durMin = Math.floor(winner.duration / 60);
    const durSec = Math.floor(winner.duration % 60).toString().padStart(2, '0');

    this.elements.winnerSpecsRow.innerHTML = `
      <span class="badge-format">${winner.formatDesc}</span>
      <span class="badge-format">${durMin}:${durSec} full length</span>
      <span class="badge-format">${winner.sizeMb} MB</span>
      <span class="badge-format">${winner.sampleRate} Hz</span>
    `;

    // Setup full track audio player
    if (winner.file) {
      const blobUrl = URL.createObjectURL(winner.file);
      this.elements.winnerAudioPlayer.src = blobUrl;
      this.elements.btnDownloadWinner.href = blobUrl;
      this.elements.btnDownloadWinner.download = winner.filename;
      this.elements.btnDownloadWinner.style.display = 'inline-flex';
    } else {
      // Demo synthesis playback
      this.elements.btnDownloadWinner.style.display = 'none';
      this.elements.winnerAudioPlayer.src = "";
    }

    // Render Elimination History
    this.elements.tournamentHistoryList.innerHTML = '';
    this.state.history.forEach(m => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML = `
        <span class="history-match-badge">MATCH ${m.matchNumber}</span>
        <div class="history-duel">
          <span class="history-winner">👑 ${m.winnerFilename}</span>
          <span class="text-dim">defeated</span>
          <span class="history-loser">${m.loserFilename}</span>
        </div>
      `;
      this.elements.tournamentHistoryList.appendChild(item);
    });

    launchConfetti();
  },

  showToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    if (isError) toast.style.borderColor = '#ef4444';
    toast.textContent = message;
    this.elements.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 2800);
  },

  initCanvasVisualizer() {
    const canvas = this.elements.visualizerCanvas;
    const ctx = canvas.getContext('2d');
    let vuL = 0;
    let vuR = 0;

    const render = () => {
      requestAnimationFrame(render);

      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      // Grid background
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1;
      for (let y = 15; y < height; y += 20) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      if (audio.analyser && audio.isPlaying) {
        const bufferLength = audio.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        audio.analyser.getByteFrequencyData(dataArray);

        const numBars = 48;
        const barWidth = (width / numBars) - 2;

        let totalEnergy = 0;
        for (let i = 0; i < numBars; i++) {
          const index = Math.floor(Math.pow(i / numBars, 1.8) * bufferLength);
          const val = dataArray[index] || 0;
          totalEnergy += val;

          const barHeight = (val / 255) * (height - 8);
          const x = i * (barWidth + 2);
          const y = height - barHeight;

          const gradient = ctx.createLinearGradient(0, height, 0, 0);
          if (audio.activeSide === 'A') {
            gradient.addColorStop(0, '#0070f3');
            gradient.addColorStop(1, '#00f0ff');
          } else {
            gradient.addColorStop(0, '#a855f7');
            gradient.addColorStop(1, '#d946ef');
          }

          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.roundRect(x, y, barWidth, barHeight, [2, 2, 0, 0]);
          ctx.fill();
        }

        // VU meter
        const avg = (totalEnergy / numBars) / 255;
        vuL = Math.max(avg * 100, vuL * 0.88);
        vuR = Math.max(avg * 96, vuR * 0.88);
      } else {
        vuL *= 0.85;
        vuR *= 0.85;
      }

      this.elements.vuMeterL.style.height = `${Math.min(100, vuL)}%`;
      this.elements.vuMeterR.style.height = `${Math.min(100, vuR)}%`;

      // Timeline Scrubber
      if (audio.bufferA) {
        const cur = audio.getCurrentPlayhead();
        const dur = audio.duration || 15.0;
        const pct = (cur / dur) * 100;

        this.elements.timelineProgressBar.style.width = `${pct}%`;
        this.elements.timelinePlayhead.style.left = `${pct}%`;

        const curSec = Math.floor(cur);
        const curMs = Math.floor((cur % 1) * 10);
        this.elements.timelineCurrentTime.textContent = `00:${curSec.toString().padStart(2, '0')}.${curMs}`;
      }
    };

    render();
  }
};

/* ==========================================================================
   Victory Confetti Engine
   ========================================================================== */

function launchConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const particles = [];
  const colors = ['#00f0ff', '#d946ef', '#f59e0b', '#10b981', '#3b82f6', '#ec4899'];

  for (let i = 0; i < 120; i++) {
    particles.push({
      x: canvas.width / 2,
      y: canvas.height / 3,
      vx: (Math.random() - 0.5) * 18,
      vy: (Math.random() - 0.7) * 18,
      size: Math.random() * 8 + 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * 360,
      vRot: (Math.random() - 0.5) * 12,
      gravity: 0.35,
      opacity: 1
    });
  }

  function frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let active = false;

    particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.rotation += p.vRot;
      p.opacity -= 0.007;

      if (p.opacity > 0) {
        active = true;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.opacity);
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 1.5);
        ctx.restore();
      }
    });

    if (active) {
      requestAnimationFrame(frame);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  frame();
}

document.addEventListener('DOMContentLoaded', () => {
  AppUI.init();
});
