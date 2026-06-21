let audioCtx;
let trackBuffers = [null, null, null, null]; // 0-2: backing tracks, 3: click track
let detectedTransients = [];
let targetBpm = 120;

// Playback & Transport State
let isPlaying = false;
let playheadPosition = 0; // in seconds
let startTime = 0; // audioCtx.currentTime when playback started
let activeSources = []; // currently playing sources: { source: AudioBufferSourceNode, gainNode: GainNode, index: number/string }
let playheadAnimFrame = null;
let totalDuration = 0;

// Track Mixing States (1.0 = 100% volume)
let trackVolume = [1.0, 1.0, 1.0, 0.8];
let trackMute = [false, false, false, false];
let trackSolo = [false, false, false, false];

// Recording State
let mediaRecorder = null;
let recordedChunks = [];
let selectedDeviceId = "";

document.getElementById('initAudio').addEventListener('click', async () => {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }
    alert("Silnik Web Audio gotowy.");
});

// Import śladów podkładu
document.querySelectorAll('.track-input').forEach(input => {
    input.addEventListener('change', async (e) => {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }
        const idx = parseInt(e.target.dataset.index);
        const file = e.target.files[0];
        if (!file) return;
        const arrBuffer = await file.arrayBuffer();
        trackBuffers[idx] = await audioCtx.decodeAudioData(arrBuffer);

        document.getElementById('analyzeBtn').disabled = false;
        document.getElementById('renderBtn').disabled = false;

        updateDuration();
        drawAllWaveforms();

        alert(`Ślad ${idx + 1} załadowany.`);
    });
});

// Analiza rytmu i kliku (BPM Detektor)
document.getElementById('analyzeBtn').addEventListener('click', () => {
    const referenceBuffer = trackBuffers.slice(0, 3).find(b => b !== null);
    if (!referenceBuffer) return;
    const rawData = referenceBuffer.getChannelData(0);
    const sampleRate = referenceBuffer.sampleRate;
    const hopSize = 512;
    const transientThreshold = 0.15;
    detectedTransients = [];
    let lastEnergy = 0;

    for (let i = 0; i < rawData.length; i += hopSize) {
        let energy = 0;
        for (let j = 0; j < hopSize && (i + j) < rawData.length; j++) {
            energy += rawData[i + j] * rawData[i + j];
        }
        energy = Math.sqrt(energy / hopSize);
        if (energy - lastEnergy > transientThreshold) {
            detectedTransients.push(i / sampleRate);
        }
        lastEnergy = energy;
    }

    if (detectedTransients.length > 1) {
        let intervals = [];
        for (let i = 1; i < detectedTransients.length; i++) {
            intervals.push(detectedTransients[i] - detectedTransients[i - 1]);
        }
        let avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        targetBpm = Math.round(60 / avgInterval);
        while (targetBpm < 60) targetBpm *= 2;
        while (targetBpm > 180) targetBpm /= 2;
    }

    document.getElementById('detectedBpm').innerText = Math.round(targetBpm) + " BPM";
    document.getElementById('bpmInput').value = Math.round(targetBpm);

    const timeline = document.getElementById('clickTimeline');
    timeline.innerHTML = '';
    const duration = referenceBuffer.duration;
    detectedTransients.forEach(t => {
        let marker = document.createElement('div');
        marker.className = 'transient-marker';
        marker.style.left = ((t / duration) * 100) + '%';
        timeline.appendChild(marker);
    });

    // Aktualizacja kliku i rysowania na nowo
    updateDuration();
    drawAllWaveforms();

    document.getElementById('renderBtn').disabled = false;
    alert("Analiza rytmu zakończona. Ustawiono wykryte tempo: " + Math.round(targetBpm) + " BPM.");
});

