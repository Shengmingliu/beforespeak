const stages = [
  { value: 0, name: "原音" },
  { value: 16, name: "亀裂" },
  { value: 32, name: "欠落" },
  { value: 50, name: "断片" },
  { value: 68, name: "残響" },
  { value: 84, name: "痕跡" },
  { value: 100, name: "識別不能" }
];

const els = {
  fileInput: document.querySelector("#fileInput"),
  dropZone: document.querySelector("#dropZone"),
  presetButtons: [...document.querySelectorAll(".preset-button")],
  workbench: document.querySelector("#workbench"),
  fileName: document.querySelector("#fileName"),
  durationLabel: document.querySelector("#durationLabel"),
  waveform: document.querySelector("#waveform"),
  intensity: document.querySelector("#intensity"),
  intensityValue: document.querySelector("#intensityValue"),
  stageNumber: document.querySelector("#stageNumber"),
  stageName: document.querySelector("#stageName"),
  stageRail: document.querySelector("#stageRail"),
  playButton: document.querySelector("#playButton"),
  dissolveButton: document.querySelector("#dissolveButton"),
  stopButton: document.querySelector("#stopButton"),
  downloadButton: document.querySelector("#downloadButton"),
  markThreshold: document.querySelector("#markThreshold"),
  thresholdResult: document.querySelector("#thresholdResult"),
  thresholdValue: document.querySelector("#thresholdValue"),
  bassLevel: document.querySelector("#bassLevel"),
  bassValue: document.querySelector("#bassValue"),
  vinylLevel: document.querySelector("#vinylLevel"),
  vinylValue: document.querySelector("#vinylValue"),
  wobbleLevel: document.querySelector("#wobbleLevel"),
  wobbleValue: document.querySelector("#wobbleValue"),
  status: document.querySelector("#status")
};

let audioContext;
let originalBuffer;
let processedBuffer;
let activeSource;
let activeNodes = [];
let activeGenerators = [];
let autoRun = false;
let drawTimer;
let statusTimer;
let animationFrame;
let playbackStartedAt = 0;
let playbackDuration = 0;
let liveAnalyser;
let liveWaveData;

function showStatus(message) {
  els.status.textContent = message;
  els.status.classList.add("is-visible");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => els.status.classList.remove("is-visible"), 2600);
}

function getAudioContext() {
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  return audioContext;
}

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function nearestStage(value) {
  return stages.reduce((best, stage, index) => {
    const distance = Math.abs(stage.value - value);
    return distance < best.distance ? { stage, index, distance } : best;
  }, { stage: stages[0], index: 0, distance: Infinity });
}

function seededRandom(index, salt) {
  const raw = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return raw - Math.floor(raw);
}

function getTextureSettings() {
  return {
    bass: Number(els.bassLevel.value) / 100,
    vinyl: Number(els.vinylLevel.value) / 100,
    wobble: Number(els.wobbleLevel.value) / 100
  };
}

function updateTextureUI() {
  els.bassValue.textContent = els.bassLevel.value;
  els.vinylValue.textContent = els.vinylLevel.value;
  els.wobbleValue.textContent = els.wobbleLevel.value;
}

function makeSaturationCurve(amount) {
  const samples = 2048;
  const curve = new Float32Array(samples);
  const drive = 1 + amount * 4;
  const normalizer = Math.tanh(drive);
  for (let i = 0; i < samples; i++) {
    const x = i * 2 / (samples - 1) - 1;
    curve[i] = Math.tanh(x * drive) / normalizer;
  }
  return curve;
}

function createCrackleBuffer(ctx, seconds = 2.4) {
  const length = Math.ceil(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 1987;
  let pop = 0;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < length; i++) {
    if (random() > .9974) pop = (random() * 2 - 1) * (.35 + random() * .55);
    pop *= .93;
    data[i] = (random() * 2 - 1) * .035 + pop;
  }
  return buffer;
}

