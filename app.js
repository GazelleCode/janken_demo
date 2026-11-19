/* JANKEN TIMING TEST — camera frames and inference remain on this device. */

// Tune these values during camera/recognition calibration.
const MEDIAPIPE_VERSION = "0.10.21";
const TASKS_VISION_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
const GESTURE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";
// The game only permits rock, scissors, or paper, so favour a quick, lenient
// classification over rejecting an ambiguous but usable hand shape.
const GESTURE_CONFIDENCE_THRESHOLD = 0.20;
const STABLE_FRAME_COUNT = 2;
const REQUESTED_WIDTH = 1280;
const REQUESTED_HEIGHT = 720;
const MIRROR_PREVIEW = true;
const DEBUG_LOG_LIMIT = 40;
// AUTO JUDGE arms on visible janken motion, then uses adaptive settling rather
// than requiring a perfectly motionless hand. All values are normalized to the frame.
const AUTO_MOTION_START_FLOOR = 0.014;
const AUTO_MOTION_HISTORY_SIZE = 24;
const AUTO_SETTLE_WINDOW = 3;
const AUTO_SETTLE_FRAME_COUNT = 2;
const AUTO_SETTLE_NOISE_MULTIPLIER = 2.4;
const AUTO_SETTLE_MIN_THRESHOLD = 0.005;
const AUTO_SETTLE_MAX_THRESHOLD = 0.016;

