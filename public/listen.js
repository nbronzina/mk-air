// mk-air listen client
// handles webrtc receiving and visualizer

const socket = io();

// dom elements
const connectingView = document.getElementById('connecting-view');
const errorView = document.getElementById('error-view');
const listenView = document.getElementById('listen-view');
const endedView = document.getElementById('ended-view');
const remoteAudio = document.getElementById('remote-audio');
const roomDisplay = document.getElementById('room-display');
const listenerCountEl = document.getElementById('listener-count');
const leaveBtn = document.getElementById('leave-stream');
const unmuteNotice = document.getElementById('unmute-notice');
const audioStatus = document.getElementById('audio-status');
const streamDuration = document.getElementById('stream-duration');
const canvas = document.getElementById('visualizer');
const canvasCtx = canvas.getContext('2d');

// state
let roomId = null;
let peerConnection = null;
let audioContext = null;
let analyser = null;
let isAnimating = false;
let audioPlaying = false;
let streamStartTime = null;
let durationInterval = null;

// webrtc configuration
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// initialize
function init() {
  const path = window.location.pathname;
  const match = path.match(/\/listen\/(.+)/);

  if (!match) {
    showError();
    return;
  }

  roomId = match[1];
  roomDisplay.textContent = roomId;

  // join room
  socket.emit('join-room', roomId);
}

// room not found
socket.on('room-not-found', () => {
  showError();
});

// offer received from broadcaster
socket.on('offer', async (data) => {
  // Start stream duration counter
  streamStartTime = Date.now();
  startDurationCounter();

  // create peer connection
  peerConnection = new RTCPeerConnection(rtcConfig);

  // handle incoming stream
  peerConnection.ontrack = (event) => {
    const stream = event.streams[0];

    // Set audio element
    remoteAudio.srcObject = stream;
    remoteAudio.volume = 1.0;
    remoteAudio.muted = false;

    // Safari needs these attributes
    remoteAudio.setAttribute('webkit-playsinline', '');
    remoteAudio.setAttribute('playsinline', '');

    // Try to play immediately
    tryPlayAudio();

    // Setup visualizer with delay for mobile
    setTimeout(() => {
      setupVisualizer(stream);
    }, 200);

    // show listen view
    connectingView.classList.add('hidden');
    listenView.classList.remove('hidden');
  };
  
  // handle ice candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', {
        target: data.broadcaster,
        candidate: event.candidate
      });
    }
  };
  
  // set remote description and create answer
  try {
    await peerConnection.setRemoteDescription(data.offer);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    // send answer
    socket.emit('answer', {
      target: data.broadcaster,
      answer: answer
    });
  } catch (err) {
    console.error('[ERROR] WebRTC negotiation failed:', err);
  }
});

// Start duration counter
function startDurationCounter() {
  durationInterval = setInterval(() => {
    if (!streamStartTime) return;
    
    const elapsed = Date.now() - streamStartTime;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    
    streamDuration.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }, 1000);
}

// Try to play audio (Safari-compatible)
async function tryPlayAudio() {
  try {
    const playPromise = remoteAudio.play();

    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          audioPlaying = true;
          unmuteNotice.style.display = 'none';
          audioStatus.style.display = 'block';
        })
        .catch(() => {
          unmuteNotice.style.display = 'block';
          audioStatus.style.display = 'none';
          audioPlaying = false;
        });
    }
  } catch (err) {
    unmuteNotice.style.display = 'block';
    audioStatus.style.display = 'none';
    audioPlaying = false;
  }
}

// Unmute button click
unmuteNotice.addEventListener('click', async () => {
  try {
    remoteAudio.muted = false;
    remoteAudio.volume = 1.0;
    await remoteAudio.play();
    unmuteNotice.style.display = 'none';
    audioStatus.style.display = 'block';
    audioPlaying = true;
  } catch (err) {
    console.error('[ERROR] Manual play failed:', err);
    alert('Could not play audio. Please try again.');
  }
});

// ice candidate received
socket.on('ice-candidate', async (data) => {
  if (peerConnection && data.candidate) {
    try {
      await peerConnection.addIceCandidate(data.candidate);
    } catch (err) {
      console.error('[ERROR] ICE candidate failed:', err);
    }
  }
});

