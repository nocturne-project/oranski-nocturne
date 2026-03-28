<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- キャンバスエリア。タッチ操作は全て描画入力として扱う。スクロール/ズーム無効化。 -->
<div
	ref="containerRef"
	:class="$style.canvasContainer"
	@touchstart="onTouchStart"
	@touchmove="onTouchMove"
	@touchend="onTouchEnd"
	@pointerdown="onPointerDown"
	@pointermove="onPointerMove"
	@pointerup="onPointerUp"
	@pointerleave="onPointerUp"
	@wheel.prevent="onWheel"
	@contextmenu.prevent
>
	<canvas
		ref="canvasRef"
		:class="$style.canvas"
		:width="canvasWidth"
		:height="canvasHeight"
		:style="{ transform: `translate(${panX}px, ${panY}px) scale(${zoomLevel})`, transformOrigin: 'center center' }"
	></canvas>
</div>
</template>

<script lang="ts" setup>
import { ref, onMounted, onUnmounted, watch } from 'vue';
import type { CanvasEngine } from './room.canvas.js';

const props = defineProps<{
	engine: CanvasEngine;
}>();

const emit = defineEmits<{
	(e: 'strokeEnd', stroke: any): void;
	(e: 'progress', points: any[]): void;
	(e: 'cursorMove', x: number, y: number): void;
	(e: 'eyedrop', color: string): void;
}>();

// スポイトモード（外部から設定）
const isEyedropperMode = ref(false);

function setEyedropperMode(enabled: boolean) {
	isEyedropperMode.value = enabled;
}

const containerRef = ref<HTMLDivElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);

// キャンバスサイズ（1600x1200: 高画質優先）
const canvasWidth = 1600;
const canvasHeight = 1200;

// ズームレベル（0.25〜6倍）
const zoomLevel = ref(1);
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 12;

// パン（移動）オフセット
const panX = ref(0);
const panY = ref(0);

// 移動モード（移動ツール選択時にtrue）
const isMoveMode = ref(false);

// 2本指ピンチズーム・パン用の状態
let lastPinchDistance = 0;
let lastPinchCenterX = 0;
let lastPinchCenterY = 0;
let isPinching = false;

// 2本指ダブルタップでアンドゥ
let lastTwoFingerTapTime = 0;

// ストローク開始の遅延（ドット防止: 移動検出後にbeginStroke）
let pendingStrokeStart: { x: number; y: number } | null = null;
let strokeStarted = false;
const STROKE_START_THRESHOLD = 3; // ピクセル: この距離以上動いたらストローク開始

// 手ブレ補正: 適応的スムージング（大きいほど追従が遅い。0.2=弱い, 0.5=強い）
const SMOOTHING_FACTOR = 0.4; // 指描き用（変更禁止: ユーザー承認済み 2026-03-28）
// Apple Pencilは入力時スムージングなし（確定描画時にパス全体で歪み補正する）
const MIN_MOVE_DISTANCE = 1.5; // この距離未満の移動はスキップ（ノイズ除去、指描き用）
let smoothedX = 0;
let smoothedY = 0;
let isSmoothingInitialized = false;

// カーソル移動のスロットル（50ms）
let lastCursorEmit = 0;

onMounted(() => {
	if (canvasRef.value) {
		props.engine.init(canvasRef.value);
	}
});

// タッチ座標をキャンバス座標に変換する（ズームレベルを考慮）
function getCanvasCoords(clientX: number, clientY: number): { x: number; y: number } {
	if (!canvasRef.value) return { x: 0, y: 0 };
	const rect = canvasRef.value.getBoundingClientRect();
	const scaleX = canvasWidth / rect.width;
	const scaleY = canvasHeight / rect.height;
	return {
		x: (clientX - rect.left) * scaleX,
		y: (clientY - rect.top) * scaleY,
	};
}

// 速度ベースの筆圧シミュレーション
let lastX = 0;
let lastY = 0;
let lastTime = 0;