const GESTURE_NAMES = Object.freeze({
  Closed_Fist: "ROCK",
  Victory: "SCISSORS",
  Open_Palm: "PAPER",
});

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15],
  [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

const $ = (id) => document.getElementById(id);
const ui = {
  video: $("camera"), overlay: $("overlay"), status: $("app-status"),
  placeholder: $("camera-placeholder"), countdown: $("countdown"),
  enableCamera: $("enable-camera"), start: $("start-test"), auto: $("auto-judge"), reset: $("reset-test"),
  result: $("result-panel"), resultAGesture: $("result-a-gesture"),
  resultATime: $("result-a-time"), resultBGesture: $("result-b-gesture"),
  resultBTime: $("result-b-time"), resultLabel: $("result-label"), winnerMessage: $("winner-message"),
  difference: $("time-difference"), laterMessage: $("later-message"), orientationHint: $("orientation-hint"),
  cameraFps: $("camera-fps"), measuredFps: $("measured-fps"), frameInterval: $("frame-interval"),
  debugMode: $("debug-mode"), debugDetails: $("debug-details"), debugLog: $("debug-log"),
  player: {
    A: { detected: $("a-detected"), gesture: $("a-gesture"), confidence: $("a-confidence"), locked: $("a-locked") },
    B: { detected: $("b-detected"), gesture: $("b-gesture"), confidence: $("b-confidence"), locked: $("b-locked") },
  },
};
const canvas = ui.overlay;
const context = canvas.getContext("2d");

let FilesetResolver;
let GestureRecognizer;
let recognizer;
let cameraStream;
let cameraReady = false;
let frameLoopStarted = false;
let countdownRun = 0;
let phase = "idle"; // idle | countdown | running | auto | result
let goTimestamp = null;
let measurement = { A: null, B: null };
let autoMotionTriggered = false;
let debugLines = [];
let frameTimestamps = [];
let lastFrameTimestamp = null;

function emptyTracker() {
  return {
    detected: false, gesture: "UNKNOWN", confidence: 0, centerX: null,
    motionPoint: null, motion: 0, motionHistory: [], shortMotion: 0,
    settleThreshold: AUTO_SETTLE_MIN_THRESHOLD, settleCount: 0, isSettled: false,
    sequenceGesture: null, sequenceCount: 0, sequenceStartTimestamp: null, lastLocked: null,
  };
}
const trackers = { A: emptyTracker(), B: emptyTracker() };

function setStatus(message, isError = false) {
  ui.status.textContent = message;
  ui.status.style.color = isError ? "var(--danger)" : "";
}

function formatMs(value) { return `${value.toFixed(1)} ms`; }

function displayTimestamp(timestamp) {
  if (timestamp === null || goTimestamp === null || timestamp < goTimestamp) return "—";
  return formatMs(timestamp - goTimestamp);
}

function resetStability(track) {
  track.sequenceGesture = null;
  track.sequenceCount = 0;
  track.sequenceStartTimestamp = null;
  track.lastLocked = null;
}

function resetLiveTrackers() {
  for (const player of ["A", "B"]) Object.assign(trackers[player], emptyTracker());
}

function resetForGo() {
  measurement = { A: null, B: null };
  for (const player of ["A", "B"]) resetStability(trackers[player]);
}

function updatePlayerUI(player) {
  const track = trackers[player];
  const elements = ui.player[player];
  elements.detected.textContent = track.detected ? "HAND FOUND" : "NO HAND";
  elements.detected.classList.toggle("detected", track.detected);
  elements.gesture.textContent = track.gesture;
  elements.confidence.textContent = track.gesture === "UNKNOWN" ? "—" : `${Math.round(track.confidence * 100)}%`;
  elements.locked.textContent = displayTimestamp(measurement[player]?.timestamp ?? track.lastLocked?.timestamp ?? null);
}

function updateAllPlayerUI() {
  updatePlayerUI("A");
  updatePlayerUI("B");
}

function updateFrameTelemetry(timestamp) {
  if (lastFrameTimestamp !== null && timestamp > lastFrameTimestamp) {
    frameTimestamps.push(timestamp - lastFrameTimestamp);
    if (frameTimestamps.length > 90) frameTimestamps.shift();
  }
  lastFrameTimestamp = timestamp;
  if (!frameTimestamps.length) return;
  const average = frameTimestamps.reduce((sum, item) => sum + item, 0) / frameTimestamps.length;
  ui.measuredFps.textContent = `${(1000 / average).toFixed(1)}`;
  ui.frameInterval.textContent = `${average.toFixed(1)} ms`;
}

function landmarkFallbackGesture(landmarks) {
  const wrist = landmarks?.[0];
  if (!wrist) return null;
  const fingerPairs = [[6, 8], [10, 12], [14, 16], [18, 20]];
  const extended = fingerPairs.map(([pip, tip]) => {
    const pipDistance = Math.hypot(landmarks[pip].x - wrist.x, landmarks[pip].y - wrist.y);
    const tipDistance = Math.hypot(landmarks[tip].x - wrist.x, landmarks[tip].y - wrist.y);
    return tipDistance > pipDistance * 1.12;
  });
  const [index, middle, ring, pinky] = extended;
  const count = extended.filter(Boolean).length;
  if (count >= 3) return { gesture: "PAPER", confidence: 0.45, rawName: "landmark_fallback" };
  if (index && middle && !ring && !pinky) return { gesture: "SCISSORS", confidence: 0.45, rawName: "landmark_fallback" };
  if (count <= 1) return { gesture: "ROCK", confidence: 0.45, rawName: "landmark_fallback" };
  // With this app's constrained input, ambiguous two-finger shapes are closer
  // to scissors than an unknown state, which keeps timing capture responsive.
  return { gesture: "SCISSORS", confidence: 0.35, rawName: "landmark_fallback" };
}

function mapGesture(categories, landmarks) {
  const category = categories?.[0];
  if (!category) return landmarkFallbackGesture(landmarks) || { gesture: "UNKNOWN", confidence: 0, rawName: "none" };
  const rawName = category.categoryName || category.displayName || "unknown";
  const confidence = Number(category.score) || 0;
  const gesture = GESTURE_NAMES[rawName] || "UNKNOWN";
  if (gesture !== "UNKNOWN" && confidence >= GESTURE_CONFIDENCE_THRESHOLD) {
    return { gesture, confidence, rawName };
  }
  return landmarkFallbackGesture(landmarks) || { gesture: "UNKNOWN", confidence, rawName };
}

function handCenter(landmarks) {
  const wrist = landmarks?.[0];
  if (!wrist) return null;
  // A/B follows the position the user sees, not MediaPipe handedness.
  return MIRROR_PREVIEW ? 1 - wrist.x : wrist.x;
}

function makeCandidate(landmarks, categories, index) {
  const centerX = handCenter(landmarks);
  return centerX === null ? null : { index, landmarks, centerX, ...mapGesture(categories, landmarks) };
}

function selectCandidateForPlayer(candidates, player) {
  const inZone = candidates.filter((candidate) => player === "A" ? candidate.centerX < 0.5 : candidate.centerX >= 0.5);
  if (!inZone.length) return null;
  return inZone.sort((left, right) => {
    const target = player === "A" ? 0.25 : 0.75;
    return Math.abs(left.centerX - target) - Math.abs(right.centerX - target);
  })[0];
}

function resetMotionAnalysis(track) {
  track.motionPoint = null;
  track.motion = 0;
  track.motionHistory = [];
  track.shortMotion = 0;
  track.settleThreshold = AUTO_SETTLE_MIN_THRESHOLD;
  track.settleCount = 0;
  track.isSettled = false;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * ratio))];
}

