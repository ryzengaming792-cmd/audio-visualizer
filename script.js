const bgCanvas = document.getElementById('bgCanvas');
const bgCtx = bgCanvas.getContext('2d');
const visCanvas = document.getElementById('visualizerCanvas');
const visCtx = visCanvas.getContext('2d');

let paths = []; // Stores the generated PCB trace paths
let pulses = []; // Stores active lightning pulses

// Resize canvases and regenerate background
function resizeCanvases() {
    bgCanvas.width = window.innerWidth;
    bgCanvas.height = window.innerHeight;
    visCanvas.width = window.innerWidth;
    visCanvas.height = window.innerHeight;
    generatePCB();
    drawBackground(0); // Initial dark state
}
window.addEventListener('resize', resizeCanvases);

// --- PCB Generation Logic ---
function generatePCB() {
    paths = [];
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const numPaths = 60; // Total number of traces radiating out
    
    // Avoid drawing traces directly under the logo (leave a center hole)
    const minRadius = 150; 
    
    for (let i = 0; i < numPaths; i++) {
        const path = [];
        // Determine starting angle and position
        const angle = (Math.PI * 2 / numPaths) * i + (Math.random() * 0.1);
        let x = centerX + Math.cos(angle) * minRadius;
        let y = centerY + Math.sin(angle) * minRadius;
        
        path.push({x, y});
        
        // Generate segments for the trace
        let currentLength = 0;
        let dirAngle = angle;
        
        // A trace has 3 to 6 segments
        const numSegments = Math.floor(Math.random() * 4) + 3;
        
        for (let s = 0; s < numSegments; s++) {
            // Segments usually travel at 0, 45, or 90 degrees relative to grid
            // Snap direction to nearest 45 degrees
            let snappedAngle = Math.round(dirAngle / (Math.PI/4)) * (Math.PI/4);
            
            // Randomly branch off by 45 degrees occasionally
            if (Math.random() > 0.5) {
                snappedAngle += (Math.random() > 0.5 ? 1 : -1) * (Math.PI/4);
            }
            
            const segLength = 50 + Math.random() * 150;
            x += Math.cos(snappedAngle) * segLength;
            y += Math.sin(snappedAngle) * segLength;
            
            path.push({x, y});
            dirAngle = snappedAngle; // continue mostly in the same direction
            
            // If we go way off screen, stop
            if (x < -100 || x > window.innerWidth+100 || y < -100 || y > window.innerHeight+100) {
                break;
            }
        }
        
        // Calculate total length of path for animation purposes
        let totalLen = 0;
        for (let p = 1; p < path.length; p++) {
            const dx = path[p].x - path[p-1].x;
            const dy = path[p].y - path[p-1].y;
            totalLen += Math.sqrt(dx*dx + dy*dy);
        }
        
        paths.push({ points: path, length: totalLen });
    }
}

function drawBackground(intensity) {
    bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
    
    // Intensity is non-linear now for snappier glowing
    const glowIntensity = Math.pow(intensity, 1.5);
    
    // Lines dim during quiet parts, bright during drops
    const lineOpacity = 0.05 + (glowIntensity * 0.85); 
    
    bgCtx.lineWidth = 2;
    bgCtx.lineCap = 'round';
    bgCtx.lineJoin = 'round';
    
    paths.forEach(pathObj => {
        const pts = pathObj.points;
        bgCtx.beginPath();
        bgCtx.moveTo(pts[0].x, pts[0].y);
        for(let i=1; i<pts.length; i++) {
            bgCtx.lineTo(pts[i].x, pts[i].y);
        }
        
        bgCtx.strokeStyle = `rgba(255, 59, 48, ${lineOpacity})`; 
        
        // Massive glow when lines flash together
        if (glowIntensity > 0.2) {
            bgCtx.shadowBlur = glowIntensity * 35; // Huge glow radius
            bgCtx.shadowColor = '#FF3B30';
        } else {
            bgCtx.shadowBlur = 0;
        }
        bgCtx.stroke();
        
        // Vias/Pads at the end of traces
        const last = pts[pts.length-1];
        bgCtx.fillStyle = `rgba(255, 149, 0, ${0.1 + glowIntensity * 0.9})`;
        bgCtx.shadowBlur = glowIntensity > 0.2 ? 15 : 0;
        bgCtx.shadowColor = '#FF9500';
        bgCtx.fillRect(last.x - 2, last.y - 2, 4, 4);
    });
    
    // Reset shadow for next frame
    bgCtx.shadowBlur = 0;
}