// 筆圧シミュレーション: 書き始め/書き終わりを細く、中間を適度な太さに
// 玉（球状の太り）を防ぐため、フェードイン/アウトを強化
let strokePointCount = 0;
let lastPressure = 0.15;

// 筆圧シミュレーション（マウス/筆圧非対応デバイス/指描き用）
// 速度ベース: 速く描くと細く、ゆっくり描くと太く
function simulatePressure(x: number, y: number): number {
	const now = Date.now();
	const dt = now - lastTime;
	strokePointCount++;

	if (dt === 0 || lastTime === 0) {
		lastX = x;
		lastY = y;
		lastTime = now;
		lastPressure = 0.15;
		return 0.15;
	}
	const dx = x - lastX;
	const dy = y - lastY;
	const speed = Math.sqrt(dx * dx + dy * dy) / dt;
	lastX = x;
	lastY = y;
	lastTime = now;

	// 速度ベース筆圧（速いほど細く）
	let targetPressure = Math.max(0.15, Math.min(0.6, 0.5 - speed * 0.2));

	// 書き始め（最初の5ポイント）はゆっくりフェードイン
	if (strokePointCount <= 5) {
		targetPressure *= strokePointCount / 5;
	}

	// スムージング
	const smoothing = 0.3;
	lastPressure = lastPressure + (targetPressure - lastPressure) * smoothing;

	return Math.max(0.1, lastPressure);
}

// --- タッチイベント ---
// 1本指: 描画（preventDefaultでスクロール防止）
// 2本指以上: ブラウザのピンチズームに委ねる（preventDefaultしない）
function onTouchStart(e: TouchEvent) {
	// 2本指ダブルタップ検出 → アンドゥ
	if (e.touches.length === 2) {
		const now = Date.now();
		if (now - lastTwoFingerTapTime < 400) {
			// ダブルタップ: アンドゥ実行
			const strokeId = props.engine.undo();
			if (strokeId) {
				emit('strokeEnd', null as any); // undoシグナル
			}
			lastTwoFingerTapTime = 0;
		} else {
			lastTwoFingerTapTime = now;
		}
		return;
	}

	if (e.touches.length !== 1) return;
	// Apple Pencil（stylus）はPointerEvent経路で処理するため、touch経路ではスキップ
	if ((e.touches[0] as any).touchType === 'stylus') return;
	e.preventDefault();
	const touch = e.touches[0];

	// 移動モード時は描画ではなくパン操作
	if (isMoveMode.value) {
		lastPinchCenterX = touch.clientX;
		lastPinchCenterY = touch.clientY;
		return;
	}

	// スポイトモード時はピクセル色を取得
	if (isEyedropperMode.value) {
		const color = getPixelColor(touch.clientX, touch.clientY);
		if (color) emit('eyedrop', color);
		return;
	}

	// ストローク開始を遅延（2本指パンへの切替時にドットが描かれるのを防止）
	// touchMoveで一定距離以上動いたら実際にbeginStrokeする
	pendingStrokeStart = { x: touch.clientX, y: touch.clientY };
	strokeStarted = false;
}