// Generator bufora śladu Click Track
function generateClickBuffer(duration, bpm, timeSignature, clickType, offset, sampleRate) {
    const numSamples = Math.max(100, Math.floor(sampleRate * duration));
    const buffer = audioCtx.createBuffer(1, numSamples, sampleRate);
    const channelData = buffer.getChannelData(0);

    const [beatsPerMeasureStr, beatValueStr] = timeSignature.split('/');
    const beatsPerMeasure = parseInt(beatsPerMeasureStr) || 4;
    const beatValue = parseInt(beatValueStr) || 4;

    // Długość jednego uderzenia w sekundach
    const beatDuration = (60 / bpm) * (4 / beatValue);

    const decay = clickType === 'synth' ? 60 : (clickType === 'rim' ? 120 : 40);

    let i = 0;
    while (true) {
        const beatTime = offset + i * beatDuration;
        if (beatTime >= duration) break;
        if (beatTime >= 0) {
            const startSample = Math.floor(beatTime * sampleRate);
            const isDownbeat = (i % beatsPerMeasure === 0);

            // Długość dźwięku kliku (maksymalnie 80ms)
            const clickLen = Math.floor(sampleRate * 0.08);
            for (let s = 0; s < clickLen; s++) {
                const sampleIdx = startSample + s;
                if (sampleIdx >= numSamples) break;

                const t = s / sampleRate;
                let val = 0;

                if (clickType === 'synth') {
                    const freq = isDownbeat ? 1200 : 800;
                    val = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * decay);
                } else if (clickType === 'rim') {
                    const freq = isDownbeat ? 1800 : 1300;
                    val = (Math.abs((t * freq) % 1 - 0.5) - 0.25) * 4 * Math.exp(-t * decay);
                } else if (clickType === 'cowbell') {
                    const f1 = isDownbeat ? 850 : 560;
                    const f2 = isDownbeat ? 1200 : 800;
                    const sq1 = Math.sign(Math.sin(2 * Math.PI * f1 * t));
                    const sq2 = Math.sign(Math.sin(2 * Math.PI * f2 * t));
                    val = 0.5 * (sq1 + sq2) * Math.exp(-t * decay);
                }

                channelData[sampleIdx] += val * 0.4;
                if (channelData[sampleIdx] > 1) channelData[sampleIdx] = 1;
                if (channelData[sampleIdx] < -1) channelData[sampleIdx] = -1;
            }
        }
        i++;
    }
    return buffer;
}

// Funkcja aktualizująca bufor kliku w pamięci
function updateClickTrackBuffer() {
    if (!audioCtx) return;
    const bpm = parseFloat(document.getElementById('bpmInput').value) || 120;
    const timeSignature = document.getElementById('metrumSelect').value || '4/4';
    const clickType = document.getElementById('clickSoundSelect').value || 'synth';
    const offset = parseFloat(document.getElementById('clickOffsetInput').value) || 0;

    trackBuffers[3] = generateClickBuffer(totalDuration, bpm, timeSignature, clickType, offset, audioCtx.sampleRate);
}

// Funkcja aktualizująca klik podczas odtwarzania (w czasie rzeczywistym)
function updateClickTrackDuringPlayback() {
    if (!isPlaying || !audioCtx) return;

    // Znajdź aktywny proces odtwarzania kliku
    const clickActiveIdx = activeSources.findIndex(a => a.index === 3);
    const clickActive = clickActiveIdx !== -1 ? activeSources[clickActiveIdx] : null;

    if (clickActive) {
        try {
            clickActive.source.stop();
        } catch (e) { }
        activeSources.splice(clickActiveIdx, 1);
    }

    // Regeneruj bufor kliku
    updateClickTrackBuffer();

    // Oblicz bieżący czas w odtwarzaniu
    const elapsed = audioCtx.currentTime - startTime;
    const currentPos = playheadPosition + elapsed;

    const clickBuffer = trackBuffers[3];
    if (clickBuffer && currentPos < clickBuffer.duration) {
        const isAnySolo = trackSolo.some(s => s === true);
        let src = audioCtx.createBufferSource();
        src.buffer = clickBuffer;

        let gainNode = audioCtx.createGain();
        let vol = trackVolume[3];
        if (trackMute[3]) vol = 0;
        if (isAnySolo && !trackSolo[3]) vol = 0;

        gainNode.gain.setValueAtTime(vol, audioCtx.currentTime);
        src.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        src.start(0, currentPos);

        activeSources.push({
            source: src,
            gainNode: gainNode,
            index: 3
        });
    }
}

