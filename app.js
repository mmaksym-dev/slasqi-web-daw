let audioCtx;
let trackBuffers = [null, null, null, null]; // 0-2: backing tracks, 3: recorded instrument
let recordedChunks = [];
let mediaRecorder;
let instrumentBlob = null;
let detectedTransients = [];
let targetBpm = 120;
let computedLatency = 0;

// Playback & Transport State
let isPlaying = false;
let isRecording = false;
let playheadPosition = 0; // in seconds
let startTime = 0; // audioCtx.currentTime when playback started
let activeSources = []; // currently playing sources: { source: AudioBufferSourceNode, gainNode: GainNode, index: number/string }
let playheadAnimFrame = null;
let totalDuration = 0;

// Track Mixing States (1.0 = 100% volume)
let trackVolume = [1.0, 1.0, 1.0, 1.0];
let trackMute = [false, false, false, false];
let trackSolo = [false, false, false, false];

document.getElementById('initAudio').addEventListener('click', async () => {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    document.getElementById('startRec').disabled = false;
    document.getElementById('scanDevices').click();
    alert("Silnik Web Audio gotowy.");
});

document.getElementById('scanDevices').addEventListener('click', async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const select = document.getElementById('deviceSelect');
    const audioInputs = devices.filter(d => d.kind === 'audioinput');
    if(audioInputs.length > 0) {
        select.innerHTML = '';
        audioInputs.forEach(dev => {
            let option = document.createElement('option');
            option.value = dev.deviceId;
            option.text = dev.label || `Wejście Audio (${dev.deviceId.slice(0,5)})`;
            select.appendChild(option);
        });
    }
});

// Import śladów podkładu
document.querySelectorAll('.track-input').forEach(input => {
    input.addEventListener('change', async (e) => {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            document.getElementById('startRec').disabled = false;
            document.getElementById('scanDevices').click();
        }
        const idx = parseInt(e.target.dataset.index);
        const file = e.target.files[0];
        if (!file) return;
        const arrBuffer = await file.arrayBuffer();
        trackBuffers[idx] = await audioCtx.decodeAudioData(arrBuffer);
        
        document.getElementById('analyzeBtn').disabled = false;
        
        updateDuration();
        drawAllWaveforms();
        
        alert(`Ślad ${idx + 1} załadowany.`);
    });
});

// Analiza rytmu i kliku
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
        for(let i=1; i<detectedTransients.length; i++) {
            intervals.push(detectedTransients[i] - detectedTransients[i-1]);
        }
        let avgInterval = intervals.reduce((a,b) => a+b, 0) / intervals.length;
        targetBpm = Math.round(60 / avgInterval);
        while (targetBpm < 60) targetBpm *= 2;
        while (targetBpm > 180) targetBpm /= 2;
    }

    document.getElementById('detectedBpm').innerText = Math.round(targetBpm) + " BPM";
    const timeline = document.getElementById('clickTimeline');
    timeline.innerHTML = '';
    const duration = referenceBuffer.duration;
    detectedTransients.forEach(t => {
        let marker = document.createElement('div');
        marker.className = 'transient-marker';
        marker.style.left = ((t / duration) * 100) + '%';
        timeline.appendChild(marker);
    });
    document.getElementById('renderBtn').disabled = false;
    alert("Analiza rytmu zakończona.");
});