function onTouchMove(e: TouchEvent) {
	// 2本指: ピンチズーム + パン（移動）同時操作
	if (e.touches.length >= 2) {
		e.preventDefault();
		if (props.engine.getState().isDrawing) {
			props.engine.endStroke();
		}
		const dx = e.touches[0].clientX - e.touches[1].clientX;
		const dy = e.touches[0].clientY - e.touches[1].clientY;
		const distance = Math.sqrt(dx * dx + dy * dy);
		const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
		const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

		if (isPinching && lastPinchDistance > 0) {
			const scale = distance / lastPinchDistance;
			const oldZoom = zoomLevel.value;
			const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldZoom * scale));
			zoomLevel.value = newZoom;

			// ズーム中心点からの拡大: ピンチ中心を基準にパンを補正
			if (containerRef.value) {
				const rect = containerRef.value.getBoundingClientRect();
				const pivotX = centerX - rect.left - rect.width / 2;
				const pivotY = centerY - rect.top - rect.height / 2;
				const zoomRatio = newZoom / oldZoom;
				panX.value = pivotX - (pivotX - panX.value) * zoomRatio;
				panY.value = pivotY - (pivotY - panY.value) * zoomRatio;
			}

			// パン（2本指の中心の移動量）
			panX.value += centerX - lastPinchCenterX;
			panY.value += centerY - lastPinchCenterY;
		}
		lastPinchDistance = distance;
		lastPinchCenterX = centerX;
		lastPinchCenterY = centerY;
		isPinching = true;
		return;
	}
	// Apple Pencil（stylus）はPointerEvent経路で処理
	if ((e.touches[0] as any).touchType === 'stylus') return;
	e.preventDefault();
	const touch = e.touches[0];

	// 移動モード時はパン操作
	if (isMoveMode.value) {
		panX.value += touch.clientX - lastPinchCenterX;
		panY.value += touch.clientY - lastPinchCenterY;
		lastPinchCenterX = touch.clientX;
		lastPinchCenterY = touch.clientY;
		return;
	}

	// ストローク開始の遅延処理: 一定距離以上動いたらbeginStroke
	if (pendingStrokeStart && !strokeStarted) {
		const dx = touch.clientX - pendingStrokeStart.x;
		const dy = touch.clientY - pendingStrokeStart.y;
		if (Math.sqrt(dx * dx + dy * dy) < STROKE_START_THRESHOLD) return; // まだ動いていない
		// 十分動いたのでストローク開始（指描き: ハードウェア筆圧なし）
		props.engine.setHardwarePressure(false);
		const startCoords = getCanvasCoords(pendingStrokeStart.x, pendingStrokeStart.y);
		const startPressure = simulatePressure(startCoords.x, startCoords.y);
		props.engine.beginStroke(startCoords.x, startCoords.y, startPressure);
		smoothedX = startCoords.x;
		smoothedY = startCoords.y;
		isSmoothingInitialized = true;
		strokeStarted = true;
		pendingStrokeStart = null;
	}

	if (!strokeStarted) return;

	const { x, y } = getCanvasCoords(touch.clientX, touch.clientY);

	// 手ブレ補正: 適応的スムージング
	if (isSmoothingInitialized) {
		smoothedX = smoothedX + (x - smoothedX) * (1 - SMOOTHING_FACTOR);
		smoothedY = smoothedY + (y - smoothedY) * (1 - SMOOTHING_FACTOR);
	} else {
		smoothedX = x;
		smoothedY = y;
		isSmoothingInitialized = true;
	}

	// 最小移動距離フィルタ（ノイズ除去）
	const moveDist = Math.sqrt((smoothedX - x) * (smoothedX - x) + (smoothedY - y) * (smoothedY - y));
	const pressure = simulatePressure(smoothedX, smoothedY);
	props.engine.moveStroke(smoothedX, smoothedY, pressure);

	const now = Date.now();
	if (now - lastCursorEmit > 50) {
		lastCursorEmit = now;
		emit('cursorMove', x, y);
		emit('progress', props.engine.getState().currentPoints);
	}
}

function onTouchEnd() {
	isPinching = false;
	lastPinchDistance = 0;
	pendingStrokeStart = null;

	if (strokeStarted) {
		const stroke = props.engine.endStroke();
		if (stroke) {
			emit('strokeEnd', stroke);
		}
	}
	strokeStarted = false;
	isSmoothingInitialized = false;
	lastTime = 0;
	strokePointCount = 0;
}

// --- PointerEvent（マウス+スタイラス筆圧対応） ---
// ハードウェア筆圧が利用可能な場合はそれを使用し、そうでなければ速度ベースのシミュレーションを使用
let isPointerDown = false;
let hasHardwarePressure = false;
let lastHwPressure = 0.5; // ハードウェア筆圧のスムージング用

