const FADE_START = 32;       // seconds (measured on intro's own clock)
const FADE_DURATION = 0.4;   // seconds
const HOLD_DURATION = 0.5;     // seconds to hold on intro's first frame before playing
const LOOP_LEAD_TIME = 0.5;  // seconds — how long before the fade the loop
                              // starts playing (kept short so it has less
                              // time to drift out of sync before it's shown)
const LOOP_TIMING_OFFSET = -3.2; // seconds — fine-tune when the loop actually
                              // starts relative to LOOP_LEAD_TIME's baseline.
                              // Positive: loop starts later (closer to fade).
                              // Negative: loop starts earlier (more lead time).
                              // This is the number to nudge if footage looks
                              // out of sync — LOOP_LEAD_TIME shouldn't need
                              // to change once it's tuned.

const vidIntro = document.getElementById('vidIntro');
const vidLoop = document.getElementById('vidLoop');
const canvas = document.getElementById('hero-canvas');
const gl = canvas.getContext('webgl', { alpha: false, premultipliedAlpha: false });

const vsSource = `
  attribute vec2 aPos;
  varying vec2 vUv;
  void main() {
    vUv = (aPos + 1.0) * 0.5;
    vUv.y = 1.0 - vUv.y;
    gl_Position = vec4(aPos, 0.0, 1.0);
  }
`;

const fsSource = `
  precision mediump float;
  varying vec2 vUv;
  uniform sampler2D uTexA;
  uniform sampler2D uTexB;
  uniform float uMix;
  uniform vec2 uCoverScale;
  uniform vec2 uCoverOffset;
  void main() {
    vec2 uv = vUv * uCoverScale + uCoverOffset;
    vec3 colA = texture2D(uTexA, uv).rgb;
    vec3 colB = texture2D(uTexB, uv).rgb;
    gl_FragColor = vec4(mix(colA, colB, uMix), 1.0);
  }
`;

function compileShader(type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  return shader;
}

const program = gl.createProgram();
gl.attachShader(program, compileShader(gl.VERTEX_SHADER, vsSource));
gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fsSource));
gl.linkProgram(program);
gl.useProgram(program);

const posBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
  -1, -1,  1, -1,  -1, 1,
  -1,  1,  1, -1,   1, 1,
]), gl.STATIC_DRAW);
const aPos = gl.getAttribLocation(program, 'aPos');
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

const uTexA = gl.getUniformLocation(program, 'uTexA');
const uTexB = gl.getUniformLocation(program, 'uTexB');
const uMix = gl.getUniformLocation(program, 'uMix');
const uCoverScale = gl.getUniformLocation(program, 'uCoverScale');
const uCoverOffset = gl.getUniformLocation(program, 'uCoverOffset');

function makeTexture() {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

const texA = makeTexture();
const texB = makeTexture();

let switched = false;
let fadeBeginTime = null;
let mixVal = 0;
let newFrameA = false;
let newFrameB = false;
let coverScale = [1, 1];
let coverOffset = [0, 0];
let canvasRevealed = false;

// release timestamps (performance.now()) and per-video "have we started
// playing yet" flags — computed once playback begins
let introReleaseAt = null;
let loopReleaseAt = null;
let introReleased = false;
let loopReleased = false;

function supportsVFC(video) {
  return typeof video.requestVideoFrameCallback === 'function';
}

function watchFrames(video, setFlag) {
  if (supportsVFC(video)) {
    const onFrame = () => { setFlag(); video.requestVideoFrameCallback(onFrame); };
    video.requestVideoFrameCallback(onFrame);
  }
}

function uploadFrame(tex, video) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
}

// emulates CSS object-fit: cover by scaling/offsetting the UVs sampled
// from the video textures, since WebGL has no built-in "cover" behavior
function updateCoverUniforms() {
  if (!vidIntro.videoWidth || !canvas.width) return;
  const canvasAspect = canvas.width / canvas.height;
  const videoAspect = vidIntro.videoWidth / vidIntro.videoHeight;

  if (videoAspect > canvasAspect) {
    const scaleX = canvasAspect / videoAspect;
    coverScale = [scaleX, 1];
    coverOffset = [(1 - scaleX) / 2, 0];
  } else {
    const scaleY = videoAspect / canvasAspect;
    coverScale = [1, scaleY];
    coverOffset = [0, (1 - scaleY) / 2];
  }
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
  }
  updateCoverUniforms();
}
window.addEventListener('resize', resizeCanvas);