// update listener count
socket.on('listener-count', (count) => {
  listenerCountEl.textContent = count;
});

// stream ended
socket.on('stream-ended', () => {
  showEnded();
});

// setup visualizer
function setupVisualizer(stream) {
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;

    source.connect(analyser);

    // Wait for DOM to be ready, then setup canvas
    setTimeout(() => {
      resizeCanvas();
      isAnimating = true;
      drawVisualizer();
    }, 200);
  } catch (err) {
    console.error('[ERROR] Visualizer setup failed:', err);
  }
}

// Resize canvas for high DPI displays
function resizeCanvas() {
  const container = canvas.parentElement;
  const rect = container.getBoundingClientRect();

  const width = rect.width || container.offsetWidth || 800;
  const height = rect.height || container.offsetHeight || 300;
  const dpr = window.devicePixelRatio || 1;

  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  canvas.width = width * dpr;
  canvas.height = height * dpr;

  canvasCtx.scale(dpr, dpr);
}

// draw visualizer
function drawVisualizer() {
  if (!isAnimating || !analyser) return;
  
  requestAnimationFrame(drawVisualizer);
  
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  analyser.getByteTimeDomainData(dataArray);
  
  const bgColor = getComputedStyle(document.documentElement).getPropertyValue('--viz-bg').trim();
  const lineColor = getComputedStyle(document.documentElement).getPropertyValue('--viz-line').trim();
  
  // Get display dimensions
  const width = canvas.width / (window.devicePixelRatio || 1);
  const height = canvas.height / (window.devicePixelRatio || 1);
  
  canvasCtx.fillStyle = bgColor;
  canvasCtx.fillRect(0, 0, width, height);
  
  canvasCtx.lineWidth = 2;
  canvasCtx.strokeStyle = lineColor;
  canvasCtx.beginPath();
  
  const sliceWidth = width / bufferLength;
  let x = 0;
  
  for (let i = 0; i < bufferLength; i++) {
    const v = dataArray[i] / 128.0;
    const y = v * height / 2;
    
    if (i === 0) {
      canvasCtx.moveTo(x, y);
    } else {
      canvasCtx.lineTo(x, y);
    }
    
    x += sliceWidth;
  }
  
  canvasCtx.lineTo(width, height / 2);
  canvasCtx.stroke();
}

// leave stream
leaveBtn.addEventListener('click', () => {
  cleanup();
  window.location.href = '/';
});

// cleanup
function cleanup() {
  if (peerConnection) peerConnection.close();
  if (audioContext) audioContext.close();
  if (durationInterval) clearInterval(durationInterval);

  isAnimating = false;
  socket.disconnect();
}

// show error view
function showError() {
  connectingView.classList.add('hidden');
  errorView.classList.remove('hidden');
}

// show ended view
function showEnded() {
  cleanup();
  listenView.classList.add('hidden');
  endedView.classList.remove('hidden');
}

// Handle window resize
window.addEventListener('resize', () => {
  if (canvas && isAnimating) resizeCanvas();
});

// Orientation change (mobile)
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    if (canvas && isAnimating) resizeCanvas();
  }, 300);
});

// Initial resize after load
window.addEventListener('load', () => {
  if (canvas) {
    setTimeout(() => resizeCanvas(), 500);
  }
});

// Safari: Resume AudioContext on user interaction
document.addEventListener('click', () => {
  if (audioContext && audioContext.state === 'suspended') {
    audioContext.resume();
  }
}, { once: true });

// Safari: Extra attempt to play on touch
let safariAttempts = 0;
document.addEventListener('touchstart', async () => {
  if (!audioPlaying && remoteAudio.srcObject && safariAttempts < 3) {
    safariAttempts++;
    try {
      remoteAudio.muted = false;
      await remoteAudio.play();
      unmuteNotice.style.display = 'none';
      audioStatus.style.display = 'block';
      audioPlaying = true;
    } catch (err) {
      // Silent fail
    }
  }
}, { passive: true });

// start
init();