function updateMotion(track, candidate) {
  const landmarks = candidate?.landmarks;
  if (!landmarks?.length) {
    resetMotionAnalysis(track);
    return 0;
  }
  // Averaging the wrist and four fingertips catches both the normal janken
  // arm movement and a hand shape changing while its wrist stays in place.
  const anchorIndices = [0, 8, 12, 16, 20];
  const points = anchorIndices.map((index) => landmarks[index]).filter(Boolean);
  const anchor = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  anchor.x /= points.length;
  anchor.y /= points.length;
  const previous = track.motionPoint;
  const motion = previous ? Math.hypot(anchor.x - previous.x, anchor.y - previous.y) : 0;
  track.motionPoint = anchor;
  track.motion = motion;
  track.motionHistory.push(motion);
  if (track.motionHistory.length > AUTO_MOTION_HISTORY_SIZE) track.motionHistory.shift();

  const recent = track.motionHistory.slice(-AUTO_SETTLE_WINDOW);
  track.shortMotion = recent.reduce((sum, amount) => sum + amount, 0) / recent.length;
  // The lower part of the current history approximates this camera's normal
  // hand-tracking jitter. Its bounded multiple creates a per-device/scene
  // quiet threshold without requiring that every frame be exactly still.
  const noiseFloor = percentile(track.motionHistory, 0.25);
  track.settleThreshold = Math.min(
    AUTO_SETTLE_MAX_THRESHOLD,
    Math.max(AUTO_SETTLE_MIN_THRESHOLD, noiseFloor * AUTO_SETTLE_NOISE_MULTIPLIER),
  );
  const hasSettleWindow = recent.length === AUTO_SETTLE_WINDOW;
  const quiet = hasSettleWindow && track.shortMotion <= track.settleThreshold;
  track.settleCount = quiet ? track.settleCount + 1 : 0;
  track.isSettled = track.settleCount >= AUTO_SETTLE_FRAME_COUNT;
  return motion;
}

function movementStartThreshold(track) {
  // A sudden movement needs to be meaningfully above the adaptive noise floor.
  return Math.max(AUTO_MOTION_START_FLOOR, track.settleThreshold * 2.2);
}

function startAutoCapture(timestamp) {
  autoMotionTriggered = true;
  goTimestamp = timestamp;
  resetForGo();
  setStatus("動きを検知しました。動きが減衰して手形が安定したら自動判定します。");
}

function winnerFor(aGesture, bGesture) {
  if (aGesture === bGesture) return "DRAW — SAME HAND";
  const aWins = { ROCK: "SCISSORS", SCISSORS: "PAPER", PAPER: "ROCK" };
  return aWins[aGesture] === bGesture ? "PLAYER A WINS" : "PLAYER B WINS";
}