function createTextureLayer(ctx, destination, voiceSource, duration, settings, startAt) {
  const nodes = [];
  const generators = [];

  if (settings.bass > .001) {
    const bassFilter = ctx.createBiquadFilter();
    const bassGain = ctx.createGain();
    bassFilter.type = "lowpass";
    bassFilter.frequency.value = 125;
    bassGain.gain.value = settings.bass * .042;
    bassFilter.connect(bassGain).connect(destination);
    [43, 64].forEach((frequency, index) => {
      const oscillator = ctx.createOscillator();
      oscillator.type = index ? "triangle" : "sine";
      oscillator.frequency.value = frequency;
      oscillator.connect(bassFilter);
      oscillator.start(startAt);
      oscillator.stop(startAt + duration);
      generators.push(oscillator);
      nodes.push(oscillator);
    });
    nodes.push(bassFilter, bassGain);
  }

  if (settings.vinyl > .001) {
    const crackle = ctx.createBufferSource();
    const crackleFilter = ctx.createBiquadFilter();
    const crackleGain = ctx.createGain();
    crackle.buffer = createCrackleBuffer(ctx);
    crackle.loop = true;
    crackleFilter.type = "highpass";
    crackleFilter.frequency.value = 900;
    crackleGain.gain.value = settings.vinyl * .19;
    crackle.connect(crackleFilter).connect(crackleGain).connect(destination);
    crackle.start(startAt);
    crackle.stop(startAt + duration);
    generators.push(crackle);
    nodes.push(crackle, crackleFilter, crackleGain);
  }

  if (settings.wobble > .001 && voiceSource.detune) {
    const slowLfo = ctx.createOscillator();
    const slowDepth = ctx.createGain();
    const flutterLfo = ctx.createOscillator();
    const flutterDepth = ctx.createGain();
    slowLfo.frequency.value = .34;
    slowDepth.gain.value = settings.wobble * 15;
    flutterLfo.frequency.value = 4.8;
    flutterDepth.gain.value = settings.wobble * 2.6;
    slowLfo.connect(slowDepth).connect(voiceSource.detune);
    flutterLfo.connect(flutterDepth).connect(voiceSource.detune);
    slowLfo.start(startAt);
    flutterLfo.start(startAt);
    slowLfo.stop(startAt + duration);
    flutterLfo.stop(startAt + duration);
    generators.push(slowLfo, flutterLfo);
    nodes.push(slowLfo, slowDepth, flutterLfo, flutterDepth);
  }

  return { nodes, generators };
}

function trimBuffer(buffer, maxSeconds = 30) {
  if (buffer.duration <= maxSeconds) return buffer;
  const ctx = getAudioContext();
  const length = Math.floor(maxSeconds * buffer.sampleRate);
  const trimmed = ctx.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    trimmed.copyToChannel(buffer.getChannelData(channel).slice(0, length), channel);
  }
  return trimmed;
}

function fragmentBuffer(buffer, amount) {
  if (amount <= 0.005) return buffer;
  const ctx = getAudioContext();
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  const intensity = Math.min(1, Math.max(0, amount));
  const segmentSeconds = 0.42 - intensity * 0.34;
  const segmentSamples = Math.max(256, Math.floor(segmentSeconds * buffer.sampleRate));
  const gapProbability = Math.pow(intensity, 1.25) * 0.94;
  const fadeSamples = Math.max(16, Math.floor(buffer.sampleRate * 0.009));
  const segmentCount = Math.ceil(buffer.length / segmentSamples);
  const mask = new Array(segmentCount).fill(true).map((_, i) => seededRandom(i, 11 + Math.round(intensity * 100)) > gapProbability);

  if (!mask.some(Boolean)) mask[Math.floor(segmentCount * 0.43)] = true;

  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const input = buffer.getChannelData(channel);
    const output = out.getChannelData(channel);
    for (let segment = 0; segment < segmentCount; segment++) {
      if (!mask[segment]) continue;
      const start = segment * segmentSamples;
      const end = Math.min(buffer.length, start + segmentSamples);
      const fragmentGain = 1 - intensity * 0.28 + seededRandom(segment, 27) * 0.08;
      for (let i = start; i < end; i++) {
        const local = i - start;
        const tail = end - i - 1;
        const envelope = Math.min(1, local / fadeSamples, tail / fadeSamples);
        output[i] = input[i] * Math.max(0, envelope) * fragmentGain;
      }
    }
  }
  return out;
}

