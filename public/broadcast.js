// mk-air broadcast client
// handles webrtc broadcasting and visualizer with audio source selection

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

// audio source selection
const sourceBtns = document.querySelectorAll('.source-btn');
const deviceSelector = document.getElementById('device-selector');
const audioDeviceSelect = document.getElementById('audio-device-select');
const sourceHint = document.getElementById('source-hint');

// state
let localStream = null;
let audioContext = null;
let analyser = null;
let roomId = null;
let peers = new Map();
let isAnimating = false;
let selectedSource = 'microphone';
let audioDevices = [];

// webrtc configuration
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// source selection
sourceBtns.forEach(btn => {
  btn.addEventListener('click', function() {
    sourceBtns.forEach(b => b.classList.remove('active'));
    this.classList.add('active');
    selectedSource = this.dataset.source;
    
    if (selectedSource === 'microphone') {
      deviceSelector.style.display = 'block';
      sourceHint.textContent = 'capture audio from your microphone or instrument';
    } else {
      deviceSelector.style.display = 'none';
      sourceHint.textContent = 'capture audio from your browser tab or entire screen (music, daw, anything)';
    }
  });
});

// initialize
async function init() {
  try {
    // enumerate audio devices
    await enumerateDevices();
    startBtn.disabled = false;
  } catch (err) {
    console.error('error initializing:', err);
  }
}

// enumerate audio input devices
async function enumerateDevices() {
  try {
    // request initial permission to get device labels
    const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    tempStream.getTracks().forEach(track => track.stop());
    
    const devices = await navigator.mediaDevices.enumerateDevices();
    audioDevices = devices.filter(device => device.kind === 'audioinput');
    
    // populate select
    audioDeviceSelect.innerHTML = '';
    audioDevices.forEach(device => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `microphone ${audioDevices.indexOf(device) + 1}`;
      audioDeviceSelect.appendChild(option);
    });
    
    console.log('audio devices enumerated:', audioDevices.length);
  } catch (err) {
    console.error('error enumerating devices:', err);
    audioDeviceSelect.innerHTML = '<option>default microphone</option>';
  }
}

// get audio stream based on selected source
async function getAudioStream() {
  if (selectedSource === 'microphone') {
    // microphone mode
    const deviceId = audioDeviceSelect.value;
    const constraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    };
    return await navigator.mediaDevices.getUserMedia(constraints);
    
  } else {
    // system audio mode
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
      
      // stop video track (we only want audio)
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.stop();
        stream.removeTrack(videoTrack);
      }
      
      // check if audio track exists
      if (stream.getAudioTracks().length === 0) {
        throw new Error('no audio track in screen capture. make sure to check "share audio" when selecting your source.');
      }
      
      return stream;
      
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        throw new Error('screen capture permission denied');
      } else if (err.message.includes('no audio track')) {
        throw err;
      } else {
        throw new Error('screen capture not supported or failed');
      }
    }
  }
}

// start broadcast
startBtn.addEventListener('click', async () => {
  try {
    startBtn.disabled = true;
    startBtn.textContent = 'connecting...';
    
    // get audio stream
    localStream = await getAudioStream();
    
    // setup audio context for visualization
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(localStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    
    // generate room id
    roomId = generateRoomId();
    
    // create room on server
    socket.emit('create-room', roomId);
    
  } catch (err) {
    console.error('error starting broadcast:', err);
    alert(err.message || 'failed to access audio. please check permissions and try again.');
    startBtn.disabled = false;
    startBtn.textContent = 'start broadcast';
  }
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