function updateStability(player, candidate, timestamp) {
  const track = trackers[player];
  if (!candidate || candidate.gesture === "UNKNOWN") {
    track.sequenceGesture = null;
    track.sequenceCount = 0;
    track.sequenceStartTimestamp = null;
    return;
  }
  if (track.sequenceGesture === candidate.gesture) {
    track.sequenceCount += 1;
  } else {
    track.sequenceGesture = candidate.gesture;
    track.sequenceCount = 1;
    track.sequenceStartTimestamp = timestamp;
  }
  // The stored time is intentionally the first frame of the stable run.
  if (track.sequenceCount === STABLE_FRAME_COUNT) {
    track.lastLocked = {
      gesture: candidate.gesture,
      confidence: candidate.confidence,
      timestamp: track.sequenceStartTimestamp,
    };
    const canRecord = phase === "running" || (phase === "auto" && autoMotionTriggered);
    if (canRecord && !measurement[player]) {
      measurement[player] = { ...track.lastLocked };
      setStatus(`PLAYER ${player} を記録しました。もう一方の手を待っています。`);
      if (measurement.A && measurement.B) finishMeasurement();
    }
  }
}

function drawLandmarks(landmarkGroups, candidates) {
  if (!context || !canvas.width || !canvas.height) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!ui.debugMode.checked) return;
  landmarkGroups.forEach((landmarks, index) => {
    const candidate = candidates.find((entry) => entry.index === index);
    const color = candidate?.centerX < 0.5 ? "#3dc5ff" : "#ffb647";
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = Math.max(2, canvas.width / 420);
    context.beginPath();
    HAND_CONNECTIONS.forEach(([from, to]) => {
      const start = landmarks[from]; const end = landmarks[to];
      if (start && end) { context.moveTo(start.x * canvas.width, start.y * canvas.height); context.lineTo(end.x * canvas.width, end.y * canvas.height); }
    });
    context.stroke();
    landmarks.forEach((point) => {
      context.beginPath();
      context.arc(point.x * canvas.width, point.y * canvas.height, Math.max(3, canvas.width / 150), 0, Math.PI * 2);
      context.fill();
    });
  });
}

function landmarksForLog(landmarks) {
  return landmarks.map((point, index) => `${index}:(${point.x.toFixed(3)},${point.y.toFixed(3)},${(point.z || 0).toFixed(3)})`).join(" ");
}

function logDebugFrame(timestamp, candidates, selections) {
  if (!ui.debugMode.checked) return;
  const output = [
    `timestamp=${timestamp.toFixed(2)}ms phase=${phase}`,
    ...candidates.map((candidate) => {
      const assigned = selections.A?.index === candidate.index ? "A" : selections.B?.index === candidate.index ? "B" : "outside";
      const tracker = assigned === "A" || assigned === "B" ? trackers[assigned] : null;
      return `[${assigned}] hand=${candidate.index} wrist/screenX=${candidate.centerX.toFixed(3)} raw=${candidate.rawName} mapped=${candidate.gesture} confidence=${(candidate.confidence * 100).toFixed(1)}% motion=${(tracker?.motion ?? 0).toFixed(3)} shortMotion=${(tracker?.shortMotion ?? 0).toFixed(3)} settle≤${(tracker?.settleThreshold ?? 0).toFixed(3)} settled=${tracker?.isSettled ?? false} (${tracker?.settleCount ?? 0}/${AUTO_SETTLE_FRAME_COUNT}) streak=${tracker?.sequenceCount ?? 0}/${STABLE_FRAME_COUNT}\n  landmarks: ${landmarksForLog(candidate.landmarks)}`;
    }),
  ].join("\n");
  debugLines.unshift(output);
  debugLines = debugLines.slice(0, DEBUG_LOG_LIMIT);
  ui.debugLog.textContent = debugLines.join("\n\n");
}