// === SYSTEM TRANSPORTU I OŚ CZASU ===

function updateDuration() {
    // Obliczamy czas trwania tylko na podstawie załadowanych śladów podkładu (0-2)
    const backingTracksDuration = Math.max(...trackBuffers.slice(0, 3).filter(b => b !== null).map(b => b.duration), 0);
    totalDuration = backingTracksDuration > 0 ? backingTracksDuration : 30.0; // Domyślnie 30 sekund

    updateClickTrackBuffer();
    updatePlayheadPositionUI();
    updateTimeDisplay();
}

function updatePlayheadPositionUI(pos = playheadPosition) {
    if (totalDuration === 0) return;
    const percent = (pos / totalDuration) * 100;

    document.querySelectorAll('.playhead-overlay').forEach(overlay => {
        overlay.style.left = percent + '%';
    });
}

function updateTimeDisplay(pos = playheadPosition) {
    const formatTime = (seconds) => {
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 100);
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
    };

    const currentStr = formatTime(pos);
    const totalStr = formatTime(totalDuration);
    document.getElementById('timeDisplay').innerText = `${currentStr} / ${totalStr}`;
}

// Rysowanie waveformów
function drawAllWaveforms() {
    trackBuffers.forEach((buffer, idx) => {
        const canvas = document.getElementById(`canvas-${idx}`);
        const placeholder = document.getElementById(`placeholder-${idx}`);
        const playhead = document.getElementById(`playhead-${idx}`);

        if (buffer) {
            placeholder.style.display = 'none';
            canvas.style.display = 'block';
            playhead.style.display = 'block';
            drawWaveform(canvas, buffer);
        } else {
            placeholder.style.display = 'block';
            canvas.style.display = 'none';
            playhead.style.display = 'none';
        }
    });
}

function drawWaveform(canvas, buffer) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) return;

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;

    ctx.clearRect(0, 0, width, height);

    // Oś środkowa
    ctx.strokeStyle = '#232335';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    const rawData = buffer.getChannelData(0);
    const drawWidth = Math.floor((buffer.duration / totalDuration) * width);
    if (drawWidth <= 0) return;

    const samplesPerPixel = Math.max(1, Math.floor(rawData.length / drawWidth));

    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#00ebc7');
    grad.addColorStop(0.5, '#7b2cbf');
    grad.addColorStop(1, '#ff5e7e');

    ctx.fillStyle = grad;

    for (let x = 0; x < drawWidth; x++) {
        const startSample = x * samplesPerPixel;
        const endSample = Math.min(startSample + samplesPerPixel, rawData.length);

        let min = 1.0;
        let max = -1.0;

        for (let s = startSample; s < endSample; s++) {
            const val = rawData[s];
            if (val < min) min = val;
            if (val > max) max = val;
        }

        const yMin = ((min + 1) / 2) * height;
        const yMax = ((max + 1) / 2) * height;

        ctx.fillRect(x, yMin, 1, Math.max(1, yMax - yMin));
    }
}

// Re-render przy zmianie okna
window.addEventListener('resize', () => {
    if (totalDuration > 0) {
        drawAllWaveforms();
    }
});

// Sterowanie transportem
function togglePlayPause() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    if (isPlaying) {
        pausePlayback();
    } else {
        startPlayback();
    }
}

function startPlayback() {
    if (totalDuration === 0) return;
    if (isPlaying) return;

    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    // Upewniamy się, że ścieżka kliku jest wygenerowana
    updateClickTrackBuffer();

    startTime = audioCtx.currentTime;
    const isAnySolo = trackSolo.some(s => s === true);

    activeSources = [];

    trackBuffers.forEach((buffer, idx) => {
        if (buffer) {
            let offset = playheadPosition;

            if (offset < buffer.duration) {
                let src = audioCtx.createBufferSource();
                src.buffer = buffer;

                let gainNode = audioCtx.createGain();
                let vol = trackVolume[idx];
                if (trackMute[idx]) vol = 0;
                if (isAnySolo && !trackSolo[idx]) vol = 0;

                gainNode.gain.setValueAtTime(vol, audioCtx.currentTime);

                src.connect(gainNode);
                gainNode.connect(audioCtx.destination);

                src.start(0, offset);

                activeSources.push({
                    source: src,
                    gainNode: gainNode,
                    index: idx
                });
            }
        }
    });

    isPlaying = true;
    updateTransportUI();

    if (playheadAnimFrame) cancelAnimationFrame(playheadAnimFrame);
    playheadAnimFrame = requestAnimationFrame(animatePlayhead);
}