function updateProcessed() {
  if (!originalBuffer) return;
  const amount = Number(els.intensity.value) / 100;
  processedBuffer = fragmentBuffer(originalBuffer, amount);
  updateStageUI();
  drawWaveform(processedBuffer, amount);
}

function updateStageUI() {
  const value = Number(els.intensity.value);
  const current = nearestStage(value);
  els.intensityValue.textContent = value;
  els.stageNumber.textContent = `段階 ${current.index + 1} / ${stages.length}`;
  els.stageName.textContent = current.stage.name;
  [...els.stageRail.children].forEach((chip, index) => chip.classList.toggle("is-active", index === current.index));
}

function buildStageRail() {
  stages.forEach((stage, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "stage-tick";
    button.style.left = `${stage.value}%`;
    button.innerHTML = `<i aria-hidden="true"></i><span>${stage.name}</span>`;
    button.setAttribute("role", "listitem");
    button.setAttribute("aria-label", `${stage.value}% ${stage.name}`);
    button.addEventListener("click", () => {
      els.intensity.value = stage.value;
      updateProcessed();
    });
    els.stageRail.appendChild(button);
  });
  updateStageUI();
}

function drawWaveform(buffer, amount = 0, progress = null, level = 0, liveData = null) {
  const canvas = els.waveform;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const targetWidth = Math.floor(rect.width * dpr);
  const targetHeight = Math.floor(rect.height * dpr);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  ctx.strokeStyle = "rgba(56, 73, 90, .18)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, rect.height / 2);
  ctx.lineTo(rect.width, rect.height / 2);
  ctx.stroke();
  if (!buffer) return;

  const data = buffer.getChannelData(0);
  const columns = Math.max(200, Math.floor(rect.width * 1.2));
  const block = Math.max(1, Math.floor(data.length / columns));
  const peaks = new Float32Array(columns);
  for (let x = 0; x < columns; x++) {
    const start = x * block;
    for (let j = 0; j < block && start + j < data.length; j++) {
      peaks[x] = Math.max(peaks[x], Math.abs(data[start + j]));
    }
  }

  const strokeWave = (color, alpha, clipWidth = null) => {
    ctx.save();
    if (clipWidth !== null) {
      ctx.beginPath();
      ctx.rect(0, 0, Math.max(0, clipWidth), rect.height);
      ctx.clip();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.35;
    [-1, 1].forEach((direction, pass) => {
      ctx.globalAlpha = pass ? alpha * .34 : alpha;
      ctx.beginPath();
      let drawing = false;
      for (let x = 0; x < columns; x++) {
        const peak = peaks[x];
        const px = (x / (columns - 1)) * rect.width;
        const py = rect.height / 2 + direction * peak * rect.height * .38;
        if (peak < .0015) { drawing = false; continue; }
        if (!drawing) { ctx.moveTo(px, py); drawing = true; }
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    });
    ctx.restore();
  };

  const isPlaying = progress !== null;
  strokeWave(isPlaying ? "#8a949e" : (amount > .72 ? "#567fa5" : "#3e4852"), isPlaying ? .68 : .9);

  if (isPlaying) {
    const boundedProgress = Math.max(0, Math.min(1, progress));
    const playheadX = boundedProgress * rect.width;
    strokeWave(amount > .72 ? "#537da4" : "#304f6d", 1, playheadX);

    if (liveData) {
      const liveWidth = Math.min(180, rect.width * .24);
      const liveStart = Math.max(0, Math.min(rect.width - liveWidth, playheadX - liveWidth / 2));
      ctx.strokeStyle = "#567fa5";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < liveData.length; i++) {
        const x = liveStart + (i / (liveData.length - 1)) * liveWidth;
        const sample = (liveData[i] - 128) / 128;
        const y = rect.height / 2 + sample * (20 + level * 140);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(52, 86, 116, .62)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(playheadX, 22);
    ctx.lineTo(playheadX, rect.height - 22);
    ctx.stroke();

    ctx.fillStyle = `rgba(86, 125, 162, ${.08 + Math.min(.22, level * 1.8)})`;
    ctx.beginPath();
    ctx.arc(playheadX, rect.height / 2, 10 + level * 90, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#365d80";
    ctx.beginPath();
    ctx.arc(playheadX, rect.height / 2, 3 + level * 15, 0, Math.PI * 2);
    ctx.fill();
  }
}

function stopWaveAnimation(reset = true) {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = null;
  liveAnalyser = null;
  liveWaveData = null;
  if (reset) drawWaveform(processedBuffer, Number(els.intensity.value) / 100);
}

function startWaveAnimation(ctx, duration, analyser) {
  stopWaveAnimation(false);
  playbackStartedAt = ctx.currentTime;
  playbackDuration = Math.max(.01, duration);
  liveAnalyser = analyser;
  liveWaveData = new Uint8Array(analyser.fftSize);

  const tick = () => {
    if (!activeSource || liveAnalyser !== analyser) return;
    analyser.getByteTimeDomainData(liveWaveData);
    let energy = 0;
    for (const sample of liveWaveData) {
      const normalized = (sample - 128) / 128;
      energy += normalized * normalized;
    }
    const level = Math.sqrt(energy / liveWaveData.length);
    const progress = Math.min(1, (ctx.currentTime - playbackStartedAt) / playbackDuration);
    drawWaveform(processedBuffer, Number(els.intensity.value) / 100, progress, level, liveWaveData);
    if (progress < 1) animationFrame = requestAnimationFrame(tick);
  };
  tick();
}

function clearActiveAudio() {
  stopWaveAnimation();
  if (activeSource) {
    activeSource.onended = null;
    try { activeSource.stop(); } catch (_) {}
    activeSource = null;
  }
  activeGenerators.forEach(node => {
    try { node.stop(); } catch (_) {}
  });
  activeGenerators = [];
  activeNodes.forEach(node => {
    try { node.disconnect(); } catch (_) {}
  });
  activeNodes = [];
}

function stopPlayback() {
  autoRun = false;
  clearActiveAudio();
  els.stopButton.disabled = true;
  els.playButton.disabled = !originalBuffer;
  els.dissolveButton.disabled = !originalBuffer;
}

async function playCurrent({ onEnded } = {}) {
  if (!processedBuffer) return;
  clearActiveAudio();
  const ctx = getAudioContext();
  if (ctx.state === "suspended") await ctx.resume();
  const amount = Number(els.intensity.value) / 100;
  const texture = getTextureSettings();
  const source = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const saturation = ctx.createWaveShaper();
  const dry = ctx.createGain();
  const delay = ctx.createDelay(1.4);
  const feedback = ctx.createGain();
  const wet = ctx.createGain();
  const master = ctx.createGain();
  const analyser = ctx.createAnalyser();

  source.buffer = processedBuffer;
  filter.type = "lowpass";
  filter.frequency.value = 14500 * Math.pow(1 - amount, 2.15) + 260;
  filter.Q.value = .65 + amount * 1.2;
  saturation.curve = makeSaturationCurve(texture.vinyl);
  saturation.oversample = "2x";
  dry.gain.value = 1 - amount * .58;
  delay.delayTime.value = .08 + amount * .46;
  feedback.gain.value = .08 + amount * .48;
  wet.gain.value = amount * .44;
  master.gain.value = .92;
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = .72;

  source.connect(filter).connect(saturation);
  saturation.connect(dry).connect(master);
  saturation.connect(delay);
  delay.connect(feedback).connect(delay);
  delay.connect(wet).connect(master);
  master.connect(analyser).connect(ctx.destination);

  const textureLayer = createTextureLayer(
    ctx,
    master,
    source,
    processedBuffer.duration + 1.2,
    texture,
    ctx.currentTime
  );

  activeSource = source;
  activeGenerators = textureLayer.generators;
  activeNodes = [source, filter, saturation, dry, delay, feedback, wet, master, analyser, ...textureLayer.nodes];
  els.stopButton.disabled = false;
  els.playButton.disabled = true;
  els.dissolveButton.disabled = true;
  source.onended = () => {
    activeSource = null;
    stopWaveAnimation();
    activeGenerators.forEach(node => { try { node.stop(); } catch (_) {} });
    activeGenerators = [];
    activeNodes.forEach(node => { try { node.disconnect(); } catch (_) {} });
    activeNodes = [];
    if (onEnded) onEnded();
    else {
      els.stopButton.disabled = true;
      els.playButton.disabled = false;
      els.dissolveButton.disabled = false;
    }
  };
  source.start();
  startWaveAnimation(ctx, processedBuffer.duration, analyser);
}

function runDissolve(stageIndex = 0) {
  if (!autoRun || stageIndex >= stages.length) {
    autoRun = false;
    els.stopButton.disabled = true;
    els.playButton.disabled = false;
    els.dissolveButton.disabled = false;
    if (stageIndex >= stages.length) showStatus("声は意味を失いました");
    return;
  }
  els.intensity.value = stages[stageIndex].value;
  updateProcessed();
  playCurrent({ onEnded: () => runDissolve(stageIndex + 1) });
}

function setActivePreset(activeButton = null) {
  els.presetButtons.forEach(button => {
    button.setAttribute("aria-pressed", String(button === activeButton));
  });
}

async function decodeAndLoad(arrayBuffer, label, successMessage) {
  const ctx = getAudioContext();
  const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
  originalBuffer = trimBuffer(decoded, 30);
  processedBuffer = originalBuffer;
  els.fileName.textContent = label;
  els.durationLabel.textContent = formatDuration(originalBuffer.duration);
  els.intensity.value = 0;
  els.workbench.classList.remove("is-disabled");
  els.playButton.disabled = false;
  els.dissolveButton.disabled = false;
  els.downloadButton.disabled = false;
  els.thresholdResult.hidden = true;
  updateProcessed();
  showStatus(decoded.duration > 30 ? "音声を読み込み、冒頭30秒を使用します" : successMessage);
}

async function handleFile(file) {
  const supportedName = file && /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name);
  if (!file || (!file.type.startsWith("audio/") && !supportedName)) {
    showStatus("音声ファイルを選択してください");
    return;
  }
  stopPlayback();
  setActivePreset();
  try {
    showStatus("音声を読み込んでいます…");
    const arrayBuffer = await file.arrayBuffer();
    await decodeAndLoad(arrayBuffer, file.name, "音声を読み込みました。ブラウザ内で処理します");
  } catch (error) {
    console.error(error);
    showStatus("この形式を再生できません。MP3、WAV、M4Aをお試しください");
  }
}

async function handlePreset(button) {
  stopPlayback();
  els.presetButtons.forEach(item => { item.disabled = true; });
  button.classList.add("is-loading");
  showStatus(`「${button.dataset.label}」を読み込んでいます…`);
  try {
    const response = await fetch(button.dataset.audioSrc);
    if (!response.ok) throw new Error(`Audio request failed: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    await decodeAndLoad(arrayBuffer, button.dataset.label, `「${button.dataset.label}」を選択しました`);
    setActivePreset(button);
  } catch (error) {
    console.error(error);
    showStatus("サンプル音声を読み込めませんでした。ページを更新してください");
  } finally {
    button.classList.remove("is-loading");
    els.presetButtons.forEach(item => { item.disabled = false; });
  }
}

async function renderForDownload(buffer, amount) {
  const sampleRate = buffer.sampleRate;
  const tail = Math.floor(sampleRate * 1.6);
  const offline = new OfflineAudioContext(buffer.numberOfChannels, buffer.length + tail, sampleRate);
  const texture = getTextureSettings();
  const source = offline.createBufferSource();
  const filter = offline.createBiquadFilter();
  const saturation = offline.createWaveShaper();
  const dry = offline.createGain();
  const delay = offline.createDelay(1.4);
  const feedback = offline.createGain();
  const wet = offline.createGain();
  const master = offline.createGain();
  source.buffer = buffer;
  filter.type = "lowpass";
  filter.frequency.value = 14500 * Math.pow(1 - amount, 2.15) + 260;
  filter.Q.value = .65 + amount * 1.2;
  saturation.curve = makeSaturationCurve(texture.vinyl);
  saturation.oversample = "2x";
  dry.gain.value = 1 - amount * .58;
  delay.delayTime.value = .08 + amount * .46;
  feedback.gain.value = .08 + amount * .48;
  wet.gain.value = amount * .44;
  master.gain.value = .92;
  source.connect(filter).connect(saturation);
  saturation.connect(dry).connect(master);
  saturation.connect(delay);
  delay.connect(feedback).connect(delay);
  delay.connect(wet).connect(master);
  master.connect(offline.destination);
  createTextureLayer(offline, master, source, (buffer.length + tail) / sampleRate, texture, 0);
  source.start();
  return offline.startRendering();
}

function audioBufferToWav(buffer) {
  const channels = buffer.numberOfChannels;
  const length = buffer.length * channels * 2 + 44;
  const arrayBuffer = new ArrayBuffer(length);
  const view = new DataView(arrayBuffer);
  const writeString = (offset, text) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  writeString(0, "RIFF");
  view.setUint32(4, length - 8, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, length - 44, true);
  const data = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = Math.max(-1, Math.min(1, data[channel][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([arrayBuffer], { type: "audio/wav" });
}

els.fileInput.addEventListener("change", event => handleFile(event.target.files[0]));
els.presetButtons.forEach(button => {
  button.addEventListener("click", () => handlePreset(button));
});
els.dropZone.addEventListener("dragover", event => { event.preventDefault(); els.dropZone.classList.add("is-dragging"); });
els.dropZone.addEventListener("dragleave", () => els.dropZone.classList.remove("is-dragging"));
els.dropZone.addEventListener("drop", event => {
  event.preventDefault();
  els.dropZone.classList.remove("is-dragging");
  handleFile(event.dataTransfer.files[0]);
});

els.intensity.addEventListener("input", () => {
  clearTimeout(drawTimer);
  drawTimer = setTimeout(updateProcessed, 45);
  updateStageUI();
});
els.intensity.addEventListener("change", () => {
  els.intensity.value = nearestStage(Number(els.intensity.value)).stage.value;
  updateProcessed();
});
[els.bassLevel, els.vinylLevel, els.wobbleLevel].forEach(control => {
  control.addEventListener("input", updateTextureUI);
});
els.playButton.addEventListener("click", () => playCurrent());
els.stopButton.addEventListener("click", stopPlayback);
els.dissolveButton.addEventListener("click", () => {
  stopPlayback();
  autoRun = true;
  showStatus("連続変化を開始します");
  runDissolve(0);
});
els.markThreshold.addEventListener("click", () => {
  if (!originalBuffer) return;
  const value = Number(els.intensity.value);
  els.thresholdValue.textContent = `${value}%（${nearestStage(value).stage.name}）`;
  els.thresholdResult.hidden = false;
});
els.downloadButton.addEventListener("click", async () => {
  if (!processedBuffer) return;
  els.downloadButton.disabled = true;
  showStatus("WAVを書き出しています…");
  try {
    const amount = Number(els.intensity.value) / 100;
    const rendered = await renderForDownload(processedBuffer, amount);
    const blob = audioBufferToWav(rendered);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `before-speaking-${Math.round(amount * 100)}.wav`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showStatus("現在の段階を書き出しました");
  } catch (error) {
    console.error(error);
    showStatus("書き出しに失敗しました。別のブラウザでお試しください");
  } finally {
    els.downloadButton.disabled = false;
  }
});

window.addEventListener("resize", () => drawWaveform(processedBuffer, Number(els.intensity.value) / 100));
buildStageRail();
updateTextureUI();
drawWaveform(null);
