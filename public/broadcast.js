// mk-air broadcast client
// handles webrtc broadcasting and visualizer

const socket = io();

// dom elements
const setupView = document.getElementById('setup-view');
const broadcastView = document.getElementById('broadcast-view');
const startBtn = document.getElementById('start-broadcast');
const stopBtn = document.getElementById('stop-broadcast');
const copyLinkBtn = document.getElementById('copy-link');
const streamLinkInput = document.getElementById('stream-link');
const listenerCountEl = document.getElementById('listener-count');
const canvas = document.getElementById('visualizer');
const canvasCtx = canvas.getContext('2d');

// state
let localStream = null;
let audioContext = null;
let analyser = null;
let roomId = null;
let peers = new Map(); // listener_id -> RTCPeerConnection
let isAnimating = false;

// webrtc configuration
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// initialize
async function init() {
  try {
    // request microphone access
    localStream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      } 
    });
    
    // setup audio context for visualization
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(localStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    
    console.log('microphone access granted');
    startBtn.disabled = false;
    
  } catch (err) {
    console.error('microphone access denied:', err);
    alert('mk-air needs microphone access to broadcast');
  }
}

// start broadcast
startBtn.addEventListener('click', async () => {
  // generate room id
  roomId = generateRoomId();
  
  // create room on server
  socket.emit('create-room', roomId);
});

// room created successfully
socket.on('room-created', (id) => {
  console.log('room created:', id);
  
  // generate and display link
  const link = `${window.location.origin}/listen/${id}`;
  streamLinkInput.value = link;
  
  // switch views
  setupView.classList.add('hidden');
  broadcastView.classList.remove('hidden');
  
  // start visualizer
  startVisualizer();
});

// listener joined
socket.on('listener-joined', async (listenerId) => {
  console.log('listener joined:', listenerId);
  
  // create peer connection
  const peer = new RTCPeerConnection(rtcConfig);
  peers.set(listenerId, peer);
  
  // add local stream
  localStream.getTracks().forEach(track => {
    peer.addTrack(track, localStream);
  });
  
  // handle ice candidates
  peer.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', {
        target: listenerId,
        candidate: event.candidate
      });
    }
  };
  
  // create and send offer
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  
  socket.emit('offer', {
    target: listenerId,
    offer: offer
  });
});

// answer received from listener
socket.on('answer', async (data) => {
  const peer = peers.get(data.listener);
  if (peer) {
    await peer.setRemoteDescription(data.answer);
    console.log('answer received from:', data.listener);
  }
});

// ice candidate received
socket.on('ice-candidate', async (data) => {
  const peer = peers.get(data.from);
  if (peer && data.candidate) {
    await peer.addIceCandidate(data.candidate);
  }
});

// update listener count
socket.on('listener-count', (count) => {
  listenerCountEl.textContent = count;
});

// copy link
copyLinkBtn.addEventListener('click', () => {
  streamLinkInput.select();
  document.execCommand('copy');
  
  const originalText = copyLinkBtn.textContent;
  copyLinkBtn.textContent = 'copied!';
  setTimeout(() => {
    copyLinkBtn.textContent = originalText;
  }, 1500);
});

// stop broadcast
stopBtn.addEventListener('click', () => {
  if (confirm('end this broadcast? listeners will be disconnected.')) {
    cleanup();
    window.location.href = '/';
  }
});

// cleanup
function cleanup() {
  // stop all peer connections
  peers.forEach(peer => peer.close());
  peers.clear();
  
  // stop local stream
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
  }
  
  // close audio context
  if (audioContext) {
    audioContext.close();
  }
  
  // disconnect socket
  socket.disconnect();
  
  isAnimating = false;
}

// start visualizer
function startVisualizer() {
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  isAnimating = true;
  drawVisualizer();
}

function drawVisualizer() {
  if (!isAnimating) return;
  
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

// utility: generate room id
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8);
}

// handle page unload
window.addEventListener('beforeunload', (e) => {
  if (roomId) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// start
init();