function pausePlayback() {
    if (!isPlaying) return;

    const elapsed = audioCtx.currentTime - startTime;
    playheadPosition += elapsed;
    if (playheadPosition > totalDuration) playheadPosition = totalDuration;

    stopPlaybackSources();
    isPlaying = false;
    updateTransportUI();
}

function stopPlayback() {
    stopPlaybackSources();
    playheadPosition = 0;
    isPlaying = false;
    updateTransportUI();
    updatePlayheadPositionUI();
    updateTimeDisplay();
}

function rewindPlayback() {
    const wasPlaying = isPlaying;
    stopPlaybackSources();
    playheadPosition = 0;
    updatePlayheadPositionUI();
    updateTimeDisplay();
    if (wasPlaying) {
        startPlayback();
    }
}

function stopPlaybackSources() {
    activeSources.forEach(active => {
        try {
            active.source.stop();
        } catch (e) { }
    });
    activeSources = [];
    if (playheadAnimFrame) {
        cancelAnimationFrame(playheadAnimFrame);
        playheadAnimFrame = null;
    }
}

function updateTransportUI() {
    const playBtn = document.getElementById('playBtn');
    if (isPlaying) {
        playBtn.innerHTML = '⏸️ Pauza';
        playBtn.style.background = '#ff5e7e';
        playBtn.style.color = '#fff';
    } else {
        playBtn.innerHTML = '▶️ Odtwórz';
        playBtn.style.background = '#00ebc7';
        playBtn.style.color = '#101015';
    }
}

function animatePlayhead() {
    if (!isPlaying) return;

    const elapsed = audioCtx.currentTime - startTime;
    const currentPos = playheadPosition + elapsed;

    if (currentPos >= totalDuration) {
        stopPlayback();
        return;
    }

    updatePlayheadPositionUI(currentPos);
    updateTimeDisplay(currentPos);

    playheadAnimFrame = requestAnimationFrame(animatePlayhead);
}

function seekTo(time) {
    if (totalDuration === 0) return;

    time = Math.max(0, Math.min(time, totalDuration));

    const wasPlaying = isPlaying;
    if (isPlaying) {
        stopPlaybackSources();
    }

    playheadPosition = time;
    updatePlayheadPositionUI();
    updateTimeDisplay();

    if (wasPlaying) {
        startPlayback();
    }
}

// === OBSŁUGA MIKSERA ===

function setupMixerListeners() {
    // Volume sliders
    document.querySelectorAll('.vol-slider').forEach(slider => {
        slider.addEventListener('input', (e) => {
            const idx = parseInt(e.target.dataset.index);
            const val = parseFloat(e.target.value);
            trackVolume[idx] = val;
            updateTrackGains();
        });
    });

    // Mute buttons
    document.querySelectorAll('.mute-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt(e.target.dataset.index);
            trackMute[idx] = !trackMute[idx];

            if (trackMute[idx]) {
                btn.classList.add('active-mute');
            } else {
                btn.classList.remove('active-mute');
            }

            updateTrackGains();
        });
    });

    // Solo buttons
    document.querySelectorAll('.solo-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt(e.target.dataset.index);
            trackSolo[idx] = !trackSolo[idx];

            if (trackSolo[idx]) {
                btn.classList.add('active-solo');
            } else {
                btn.classList.remove('active-solo');
            }

            updateTrackGains();
        });
    });
}

function updateTrackGains() {
    const isAnySolo = trackSolo.some(s => s === true);
    activeSources.forEach(active => {
        const idx = active.index;
        let vol = trackVolume[idx];
        if (trackMute[idx]) vol = 0;
        if (isAnySolo && !trackSolo[idx]) vol = 0;
        active.gainNode.gain.setValueAtTime(vol, audioCtx.currentTime);
    });
}