// Helper to get point at distance D along a path
function getPointAlongPath(pts, dist) {
    let currentDist = 0;
    for (let i = 1; i < pts.length; i++) {
        const p1 = pts[i-1];
        const p2 = pts[i];
        const segLen = Math.sqrt(Math.pow(p2.x-p1.x, 2) + Math.pow(p2.y-p1.y, 2));
        
        if (currentDist + segLen >= dist) {
            const ratio = (dist - currentDist) / segLen;
            return {
                x: p1.x + (p2.x - p1.x) * ratio,
                y: p1.y + (p2.y - p1.y) * ratio
            };
        }
        currentDist += segLen;
    }
    return pts[pts.length-1];
}


// --- Audio Logic ---
let audioCtx;
let analyser;
let source;
let dataArray;
let isAudioSetup = false;
let isPlaying = false;

const audio = new Audio();
audio.crossOrigin = "anonymous";

const btnPlayPause = document.getElementById('btnPlayPause');
const iconPlay = document.getElementById('iconPlay');
const iconPause = document.getElementById('iconPause');
const audioUpload = document.getElementById('audioUpload');
const progressBarFill = document.getElementById('progressBarFill');
const timeCurrent = document.getElementById('timeCurrent');
const timeTotal = document.getElementById('timeTotal');

function setupAudio() {
    if (isAudioSetup) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048; // High resolution for frequency isolation
    analyser.smoothingTimeConstant = 0.4; // Lowered to capture sharp, punchy transients perfectly
    dataArray = new Uint8Array(analyser.frequencyBinCount);
    isAudioSetup = true;
}

let fileSourceNode = null;

audioUpload.addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file) {
        if (!isAudioSetup) setupAudio();
        
        // Disconnect current source from analyser
        if (source) source.disconnect();
        
        // The Web Audio API only allows creating one MediaElementSource per audio element.
        if (!fileSourceNode) {
            fileSourceNode = audioCtx.createMediaElementSource(audio);
        }
        
        source = fileSourceNode;
        source.connect(analyser);
        analyser.connect(audioCtx.destination); // Play local files through speakers
        
        audio.src = URL.createObjectURL(file);
        document.getElementById('trackTitle').textContent = file.name.replace(/\.[^/.]+$/, "");
        document.getElementById('trackArtist').textContent = "Local File";
        playAudio();
    }
});

document.getElementById('btnSystemAudio').addEventListener('click', async () => {
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: true, // Video must be true for most browsers to allow screen share
            audio: true
        });
        
        if (!isAudioSetup) setupAudio();
        
        // Disconnect old source
        if (source) source.disconnect();
        
        source = audioCtx.createMediaStreamSource(stream);
        source.connect(analyser);
        // CRITICAL: We do NOT connect analyser to destination here, otherwise we get a massive feedback loop!
        
        document.getElementById('trackTitle').textContent = "Live System Audio";
        document.getElementById('trackArtist').textContent = "Streaming";
        
        // We don't use the audio element for this, so we mock playing
        isPlaying = true;
        if (audioCtx.state === 'suspended') audioCtx.resume();
        iconPlay.style.display = 'none';
        iconPause.style.display = 'block';
        renderFrame();
        
        // Stop stream when user stops sharing
        stream.getVideoTracks()[0].onended = () => {
            isPlaying = false;
            iconPlay.style.display = 'block';
            iconPause.style.display = 'none';
            document.getElementById('trackTitle').textContent = "Stream Ended";
        };
        
    } catch (err) {
        console.error("Error capturing audio: ", err);
        alert("Could not capture audio. Please make sure you selected a tab or screen AND checked the 'Share Audio' box!");
    }
});