function processFrame(timestamp) {
  updateFrameTelemetry(timestamp);
  if (!recognizer || ui.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  try {
    const result = recognizer.recognizeForVideo(ui.video, timestamp);
    const landmarkGroups = result.landmarks || [];
    const candidates = landmarkGroups
      .map((landmarks, index) => makeCandidate(landmarks, result.gestures?.[index], index))
      .filter(Boolean);
    const selections = {
      A: selectCandidateForPlayer(candidates, "A"),
      B: selectCandidateForPlayer(candidates, "B"),
    };
    const motion = {
      A: updateMotion(trackers.A, selections.A),
      B: updateMotion(trackers.B, selections.B),
    };
    const autoMotionStartThisFrame = phase === "auto" && ["A", "B"].some(
      (player) => motion[player] >= movementStartThreshold(trackers[player]),
    );
    if (phase === "auto" && !autoMotionTriggered && autoMotionStartThisFrame) startAutoCapture(timestamp);

    for (const player of ["A", "B"]) {
      const candidate = selections[player];
      const track = trackers[player];
      track.detected = Boolean(candidate);
      track.centerX = candidate?.centerX ?? null;
      track.gesture = candidate?.gesture ?? "UNKNOWN";
      track.confidence = candidate?.confidence ?? 0;
      // A callback that was queued just before GO must not seed a post-GO
      // sequence, even on an unusually busy browser event loop.
      const eligibleForTiming = phase !== "running" || timestamp >= goTimestamp;
      // AUTO JUDGE accepts a recognised hand only after its rolling movement
      // has settled; slight natural tremor remains acceptable.
      const autoCandidate = autoMotionTriggered && track.isSettled ? candidate : null;
      const candidateForStability = phase === "auto" ? autoCandidate : candidate;
      updateStability(player, eligibleForTiming ? candidateForStability : null, timestamp);
    }
    drawLandmarks(landmarkGroups, candidates);
    logDebugFrame(timestamp, candidates, selections);
    updateAllPlayerUI();
  } catch (error) {
    // Preserve the camera loop on a transient WASM/frame failure.
    setStatus(`フレーム認識エラー: ${error.message || error}`, true);
  }
}

function scheduleNextFrame() {
  if (!cameraReady) return;
  if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
    ui.video.requestVideoFrameCallback((now) => {
      processFrame(now);
      scheduleNextFrame();
    });
  } else {
    requestAnimationFrame((now) => {
      processFrame(now);
      scheduleNextFrame();
    });
  }
}

function startFrameLoop() {
  if (frameLoopStarted) return;
  frameLoopStarted = true;
  scheduleNextFrame();
}

function resizeOverlay() {
  const { videoWidth: width, videoHeight: height } = ui.video;
  if (width && height && (canvas.width !== width || canvas.height !== height)) {
    canvas.width = width;
    canvas.height = height;
  }
}

function wait(milliseconds, runId) {
  return new Promise((resolve) => window.setTimeout(() => resolve(runId === countdownRun), milliseconds));
}

async function startTest() {
  if (!cameraReady || !recognizer) {
    setStatus("先にカメラと認識エンジンを準備してください。", true);
    return;
  }
  const runId = ++countdownRun;
  phase = "countdown";
  autoMotionTriggered = false;
  resetForGo();
  ui.result.hidden = true;
  ui.start.disabled = true;
  ui.auto.disabled = true;
  ui.reset.disabled = false;
  updateAllPlayerUI();

  for (const count of [3, 2, 1]) {
    ui.countdown.textContent = String(count);
    ui.countdown.classList.remove("go");
    ui.countdown.hidden = false;
    setStatus(`${count}… 構えてください。`);
    if (!(await wait(1000, runId))) return;
  }
  if (runId !== countdownRun) return;

  // Discard pre-GO streaks so each first captured sequence begins after GO.
  resetForGo();
  goTimestamp = performance.now();
  phase = "running";
  ui.countdown.textContent = "GO!";
  ui.countdown.classList.add("go");
  setStatus("測定中: 最初に安定したグー・チョキ・パーを記録します。");
  updateAllPlayerUI();
  window.setTimeout(() => {
    if (runId === countdownRun && phase === "running") ui.countdown.hidden = true;
  }, 700);
}

function startAutoJudge() {
  if (!cameraReady || !recognizer) {
    setStatus("先にカメラと認識エンジンを準備してください。", true);
    return;
  }
  countdownRun += 1;
  phase = "auto";
  goTimestamp = null;
  autoMotionTriggered = false;
  resetForGo();
  for (const player of ["A", "B"]) resetMotionAnalysis(trackers[player]);
  ui.countdown.hidden = true;
  ui.result.hidden = true;
  ui.start.disabled = true;
  ui.auto.disabled = true;
  ui.reset.disabled = false;
  updateAllPlayerUI();
  setStatus("AUTO JUDGE待機中: じゃんけんの動きを検知後、止まった手形を自動判定します。");
}

