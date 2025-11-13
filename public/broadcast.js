// mk-air broadcast client
// handles dual audio sources: microphone + system audio mixed

const socket = io();

// dom elements
const micView = document.getElementById('mic-view');
const sourceView = document.getElementById('source-view');
const broadcastView = document.getElementById('broadcast-view');
const requestMicBtn = document.getElementById('request-mic');
const addSystemAudioBtn = document.getElementById('add-system-audio');
const startBtn = document.getElementById('start-broadcast');
const stopBtn = document.getElementById('stop-broadcast');
const copyLinkBtn = document.getElementById('copy-link');
const streamLinkInput = document.getElementById('stream-link');
const listenerCountEl = document.getElementById('listener-count');
const audioDeviceSelect = document.getElementById('audio-device-select');
const sourcesStatus = document.getElementById('sources-status');
const broadcastSources = document.getElementById('broadcast-sources');
const canvas = document.getElementById('visualizer');
const canvasCtx = canvas.getContext('2d');

// state
let micStream = null;
let systemStream = null;
let mixedStream = null;
let audioContext = null;
let analyser = null;
let roomId = null;
let peers = new Map();
let isAnimating = false;
let hasSystemAudio = false;

// webrtc configuration
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// STEP 1: Request microphone
requestMicBtn.addEventListener('click', async () => {
  try {
    requestMicBtn.disabled = true;
    requestMicBtn.textContent = 'accessing microphone...';
    
    // get microphone stream
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    
    // enumerate devices
    await enumerateDevices();
    
    // move to source selection
    micView.classList.add('hidden');
    sourceView.classList.remove('hidden');
    
    updateSourcesStatus();
    
  } catch (err) {
    console.error('microphone access denied:', err);
    alert('mk-air needs microphone access. please allow and try again.');
    requestMicBtn.disabled = false;
    requestMicBtn.textContent = 'allow microphone access';
  }
});

// enumerate audio devices
async function enumerateDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioDevices = devices.filter(d => d.kind === 'audioinput');
    
    audioDeviceSelect.innerHTML = '';
    
    if (audioDevices.length === 0) {
      audioDeviceSelect.innerHTML = '<option>default microphone</option>';
    } else {
      audioDevices.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `microphone ${index + 1}`;
        audioDeviceSelect.appendChild(option);
      });
    }
  } catch (err) {
    console.error('error enumerating devices:', err);
    audioDeviceSelect.innerHTML = '<option>default microphone</option>';
  }
}

// change microphone device
audioDeviceSelect.addEventListener('change', async () => {
  try {
    const deviceId = audioDeviceSelect.value;
    
    // stop current mic stream
    if (micStream) {
      micStream.getTracks().forEach(track => track.stop());
    }
    
    // get new stream with selected device
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    
  } catch (err) {
    console.error('error changing microphone:', err);
    alert('failed to switch microphone device');
  }
});

// STEP 2: Add system audio (optional)
addSystemAudioBtn.addEventListener('click', async () => {
  try {
    addSystemAudioBtn.disabled = true;
    addSystemAudioBtn.textContent = 'requesting screen capture...';
    
    // get system audio via screen capture
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    
    // stop video track
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.stop();
      stream.removeTrack(videoTrack);
    }
    
    // check if has audio
    if (stream.getAudioTracks().length === 0) {
      throw new Error('no audio in screen capture. make sure to check "share audio"');
    }
    
    systemStream = stream;
    hasSystemAudio = true;
    
    addSystemAudioBtn.textContent = '✓ system audio added';
    addSystemAudioBtn.classList.add('active');
    
    updateSourcesStatus();
    
  } catch (err) {
    console.error('system audio error:', err);
    
    if (err.message.includes('no audio')) {
      alert(err.message);
    } else if (err.name === 'NotAllowedError') {
      alert('screen capture cancelled');
    }
    
    addSystemAudioBtn.disabled = false;
    addSystemAudioBtn.textContent = '+ add system audio';
  }
});

// update sources status
function updateSourcesStatus() {
  if (hasSystemAudio) {
    sourcesStatus.textContent = '🎙️ mic ready · 🖥️ system audio ready';
  } else {
    sourcesStatus.textContent = '🎙️ mic ready · no system audio';
  }
}

// STEP 3: Start broadcast (mix streams)
startBtn.addEventListener('click', async () => {
  try {
    startBtn.disabled = true;
    startBtn.textContent = 'starting broadcast...';
    
    // create audio context for mixing
    audioContext = new AudioContext();
    
    // create destination for mixed audio
    const destination = audioContext.createMediaStreamDestination();
    
    // add microphone
    const micSource = audioContext.createMediaStreamSource(micStream);
    const micGain = audioContext.createGain();
    micGain.gain.value = 1.0;
    micSource.connect(micGain);
    micGain.connect(destination);
    
    // add system audio if available
    if (hasSystemAudio && systemStream) {
      const systemSource = audioContext.createMediaStreamSource(systemStream);
      const systemGain = audioContext.createGain();
      systemGain.gain.value = 0.8; // slightly lower to prioritize voice
      systemSource.connect(systemGain);
      systemGain.connect(destination);
    }
    
    // setup analyzer for visualization
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    
    // connect destination to analyser
    const analyserSource = audioContext.createMediaStreamSource(destination.stream);
    analyserSource.connect(analyser);
    
    // mixed stream to broadcast
    mixedStream = destination.stream;
    
    // generate room id
    roomId = generateRoomId();
    
    // create room on server
    socket.emit('create-room', roomId);
    
  } catch (err) {
    console.error('error starting broadcast:', err);
    alert('failed to start broadcast: ' + err.message);
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
  
  // update broadcast sources display
  if (hasSystemAudio) {
    broadcastSources.textContent = '🎙️ microphone + 🖥️ system audio active';
  } else {
    broadcastSources.textContent = '🎙️ microphone active';
  }
  
  // switch to broadcast view
  sourceView.classList.add('hidden');
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
  
  // add mixed stream tracks
  mixedStream.getTracks().forEach(track => {
    peer.addTrack(track, mixedStream);
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
  
  // stop streams
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
  }
  if (systemStream) {
    systemStream.getTracks().forEach(track => track.stop());
  }
  if (mixedStream) {
    mixedStream.getTracks().forEach(track => track.stop());
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