// Kalibracja opóźnienia
document.getElementById('autoLatencyBtn').addEventListener('click', async () => {
    if (!audioCtx) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
    const source = audioCtx.createMediaStreamSource(stream);
    const analyzer = audioCtx.createAnalyser();
    source.connect(analyzer);

    let osc = audioCtx.createOscillator();
    let gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    const startTimeOsc = audioCtx.currentTime;
    osc.frequency.setValueAtTime(1000, startTimeOsc);
    gain.gain.setValueAtTime(1, startTimeOsc);
    gain.gain.exponentialRampToValueAtTime(0.001, startTimeOsc + 0.02);
    osc.start(startTimeOsc); osc.stop(startTimeOsc + 0.03);

    const dataArray = new Uint8Array(analyzer.frequencyBinCount);
    let checkInterval = setInterval(() => {
        analyzer.getByteTimeDomainData(dataArray);
        for (let i = 0; i < dataArray.length; i++) {
            if (dataArray[i] > 140 || dataArray[i] < 110) {
                clearInterval(checkInterval);
                computedLatency = Math.round((audioCtx.currentTime - startTimeOsc) * 1000) - 20;
                if(computedLatency < 0) computedLatency = 0;
                document.getElementById('latencyMs').value = computedLatency;
                stream.getTracks().forEach(t => t.stop());
                alert(`Zmierzona latencja: ${computedLatency} ms`);
                return;
            }
        }
    }, 1);
    setTimeout(() => clearInterval(checkInterval), 1000);
});

// Odtwarzanie kliku
function playCustomClick(time, ctx, destination, type) {
    let osc = ctx.createOscillator();
    let gain = ctx.createGain();
    osc.connect(gain); gain.connect(destination);
    if (type === "synth") {
        osc.frequency.setValueAtTime(1000, time);
        gain.gain.setValueAtTime(0.7, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
    } else if (type === "rim") {
        osc.type = "triangle"; osc.frequency.setValueAtTime(1500, time);
        gain.gain.setValueAtTime(0.8, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.02);
    } else if (type === "cowbell") {
        osc.type = "square"; osc.frequency.setValueAtTime(850, time);
        gain.gain.setValueAtTime(0.6, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.06);
    }
    osc.start(time); osc.stop(time + 0.08);
}

// === SYSTEM TRANSPORTU I OŚ CZASU ===

function updateDuration() {
    totalDuration = Math.max(...trackBuffers.filter(b => b !== null).map(b => b.duration), 0);
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
        const row = document.getElementById(`track-row-${idx}`);
        
        if (idx === 3) {
            if (buffer) {
                row.style.display = 'grid';
            } else {
                row.style.display = 'none';
                return;
            }
        }
        
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
        document.getElementById('startRec').disabled = false;
        document.getElementById('scanDevices').click();
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
    
    startTime = audioCtx.currentTime;
    const isAnySolo = trackSolo.some(s => s === true);
    
    activeSources = [];
    
    trackBuffers.forEach((buffer, idx) => {
        if (buffer) {
            let offset = playheadPosition;
            if (idx === 3) {
                // Skompensowanie latencji dla nagranego instrumentu
                const latencySec = parseFloat(document.getElementById('latencyMs').value) / 1000;
                offset = playheadPosition + latencySec;
            }
            
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
        } catch (e) {}
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
    if (isRecording) return;
    
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
            if (isRecording) return;
            
            const rect = container.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const percent = clickX / rect.width;
            seekTo(percent * totalDuration);
        });
    });
}

function setupTransportListeners() {
    document.getElementById('playBtn').addEventListener('click', togglePlayPause);
    document.getElementById('stopBtn').addEventListener('click', () => {
        if (isRecording) {
            document.getElementById('stopRec').click();
        } else {
            stopPlayback();
        }
    });
    document.getElementById('rewindBtn').addEventListener('click', rewindPlayback);
}

// === INTEGRACJA REJESTRACJI AUDIO ===