function getEffectivePressure(e: PointerEvent, x: number, y: number): number {
	// ハードウェア筆圧が利用可能な場合（スタイラスペン等）
	if (e.pressure > 0 && e.pressure < 1 && e.pointerType !== 'mouse') {
		hasHardwarePressure = true;
		// 筆圧スムージング: 急激な変化を抑えてドットを防止
		const smoothFactor = 0.35;
		lastHwPressure = lastHwPressure + (e.pressure - lastHwPressure) * (1 - smoothFactor);
		// 最低筆圧を保証（極端に細い線やドットを防止）
		return Math.max(0.08, lastHwPressure);
	}
	// マウスまたは筆圧非対応デバイスの場合は速度ベースシミュレーション
	return simulatePressure(x, y);
}

// 右クリック中の一時消しゴムモード
let isRightButtonEraser = false;
let savedToolBeforeRightClick: string | null = null;

function onPointerDown(e: PointerEvent) {
	// タッチイベントはtouchStart/touchMoveで処理するので、ここではペン/マウスのみ
	if (e.pointerType === 'touch') return;

	// 右クリック（button=2）またはペン消しゴム端（button=5）: 一時的に消しゴムモードで描画
	if (e.button === 2 || e.button === 5) {
		e.preventDefault();
		isPointerDown = true;
		isRightButtonEraser = true;
		savedToolBeforeRightClick = props.engine.getState().currentTool;
		props.engine.setState({ currentTool: 'eraser' });
		hasHardwarePressure = false;
		lastHwPressure = 0.5;
		const { x, y } = getCanvasCoords(e.clientX, e.clientY);
		const pressure = getEffectivePressure(e, x, y);
		props.engine.beginStroke(x, y, pressure);
		return;
	}
	if (e.button !== 0) return;
	isPointerDown = true;
	isRightButtonEraser = false;
	hasHardwarePressure = false;
	lastHwPressure = 0.5;

	if (isMoveMode.value) {
		lastPinchCenterX = e.clientX;
		lastPinchCenterY = e.clientY;
		return;
	}

	if (isEyedropperMode.value) {
		const color = getPixelColor(e.clientX, e.clientY);
		if (color) emit('eyedrop', color);
		return;
	}

	const { x, y } = getCanvasCoords(e.clientX, e.clientY);

	// ハードウェア筆圧フラグ（Apple Pencil等のペンデバイス）
	props.engine.setHardwarePressure(e.pointerType === 'pen');

	// マウスの場合: ストローク開始遅延（ドット防止）
	if (e.pointerType === 'mouse') {
		pendingStrokeStart = { x, y };
		strokeStarted = false;
		isSmoothingInitialized = false;
		lastTime = 0;
		strokePointCount = 0;
	} else {
		// ペン（スタイラス）の場合もストローク開始遅延（ドット防止）
		pendingStrokeStart = { x, y };
		strokeStarted = false;
		isSmoothingInitialized = false;
		lastTime = 0;
		strokePointCount = 0;
	}
}

function onPointerMove(e: PointerEvent) {
	if (e.pointerType === 'touch') return;

	if (isPointerDown && isMoveMode.value) {
		panX.value += e.clientX - lastPinchCenterX;
		panY.value += e.clientY - lastPinchCenterY;
		lastPinchCenterX = e.clientX;
		lastPinchCenterY = e.clientY;
		return;
	}

	const { x, y } = getCanvasCoords(e.clientX, e.clientY);

	if (isPointerDown) {
		// ストローク開始遅延チェック（マウス・ペン共通、ドット防止）
		if (pendingStrokeStart) {
			const dx = x - pendingStrokeStart.x;
			const dy = y - pendingStrokeStart.y;
			if (Math.sqrt(dx * dx + dy * dy) < STROKE_START_THRESHOLD) return;
			const startCoords = pendingStrokeStart;
			pendingStrokeStart = null;
			strokeStarted = true;
			smoothedX = startCoords.x;
			smoothedY = startCoords.y;
			isSmoothingInitialized = true;
			const startPressure = getEffectivePressure(e, startCoords.x, startCoords.y);
			props.engine.beginStroke(startCoords.x, startCoords.y, startPressure);
		}

		// 手ブレ補正（ペンは入力時スムージングなし。確定描画時にパス全体で歪み補正する）
		const sf = e.pointerType === 'pen' ? 0 : SMOOTHING_FACTOR;
		if (isSmoothingInitialized) {
			smoothedX = smoothedX + (x - smoothedX) * (1 - sf);
			smoothedY = smoothedY + (y - smoothedY) * (1 - sf);
		} else {
			smoothedX = x;
			smoothedY = y;
			isSmoothingInitialized = true;
		}


		const pressure = getEffectivePressure(e, smoothedX, smoothedY);
		props.engine.moveStroke(smoothedX, smoothedY, pressure);

		const now = Date.now();
		if (now - lastCursorEmit > 50) {
			lastCursorEmit = now;
			emit('cursorMove', x, y);
			emit('progress', props.engine.getState().currentPoints);
		}
	}
}