function finishMeasurement() {
  const completedAutomatically = phase === "auto";
  phase = "result";
  ui.countdown.hidden = true;
  const a = measurement.A;
  const b = measurement.B;
  const difference = b.timestamp - a.timestamp;
  ui.resultAGesture.textContent = a.gesture;
  ui.resultATime.textContent = formatMs(a.timestamp - goTimestamp);
  ui.resultBGesture.textContent = b.gesture;
  ui.resultBTime.textContent = formatMs(b.timestamp - goTimestamp);
  const winner = winnerFor(a.gesture, b.gesture);
  ui.resultLabel.textContent = completedAutomatically ? "AUTO JUDGEMENT COMPLETE" : "MEASUREMENT COMPLETE";
  ui.winnerMessage.textContent = winner;
  ui.difference.textContent = formatMs(Math.abs(difference));
  if (Math.abs(difference) < 0.05) {
    ui.laterMessage.textContent = "SAME CAPTURE FRAME (within displayed precision)";
  } else if (winner === "DRAW — SAME HAND") {
    const later = difference > 0 ? "PLAYER B" : "PLAYER A";
    ui.laterMessage.textContent = `${later} WAS ${formatMs(Math.abs(difference))} LATER`;
  } else {
    const winnerTimestamp = winner === "PLAYER A WINS" ? a.timestamp : b.timestamp;
    const loserTimestamp = winner === "PLAYER A WINS" ? b.timestamp : a.timestamp;
    const relation = winnerTimestamp < loserTimestamp ? "EARLIER" : "LATER";
    ui.laterMessage.textContent = `WINNER WAS ${formatMs(Math.abs(difference))} ${relation}`;
  }
  ui.result.hidden = false;
  ui.start.disabled = false;
  ui.auto.disabled = false;
  ui.reset.disabled = false;
  updateAllPlayerUI();
  setStatus(`${completedAutomatically ? "自動判定" : "測定"}完了: ${winner}。RESETで次の測定を開始できます。`);
}

function resetTest() {
  countdownRun += 1;
  phase = "idle";
  goTimestamp = null;
  autoMotionTriggered = false;
  measurement = { A: null, B: null };
  resetLiveTrackers();
  ui.countdown.hidden = true;
  ui.countdown.classList.remove("go");
  ui.result.hidden = true;
  ui.start.disabled = !cameraReady;
  ui.auto.disabled = !cameraReady;
  ui.reset.disabled = !cameraReady;
  updateAllPlayerUI();
  if (cameraReady) {
    setStatus("リセットしました。自動判定を再開します。");
    window.requestAnimationFrame(startAutoJudge);
  }
}