document.getElementById('startRec').addEventListener('click', async () => {
    recordedChunks = [];
    const deviceId = document.getElementById('deviceSelect').value;
    const clickType = document.getElementById('clickSound').value;
    const constraints = { audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, sampleRate: 44100 } };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
    
    mediaRecorder.onstop = async () => {
        instrumentBlob = new Blob(recordedChunks, { type: 'audio/wav' });
        
        // Zdekoduj nagranie do odtwarzacza w czasie rzeczywistym
        if (audioCtx) {
            const arrBuffer = await instrumentBlob.arrayBuffer();
            try {
                trackBuffers[3] = await audioCtx.decodeAudioData(arrBuffer);
                updateDuration();
                drawAllWaveforms();
            } catch (err) {
                console.error("Error decoding recorded audio:", err);
            }
        }
        
        document.getElementById('renderBtn').disabled = false;
    };

    // Zawsze zaczynamy nagrywanie od zera (dla pełnej synchronizacji renderu offline)
    stopPlaybackSources();
    playheadPosition = 0;
    isRecording = true;
    isPlaying = true;
    updateTransportUI();

    // Uruchomienie klika
    detectedTransients.forEach(t => {
        playCustomClick(audioCtx.currentTime + t, audioCtx, audioCtx.destination, clickType);
    });

    // Odtwarzanie śladów w czasie rzeczywistym z uwzględnieniem mute/solo i głośności
    startTime = audioCtx.currentTime;
    const isAnySolo = trackSolo.some(s => s === true);
    
    activeSources = [];
    trackBuffers.forEach((buffer, idx) => {
        if (idx < 3 && buffer) {
            let src = audioCtx.createBufferSource();
            src.buffer = buffer;
            
            let gainNode = audioCtx.createGain();
            let vol = trackVolume[idx];
            if (trackMute[idx]) vol = 0;
            if (isAnySolo && !trackSolo[idx]) vol = 0;
            
            gainNode.gain.setValueAtTime(vol, audioCtx.currentTime);
            
            src.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            
            src.start(0, 0);
            
            activeSources.push({
                source: src,
                gainNode: gainNode,
                index: idx
            });
        }
    });

    mediaRecorder.start();
    document.getElementById('startRec').disabled = true;
    document.getElementById('stopRec').disabled = false;
    document.getElementById('recStatus').innerText = "🔴 RECORDING";
    
    if (playheadAnimFrame) cancelAnimationFrame(playheadAnimFrame);
    playheadAnimFrame = requestAnimationFrame(animatePlayhead);
});

document.getElementById('stopRec').addEventListener('click', () => {
    mediaRecorder.stop();
    document.getElementById('startRec').disabled = false;
    document.getElementById('stopRec').disabled = true;
    document.getElementById('recStatus').innerText = "";
    
    stopPlaybackSources();
    isRecording = false;
    isPlaying = false;
    updateTransportUI();
});

// === EKSPORT & offline RENDER ===

document.getElementById('renderBtn').addEventListener('click', async () => {
    if (!instrumentBlob) return;
    const instrArrBuf = await instrumentBlob.arrayBuffer();
    const instrumentBuffer = await audioCtx.decodeAudioData(instrArrBuf);
    
    // Oblicz maksymalny czas trwania ze wszystkich śladów
    const maxDuration = Math.max(...trackBuffers.filter(b => b !== null).map(b => b.duration), 0);
    const sampleRate = audioCtx.sampleRate;
    const latencySeconds = parseFloat(document.getElementById('latencyMs').value) / 1000;

    const renderCtx = new OfflineAudioContext(2, sampleRate * maxDuration, sampleRate);
    const isAnySolo = trackSolo.some(s => s === true);

    // Render śladów tła
    trackBuffers.forEach((buffer, idx) => {
        if (idx < 3 && buffer) {
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

    // Render nagranego instrumentu z kompensacją latencji
    let instrSource = renderCtx.createBufferSource();
    instrSource.buffer = instrumentBuffer;
    
    let instrGainNode = renderCtx.createGain();
    let instrVol = trackVolume[3];
    if (trackMute[3]) instrVol = 0;
    if (isAnySolo && !trackSolo[3]) instrVol = 0;
    
    instrGainNode.gain.setValueAtTime(instrVol, 0);
    instrSource.connect(instrGainNode);
    instrGainNode.connect(renderCtx.destination);
    
    // Rozpocznij odtwarzanie nagrania z kompensacją opóźnienia
    instrSource.start(0, latencySeconds);

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
    }return new Blob([bufferArr], { type: 'audio/wav' });
}

// Inicjalizacja słuchaczy zdarzeń
setupMixerListeners();
setupTimelineListeners();
setupTransportListeners();
