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
  // get room id from url
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
  console.log('offer received from broadcaster');
  
  // create peer connection
  peerConnection = new RTCPeerConnection(rtcConfig);
  
  // handle incoming stream
  peerConnection.ontrack = (event) => {
    console.log('remote stream received');
    remoteAudio.srcObject = event.streams[0];
    
    // setup visualizer
    setupVisualizer(event.streams[0]);
    
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
  await peerConnection.setRemoteDescription(data.offer);
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  
  // send answer
  socket.emit('answer', {
    target: data.broadcaster,
    answer: answer
  });
});

// ice candidate received
socket.on('ice-candidate', async (data) => {
  if (peerConnection && data.candidate) {
    await peerConnection.addIceCandidate(data.candidate);
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
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  
  isAnimating = true;
  drawVisualizer();
}

// draw visualizer
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

// leave stream
leaveBtn.addEventListener('click', () => {
  cleanup();
  window.location.href = '/';
});

// cleanup
function cleanup() {
  if (peerConnection) {
    peerConnection.close();
  }
  
  if (audioContext) {
    audioContext.close();
  }
  
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

// start
init();