btnPlayPause.addEventListener('click', () => {
    if (!audio.src) return;
    if (!isAudioSetup) setupAudio();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    isPlaying ? pauseAudio() : playAudio();
});

const btnRepeat = document.getElementById('btnRepeat');
btnRepeat.addEventListener('click', () => {
    audio.loop = !audio.loop;
    if (audio.loop) {
        btnRepeat.classList.add('active');
    } else {
        btnRepeat.classList.remove('active');
    }
});

function playAudio() {
    audio.play();
    isPlaying = true;
    iconPlay.style.display = 'none';
    iconPause.style.display = 'block';
    renderFrame();
}

function pauseAudio() {
    audio.pause();
    isPlaying = false;
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
}

audio.addEventListener('timeupdate', () => {
    if (!isNaN(audio.duration)) {
        progressBarFill.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
        timeCurrent.textContent = formatTime(audio.currentTime);
        timeTotal.textContent = formatTime(audio.duration);
    }
});

function formatTime(s) {
    const min = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${min}:${sec < 10 ? '0' : ''}${sec}`;
}


const volumeSlider = document.getElementById('volumeSlider');
if (volumeSlider) {
    volumeSlider.addEventListener('input', (e) => {
        audio.volume = e.target.value;
    });
}

// --- Advanced Audio Analysis & Render Loop ---
let lastBeatTime = 0;
let bigBeatThreshold = 80;
let smallBeatThreshold = 70;
let smoothedIntensity = 0; // For smooth background breathing

// Automatic Gain Control (AGC) trackers
let maxBass = 20;
let maxMids = 20;

function renderFrame() {
    if (!isPlaying) return;
    requestAnimationFrame(renderFrame);
    analyser.getByteFrequencyData(dataArray);
    visCtx.clearRect(0, 0, visCanvas.width, visCanvas.height);
    
    // 1. Precise Frequency Isolation
    let rawBass = 0;
    for(let i=1; i<=6; i++) rawBass += dataArray[i];
    rawBass /= 6;
    
    let rawMids = 0;
    for(let i=20; i<=60; i++) rawMids += dataArray[i];
    rawMids /= 40;
    
    let rawOverallEnergy = 0;
    for(let i=1; i<=150; i++) rawOverallEnergy += dataArray[i];
    rawOverallEnergy /= 150;
    
    // 2. Automatic Gain Control (Volume Independence)
    // Track the maximum volume and decay it slowly. This maps quiet songs and loud songs to the exact same 0-100 scale.
    if (rawBass > maxBass) maxBass = rawBass;
    else maxBass -= 0.2; 
    if (maxBass < 10) maxBass = 10; 
    
    if (rawMids > maxMids) maxMids = rawMids;
    else maxMids -= 0.2;
    if (maxMids < 10) maxMids = 10;
    
    // Normalize to 0-100 scale
    let bass = (rawBass / maxBass) * 100;
    let mids = (rawMids / maxMids) * 100;
    let overallEnergy = (rawOverallEnergy / Math.max(maxBass, maxMids)) * 100;
    
    // 3. Dynamic Circuit Lighting 
    // Smooth the intensity so the background "breathes" naturally
    let targetIntensity = Math.min(1, overallEnergy / 70);
    smoothedIntensity += (targetIntensity - smoothedIntensity) * 0.1;
    drawBackground(smoothedIntensity);
    
    // 4. Decaying Peak Threshold Beat Detection
    let isBigBeat = false;
    let isSmallBeat = false;
    
    // Big Beat (Heavy Bass - Kicks/Drops)
    // Normalized bass peaks precisely at 100
    if (bass > bigBeatThreshold && bass > 80) {
        isBigBeat = true;
        bigBeatThreshold = bass * 1.25; // Spike threshold up to ~125
    } else {
        bigBeatThreshold -= (bigBeatThreshold - 80) * 0.05; // Smoothly decay back down to 80
    }
    
    // Small Beat (Snares/Hats)
    if (mids > smallBeatThreshold && mids > 65) {
        isSmallBeat = true;
        smallBeatThreshold = mids * 1.2;
    } else {
        smallBeatThreshold -= (smallBeatThreshold - 65) * 0.1; 
    }
    
    const now = Date.now();
    
    if (isBigBeat && now - lastBeatTime > 150) {
        // HUGE DROP: Lightning pulses on EVERY SINGLE LINE simultaneously!
        for(let i=0; i<paths.length; i++) {
            pulses.push({
                pathIndex: i, // 1 pulse per path!
                distance: 0,
                speed: 15 + (smoothedIntensity * 20),
                length: 100 + (smoothedIntensity * 100),
                color: '#FF3B30' // Bright Red
            });
        }
        lastBeatTime = now;
        document.querySelector('.center-logo').style.filter = `drop-shadow(0 0 50px rgba(255, 59, 48, 1))`;
        
    } else if (isSmallBeat && now - lastBeatTime > 30) {
        // SMALL BEAT: Constantly firing warm orange/yellow pulses on every little sound
        const numPulses = Math.floor(Math.random() * 3) + 1; // 1 to 3 random lines
        for(let i=0; i<numPulses; i++) {
            const randomPathIndex = Math.floor(Math.random() * paths.length);
            pulses.push({
                pathIndex: randomPathIndex,
                distance: 0,
                speed: 8 + (smoothedIntensity * 5),
                length: 20 + (smoothedIntensity * 30),
                color: '#FF9500' // Warm Orange / Yellow
            });
        }
        lastBeatTime = now;
        document.querySelector('.center-logo').style.filter = `drop-shadow(0 0 20px rgba(255, 149, 0, 0.8))`;
    } else {
        // RESTING
        document.querySelector('.center-logo').style.filter = `drop-shadow(0 0 ${10 + (smoothedIntensity*10)}px rgba(255, 149, 0, 0.5))`;
    }
    
    // 4. Draw traveling lightning
    for (let i = pulses.length - 1; i >= 0; i--) {
        const pulse = pulses[i];
        pulse.distance += pulse.speed;
        
        const pObj = paths[pulse.pathIndex];
        
        if (pulse.distance - pulse.length > pObj.length) {
            pulses.splice(i, 1);
            continue;
        }
        
        visCtx.beginPath();
        visCtx.lineCap = 'round';
        visCtx.lineJoin = 'round';
        visCtx.lineWidth = 4;
        visCtx.strokeStyle = pulse.color;
        visCtx.shadowBlur = 20;
        visCtx.shadowColor = pulse.color;
        
        const trailEndDist = Math.max(0, pulse.distance - pulse.length);
        const trailStartDist = Math.min(pObj.length, pulse.distance);
        
        const step = 5;
        let started = false;
        for (let d = trailEndDist; d <= trailStartDist; d += step) {
            const pt = getPointAlongPath(pObj.points, d);
            if (!started) {
                visCtx.moveTo(pt.x, pt.y);
                started = true;
            } else {
                visCtx.lineTo(pt.x, pt.y);
            }
        }
        const tip = getPointAlongPath(pObj.points, trailStartDist);
        if (started) visCtx.lineTo(tip.x, tip.y);
        
        visCtx.stroke();
    }
}

// --- UI Auto-Fade Logic ---
const uiOverlay = document.getElementById('uiOverlay');
let fadeTimeout;

function resetFade() {
    uiOverlay.classList.remove('idle');
    clearTimeout(fadeTimeout);
    fadeTimeout = setTimeout(() => {
        uiOverlay.classList.add('idle');
    }, 3000); // fade out after 3 seconds of inactivity
}

document.addEventListener('mousemove', resetFade);
document.addEventListener('click', resetFade);
document.addEventListener('keydown', resetFade);
resetFade(); // start the timer initially

// Initialize background
resizeCanvases();