function setupTimelineListeners() {
    document.querySelectorAll('.waveform-container').forEach(container => {
        container.addEventListener('click', (e) => {
            if (totalDuration === 0) return;

            const rect = container.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const percent = clickX / rect.width;
            seekTo(percent * totalDuration);
        });
    });
}

function setupTransportListeners() {
    document.getElementById('playBtn').addEventListener('click', togglePlayPause);
    document.getElementById('stopBtn').addEventListener('click', stopPlayback);
    document.getElementById('rewindBtn').addEventListener('click', rewindPlayback);
}

// === EKSPORT & offline RENDER ===

document.getElementById('renderBtn').addEventListener('click', async () => {
    // Regeneruj bufor kliku przed renderowaniem
    updateClickTrackBuffer();

    // Oblicz maksymalny czas trwania ze wszystkich śladów
    const maxDuration = Math.max(...trackBuffers.filter(b => b !== null).map(b => b.duration), 0);
    if (maxDuration === 0) return;

    const sampleRate = audioCtx.sampleRate;
    const renderCtx = new OfflineAudioContext(2, sampleRate * maxDuration, sampleRate);
    const isAnySolo = trackSolo.some(s => s === true);

    // Render śladów tła oraz kliku
    trackBuffers.forEach((buffer, idx) => {
        if (buffer) {
            let source = renderCtx.createBufferSource();
            source.buffer = buffer;

            let gainNode = renderCtx.createGain();
            let vol = trackVolume[idx];
            if (trackMute[idx]) vol = 0;
            if (isAnySolo && !trackSolo[idx]) vol = 0;

            gainNode.gain.setValueAtTime(vol, 0);
            source.connect(gainNode);
            gainNode.connect(renderCtx.destination);

            source.start(0);
        }
    });

    const renderedBuffer = await renderCtx.startRendering();
    const wavBlob = bufferToWav(renderedBuffer);
    const url = URL.createObjectURL(wavBlob);

    document.getElementById('downloadLinkSection').innerHTML = `<a href="${url}" download="master_mix.wav" class="download-btn">💾 POBIERZ WYRENDEROWANY UTWÓR</a>`;
});