function onPointerUp(e: PointerEvent) {
	if (e.pointerType === 'touch') return;
	if (!isPointerDown) return;
	isPointerDown = false;
	pendingStrokeStart = null;
	if (strokeStarted || e.pointerType !== 'mouse') {
		const stroke = props.engine.endStroke();
		if (stroke) {
			emit('strokeEnd', stroke);
		}
	}
	strokeStarted = false;
	// 右クリック消しゴムモードを解除して元のツールに復元
	if (isRightButtonEraser && savedToolBeforeRightClick != null) {
		props.engine.setState({ currentTool: savedToolBeforeRightClick as any });
		savedToolBeforeRightClick = null;
		isRightButtonEraser = false;
	}
	lastTime = 0;
	strokePointCount = 0;
	hasHardwarePressure = false;
	isSmoothingInitialized = false;
}

// --- マウスホイールズーム（カーソル位置基準） ---
function onWheel(e: WheelEvent) {
	const oldZoom = zoomLevel.value;
	const delta = e.deltaY > 0 ? -0.1 : 0.1;
	const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldZoom + delta));
	zoomLevel.value = newZoom;

	// カーソル位置を基準にパンを補正
	if (containerRef.value && oldZoom !== newZoom) {
		const rect = containerRef.value.getBoundingClientRect();
		const pivotX = e.clientX - rect.left - rect.width / 2;
		const pivotY = e.clientY - rect.top - rect.height / 2;
		const zoomRatio = newZoom / oldZoom;
		panX.value = pivotX - (pivotX - panX.value) * zoomRatio;
		panY.value = pivotY - (pivotY - panY.value) * zoomRatio;
	}
}

// 外部からズーム操作するためのメソッド
function zoomIn() {
	zoomLevel.value = Math.min(MAX_ZOOM, zoomLevel.value + 0.25);
}

function zoomOut() {
	zoomLevel.value = Math.max(MIN_ZOOM, zoomLevel.value - 0.25);
}

function zoomReset() {
	zoomLevel.value = 1;
	panX.value = 0;
	panY.value = 0;
}

function setMoveMode(enabled: boolean) {
	isMoveMode.value = enabled;
}

// スポイト用: 指定座標のピクセル色を取得する
function getPixelColor(clientX: number, clientY: number): string | null {
	if (!canvasRef.value) return null;
	const ctx = canvasRef.value.getContext('2d');
	if (!ctx) return null;
	const { x, y } = getCanvasCoords(clientX, clientY);
	const pixel = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
	return `#${pixel[0].toString(16).padStart(2, '0')}${pixel[1].toString(16).padStart(2, '0')}${pixel[2].toString(16).padStart(2, '0')}`;
}

defineExpose({ zoomIn, zoomOut, zoomReset, zoomLevel, setMoveMode, setEyedropperMode, getPixelColor });

onUnmounted(() => {
	props.engine.dispose();
});
</script>

<style lang="scss" module>
.canvasContainer {
	width: 100%;
	height: 100%;
	display: flex;
	align-items: center;
	justify-content: center;
	background: #f0f0f0;
	touch-action: none; // JSで1本指描画/2本指ピンチを制御
	user-select: none;
	-webkit-user-select: none;
	overflow: hidden;
}

.canvas {
	max-width: 100%;
	max-height: 100%;
	background: white;
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}
</style>