function render() {
  requestAnimationFrame(render);

  const now = performance.now();

  // --- INTRO: hold via real .pause() (no drift, unlike playbackRate=0
  // on WebKit), resume via .play() once its release time has passed ---
  if (!introReleased) {
    if (now < introReleaseAt) {
      if (!vidIntro.paused) vidIntro.pause();
      uploadFrame(texA, vidIntro);
    } else {
      introReleased = true;
      vidIntro.play().catch(err => console.warn('Intro resume blocked:', err));
    }
  } else if (!supportsVFC(vidIntro) || newFrameA) {
    if (vidIntro.readyState >= vidIntro.HAVE_CURRENT_DATA) uploadFrame(texA, vidIntro);
    newFrameA = false;
  }

  // --- LOOP: same treatment ---
  if (!loopReleased) {
    if (now < loopReleaseAt) {
      if (!vidLoop.paused) vidLoop.pause();
      uploadFrame(texB, vidLoop);
    } else {
      loopReleased = true;
      vidLoop.play().catch(err => console.warn('Loop resume blocked:', err));
    }
  } else if (!supportsVFC(vidLoop) || newFrameB) {
    if (vidLoop.readyState >= vidLoop.HAVE_CURRENT_DATA) uploadFrame(texB, vidLoop);
    newFrameB = false;
  }

  if (!canvasRevealed && vidIntro.readyState >= vidIntro.HAVE_CURRENT_DATA) {
    canvas.classList.add('ready');
    canvasRevealed = true;
  }

  if (!switched && introReleased && vidIntro.currentTime >= FADE_START) {
    switched = true;
    fadeBeginTime = performance.now();
  }

  if (switched) {
    const elapsed = (performance.now() - fadeBeginTime) / 1000;
    mixVal = Math.min(elapsed / FADE_DURATION, 1);
    if (mixVal >= 1 && !vidIntro.paused) vidIntro.pause();
  }

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texA);
  gl.uniform1i(uTexA, 0);

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, texB);
  gl.uniform1i(uTexB, 1);

  gl.uniform1f(uMix, mixVal);
  gl.uniform2fv(uCoverScale, coverScale);
  gl.uniform2fv(uCoverOffset, coverOffset);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

document.addEventListener('DOMContentLoaded', () => {
  watchFrames(vidIntro, () => { newFrameA = true; });
  watchFrames(vidLoop, () => { newFrameB = true; });

  vidIntro.addEventListener('loadedmetadata', resizeCanvas, { once: true });

  vidIntro.muted = true;
  vidLoop.muted = true;
  vidIntro.defaultMuted = true;
  vidLoop.defaultMuted = true;

  // both videos get an initial play() call up front (required to satisfy
  // autoplay policy once), then whichever one needs to hold is paused via
  // real .pause() until its release time — pausing is drift-free, unlike
  // playbackRate = 0, which WebKit doesn't reliably honor as a true freeze
  Promise.all([vidIntro.play(), vidLoop.play()]).then(() => {
    const playStart = performance.now();
    introReleaseAt = playStart + HOLD_DURATION * 1000;

    // loop starts playing LOOP_LEAD_TIME seconds before the fade point,
    // adjusted by LOOP_TIMING_OFFSET for fine sync tuning — rather than
    // for the whole hold+intro duration, so it has less real time to
    // drift out of sync with the intro before it's actually shown
    loopReleaseAt = introReleaseAt
      + Math.max(FADE_START - LOOP_LEAD_TIME, 0) * 1000
      + LOOP_TIMING_OFFSET * 1000;

    resizeCanvas();
    requestAnimationFrame(render);
  }).catch(err => {
    console.warn('Playback was interrupted:', err);
  });
});