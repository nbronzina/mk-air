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
const canvas = document.getElementById('visualizer');
const canvasCtx = canvas.getContext('2d');

// state
let roomId = null;
let peerConnection = null;
let audioContext = null;
let analyser = null;
let isAnimating = false;

// webrtc configuration
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// initialize
function init() {
  console.log('[DEBUG] ========== LISTENER INITIALIZING ==========');
  console.log('[DEBUG] Current URL:', window.location.href);
  console.log('[DEBUG] Pathname:', window.location.pathname);
  
  // get room id from url
  const path = window.location.pathname;
  const match = path.match(/\/listen\/(.+)/);
  
  console.log('[DEBUG] Path match result:', match);
  
  if (!match) {
    console.error('[DEBUG] No room ID found in URL');
    showError();
    return;
  }
  
  roomId = match[1];
  console.log('[DEBUG] ========================================');
  console.log('[DEBUG] Extracted roomId:', roomId);
  console.log('[DEBUG] roomId length:', roomId.length);
  console.log('[DEBUG] roomId type:', typeof roomId);
  console.log('[DEBUG] ========================================');
  
  roomDisplay.textContent = roomId;
  
  // join room
  console.log('[DEBUG] Emitting join-room event with roomId:', roomId);
  socket.emit('join-room', roomId);
  console.log('[DEBUG] join-room event emitted');
}

// room not found
socket.on('room-not-found', () => {
  console.error('[DEBUG] Room not found - server responded with room-not-found');
  showError();
});

// offer received from broadcaster
socket.on('offer', async (data) => {
  console.log('[DEBUG] ========================================');
  console.log('[DEBUG] OFFER RECEIVED from broadcaster');
  console.log('[DEBUG] Broadcaster ID:', data.broadcaster);
  console.log('[DEBUG] ========================================');
  
  // create peer connection
  peerConnection = new RTCPeerConnection(rtcConfig);
  console.log('[DEBUG] RTCPeerConnection created');
  
  // handle incoming stream
  peerConnection.ontrack = (event) => {
    console.log('[DEBUG] ========================================');
    console.log('[DEBUG] REMOTE STREAM RECEIVED');
    console.log('[DEBUG] Stream:', event.streams[0]);
    console.log('[DEBUG] Audio tracks:', event.streams[0].getAudioTracks().length);
    console.log('[DEBUG] Audio tracks details:', event.streams[0].getAudioTracks());
    console.log('[DEBUG] ========================================');
    
    const stream = event.streams[0];
    
    // Set audio element
    remoteAudio.srcObject = stream;
    remoteAudio.volume = 1.0;
    
    // Try to play immediately
    remoteAudio.play()
      .then(() => {
        console.log('[DEBUG] Audio autoplay successful');
      })
      .catch(err => {
        console.log('[DEBUG] Audio autoplay blocked:', err.message);
        console.log('[DEBUG] User interaction required to play audio');
      });
    
    // setup visualizer
    setupVisualizer(stream);
    
    // show listen view
    connectingView.classList.add('hidden');
    listenView.classList.remove('hidden');
    
    console.log('[DEBUG] Switched to listen view');
  };
  
  // handle ice candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      console.log('[DEBUG] Sending ICE candidate to broadcaster');
      socket.emit('ice-candidate', {
        target: data.broadcaster,
        candidate: event.candidate
      });
    }
  };
  
  // connection state changes
  peerConnection.onconnectionstatechange = () => {
    console.log('[DEBUG] Connection state:', peerConnection.connectionState);
  };
  
  peerConnection.oniceconnectionstatechange = () => {
    console.log('[DEBUG] ICE connection state:', peerConnection.iceConnectionState);
  };
  
  // set remote description and create answer
  try {
    await peerConnection.setRemoteDescription(data.offer);
    console.log('[DEBUG] Remote description set');
    
    const answer = await peerConnection.createAnswer();
    console.log('[DEBUG] Answer created');
    
    await peerConnection.setLocalDescription(answer);
    console.log('[DEBUG] Local description set');
    
    // send answer
    socket.emit('answer', {
      target: data.broadcaster,
      answer: answer
    });
    console.log('[DEBUG] Answer sent to broadcaster');
  } catch (err) {
    console.error('[DEBUG] Error in WebRTC negotiation:', err);
  }
});