async function enableCamera() {
  if (!recognizer) {
    setStatus("認識エンジンの準備が完了していません。少し待ってください。", true);
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("このブラウザはカメラAPIに対応していません。HTTPS対応ブラウザで開いてください。", true);
    return;
  }
  if (!window.isSecureContext && location.hostname !== "localhost") {
    setStatus("カメラにはHTTPSが必要です。GitHub PagesのURLから開いてください。", true);
    return;
  }
  ui.enableCamera.disabled = true;
  setStatus("カメラへのアクセス許可を待っています…");
  try {
    cameraStream?.getTracks().forEach((track) => track.stop());
    const preferredConstraints = {
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: REQUESTED_WIDTH },
        height: { ideal: REQUESTED_HEIGHT },
        frameRate: { ideal: 60, min: 24 },
      },
    };
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia(preferredConstraints);
    } catch {
      // Mobile cameras sometimes reject a requested frame-rate range.
      cameraStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user" } });
    }
    ui.video.srcObject = cameraStream;
    await new Promise((resolve) => { ui.video.onloadedmetadata = resolve; });
    await ui.video.play();
    resizeOverlay();
    const settings = cameraStream.getVideoTracks()[0]?.getSettings?.() || {};
    ui.cameraFps.textContent = settings.frameRate ? `${Number(settings.frameRate).toFixed(1)}` : "not reported";
    cameraReady = true;
    document.body.classList.add("camera-active");
    ui.placeholder.hidden = true;
    ui.enableCamera.textContent = "CAMERA READY";
    ui.start.disabled = false;
    ui.auto.disabled = false;
    ui.reset.disabled = false;
    setStatus("カメラ準備完了。自動判定を開始します。");
    startFrameLoop();
    // A single camera-permission tap is enough for normal use. The app now
    // watches for the next janken motion without requiring a START button.
    window.requestAnimationFrame(startAutoJudge);
  } catch (error) {
    const hints = {
      NotAllowedError: "カメラ権限が拒否されました。ブラウザ設定で許可してください。",
      NotFoundError: "利用できるカメラが見つかりません。",
      NotReadableError: "カメラを他のアプリが使用中の可能性があります。",
      OverconstrainedError: "このカメラでは指定した条件を満たせません。",
    };
    setStatus(hints[error?.name] || `カメラを開始できませんでした: ${error?.message || error}`, true);
    ui.enableCamera.disabled = false;
  }
}

async function initialiseRecognizer() {
  try {
    ({ FilesetResolver, GestureRecognizer } = await import(TASKS_VISION_CDN));
    const vision = await FilesetResolver.forVisionTasks(`${TASKS_VISION_CDN}/wasm`);
    const recognizerOptions = {
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.35,
      minHandPresenceConfidence: 0.35,
      minTrackingConfidence: 0.35,
    };
    try {
      recognizer = await GestureRecognizer.createFromOptions(vision, {
        ...recognizerOptions,
        baseOptions: { modelAssetPath: GESTURE_MODEL_URL, delegate: "GPU" },
      });
      setStatus("認識エンジンの準備ができました。ENABLE CAMERAを押してください。");
    } catch (gpuError) {
      // Some mobile WebViews expose no compatible GPU delegate.  Continue
      // with on-device CPU/WASM inference rather than disabling the MVP.
      console.warn("Gesture Recognizer GPU delegate unavailable; using CPU.", gpuError);
      recognizer = await GestureRecognizer.createFromOptions(vision, {
        ...recognizerOptions,
        baseOptions: { modelAssetPath: GESTURE_MODEL_URL, delegate: "CPU" },
      });
      setStatus("認識エンジンを互換モードで準備しました。ENABLE CAMERAを押してください。");
    }
    ui.enableCamera.disabled = false;
  } catch (error) {
    setStatus(`MediaPipeの読み込みに失敗しました: ${error.message || error}`, true);
    ui.enableCamera.disabled = true;
  }
}

function updateOrientationHint() {
  const landscape = window.matchMedia("(orientation: landscape)").matches;
  ui.orientationHint.textContent = landscape
    ? "LANDSCAPE READY — 左右のプレイヤーを中央線で分けてください"
    : "横画面での利用を推奨します";
  ui.orientationHint.classList.toggle("landscape", landscape);
}

function bindEvents() {
  ui.enableCamera.addEventListener("click", enableCamera);
  ui.start.addEventListener("click", startTest);
  ui.auto.addEventListener("click", startAutoJudge);
  ui.reset.addEventListener("click", resetTest);
  ui.debugMode.addEventListener("change", () => {
    ui.debugDetails.hidden = !ui.debugMode.checked;
    if (!ui.debugMode.checked) {
      debugLines = [];
      ui.debugLog.textContent = "DEBUG MODEを有効にすると、ランドマーク・位置・割り当て・安定化状態を表示します。";
      context?.clearRect(0, 0, canvas.width, canvas.height);
    }
  });
  window.addEventListener("resize", () => {
    resizeOverlay();
    updateOrientationHint();
  });
  window.addEventListener("orientationchange", updateOrientationHint);
  ui.video.addEventListener("loadedmetadata", resizeOverlay);
}

bindEvents();
updateOrientationHint();
initialiseRecognizer();