function bufferToWav(buffer) {
    let numOfChan = buffer.numberOfChannels, length = buffer.length * numOfChan * 2 + 44, bufferArr = new ArrayBuffer(length), view = new DataView(bufferArr), channels = [], i, sample, offset = 0, pos = 0;
    function setUint16(data) { view.setUint16(pos, data, true); pos += 2; }
    function setUint32(data) { view.setUint32(pos, data, true); pos += 4; }
    setUint32(0x46464952); setUint32(length - 8); setUint32(0x45564157);
    setUint32(0x20746d66); setUint32(16); setUint16(1); setUint16(numOfChan);
    setUint32(buffer.sampleRate); setUint32(buffer.sampleRate * 2 * numOfChan);
    setUint16(numOfChan * 2); setUint16(16); setUint32(0x61746164); setUint32(length - pos - 4);
    for (i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
    while (pos < length) {
        for (i = 0; i < numOfChan; i++) {
            sample = Math.max(-1, Math.min(1, channels[i][offset]));
            sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            view.setInt16(pos, sample, true); pos += 2;
        }
        offset++;
    } return new Blob([bufferArr], { type: 'audio/wav' });
}

// === OBSŁUGA MODALA I INNE EVENTY ===

function setupModalListeners() {
    const modal = document.getElementById('optionsModal');
    const optionsBtn = document.getElementById('optionsBtn');
    const closeModalBtn = document.getElementById('closeModalBtn');

    optionsBtn.addEventListener('click', () => {
        modal.style.display = 'flex';
        populateInputDevices();
    });

    closeModalBtn.addEventListener('click', () => {
        modal.style.display = 'none';
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });
}

async function populateInputDevices() {
    try {
        let devices = await navigator.mediaDevices.enumerateDevices();
        let hasLabel = devices.some(d => d.label);

        if (!hasLabel) {
            try {
                const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                tempStream.getTracks().forEach(t => t.stop());
                devices = await navigator.mediaDevices.enumerateDevices();
            } catch (permErr) {
                console.warn("Brak uprawnień przy zapytaniu wstępnym:", permErr);
            }
        }

        const select = document.getElementById('audioInputDevice');
        select.innerHTML = '';

        const audioInputs = devices.filter(d => d.kind === 'audioinput');
        if (audioInputs.length === 0) {
            select.innerHTML = '<option value="">Brak mikrofonów</option>';
            return;
        }

        audioInputs.forEach(dev => {
            const opt = document.createElement('option');
            opt.value = dev.deviceId;
            opt.textContent = dev.label || `Wejście audio (${dev.deviceId.slice(0, 5)})`;
            if (dev.deviceId === selectedDeviceId) {
                opt.selected = true;
            }
            select.appendChild(opt);
        });

        if (!selectedDeviceId && audioInputs.length > 0) {
            selectedDeviceId = audioInputs[0].deviceId;
        }
    } catch (err) {
        console.error("Błąd wczytywania urządzeń:", err);
        const select = document.getElementById('audioInputDevice');
        select.innerHTML = '<option value="">Brak uprawnień do mikrofonu</option>';
    }
}

function handleClickParamChange() {
    updateDuration();
    drawAllWaveforms();
    if (isPlaying) {
        updateClickTrackDuringPlayback();
    }
}

async function handleRecordToggle() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }

    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
        try {
            const constraints = {
                audio: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : true
            };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);

            recordedChunks = [];
            mediaRecorder = new MediaRecorder(stream);
            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) recordedChunks.push(e.data);
            };
            mediaRecorder.onstop = async () => {
                stream.getTracks().forEach(track => track.stop());

                const blob = new Blob(recordedChunks, { type: 'audio/webm' });
                const arrBuffer = await blob.arrayBuffer();
                try {
                    const decoded = await audioCtx.decodeAudioData(arrBuffer);
                    const targetIdx = parseInt(document.getElementById('recordTargetTrack').value);
                    trackBuffers[targetIdx] = decoded;

                    document.getElementById('analyzeBtn').disabled = false;
                    document.getElementById('renderBtn').disabled = false;

                    updateDuration();
                    drawAllWaveforms();
                    alert(`Pomyślnie nagrano audio na Ślad ${targetIdx + 1}!`);
                } catch (err) {
                    console.error("Błąd dekodowania:", err);
                    alert("Błąd podczas zapisu i dekodowania nagranego dźwięku.");
                }
            };

            // Rozpocznij odtwarzanie i nagrywanie zsynchronizowane od zera
            seekTo(0);
            startPlayback();
            mediaRecorder.start();

            const recBtn = document.getElementById('recordBtn');
            recBtn.innerHTML = "⏹️ Stop";
            recBtn.style.background = "#fff";
            recBtn.style.color = "#ff5e7e";
            document.getElementById('recordingStatus').style.display = "block";
        } catch (err) {
            console.error("Błąd nagrywania:", err);
            alert("Nie można było uzyskać dostępu do mikrofonu.");
        }
    } else {
        mediaRecorder.stop();
        stopPlayback();

        const recBtn = document.getElementById('recordBtn');
        recBtn.innerHTML = "🔴 Nagraj";
        recBtn.style.background = "#ff5e7e";
        recBtn.style.color = "#fff";
        document.getElementById('recordingStatus').style.display = "none";
    }
}

// Inicjalizacja słuchaczy zdarzeń
setupMixerListeners();
setupTimelineListeners();
setupTransportListeners();
setupModalListeners();

// Słuchacze parametrów kliku na stronie głównej
document.getElementById('bpmInput').addEventListener('input', handleClickParamChange);
document.getElementById('metrumSelect').addEventListener('change', handleClickParamChange);
document.getElementById('clickSoundSelect').addEventListener('change', handleClickParamChange);
document.getElementById('clickOffsetInput').addEventListener('input', handleClickParamChange);

// Słuchacze dla nagrywania
document.getElementById('recordBtn').addEventListener('click', handleRecordToggle);
document.getElementById('audioInputDevice').addEventListener('change', (e) => {
    selectedDeviceId = e.target.value;
});