// ice candidate received
socket.on('ice-candidate', async (data) => {
  console.log('[DEBUG] ICE candidate received from:', data.from);
  if (peerConnection && data.candidate) {
    try {
      await peerConnection.addIceCandidate(data.candidate);
      console.log('[DEBUG] ICE candidate added successfully');
    } catch (err) {
      console.error('[DEBUG] Error adding ICE candidate:', err);
    }
  }
});

// update listener count
socket.on('listener-count', (count) => {
  console.log('[DEBUG] Listener count updated:', count);
  listenerCountEl.textContent = count;
});

// stream ended
socket.on('stream-ended', () => {
  console.log('[DEBUG] Stream ended by broadcaster');
  showEnded();
});

// setup visualizer
function setupVisualizer(stream) {
  console.log('[DEBUG] ========================================');
  console.log('[DEBUG] Setting up visualizer');
  console.log('[DEBUG] Stream tracks:', stream.getTracks());
  console.log('[DEBUG] Audio tracks:', stream.getAudioTracks());
  
  try {
    // Create audio context
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    console.log('[DEBUG] AudioContext created');
    
    // Create source from stream
    const source = audioContext.createMediaStreamSource(stream);
    console.log('[DEBUG] MediaStreamSource created');
    
    // Create analyser
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;
    console.log('[DEBUG] Analyser created');
    
    // Connect source to analyser
    source.connect(analyser);
    console.log('[DEBUG] Source connected to analyser');
    
    // Setup canvas
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    console.log('[DEBUG] Canvas size:', canvas.width, 'x', canvas.height);
    
    // Start animation
    isAnimating = true;
    drawVisualizer();
    console.log('[DEBUG] Visualizer started successfully');
    console.log('[DEBUG] ========================================');
  } catch (err) {
    console.error('[DEBUG] Error setting up visualizer:', err);
  }
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
  
  canvasCtx.fillStyle = bgColor;
  canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
  
  canvasCtx.lineWidth = 2;
  canvasCtx.strokeStyle = lineColor;
  canvasCtx.beginPath();
  
  const sliceWidth = canvas.width / bufferLength;
  let x = 0;
  
  for (let i = 0; i < bufferLength; i++) {
    const v = dataArray[i] / 128.0;
    const y = v * canvas.height / 2;
    
    if (i === 0) {
      canvasCtx.moveTo(x, y);
    } else {
      canvasCtx.lineTo(x, y);
    }
    
    x += sliceWidth;
  }
  
  canvasCtx.lineTo(canvas.width, canvas.height / 2);
  canvasCtx.stroke();
}

// leave stream
leaveBtn.addEventListener('click', () => {
  console.log('[DEBUG] Leave stream clicked');
  cleanup();
  window.location.href = '/';
});

// cleanup
function cleanup() {
  console.log('[DEBUG] Cleaning up listener...');
  
  if (peerConnection) {
    peerConnection.close();
  }
  
  if (audioContext) {
    audioContext.close();
  }
  
  isAnimating = false;
  socket.disconnect();
  
  console.log('[DEBUG] Cleanup complete');
}

// show error view
function showError() {
  console.log('[DEBUG] Showing error view');
  connectingView.classList.add('hidden');
  errorView.classList.remove('hidden');
}

// show ended view
function showEnded() {
  console.log('[DEBUG] Showing ended view');
  cleanup();
  listenView.classList.add('hidden');
  endedView.classList.remove('hidden');
}

// socket connection events
socket.on('connect', () => {
  console.log('[DEBUG] ========================================');
  console.log('[DEBUG] Socket CONNECTED');
  console.log('[DEBUG] Socket ID:', socket.id);
  console.log('[DEBUG] ========================================');
});

socket.on('disconnect', () => {
  console.log('[DEBUG] Socket disconnected');
});

socket.on('connect_error', (error) => {
  console.error('[DEBUG] Socket connection error:', error);
});

// Handle window resize
window.addEventListener('resize', () => {
  if (canvas && isAnimating) {
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
  }
});

// start
console.log('[DEBUG] listen.js loaded, calling init()');
init();
