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
	@mousedown="onMouseDown"
	@mousemove="onMouseMove"
	@mouseup="onMouseUp"
	@mouseleave="onMouseUp"
	@wheel.prevent="onWheel"
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
}>();

const containerRef = ref<HTMLDivElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);

// キャンバスサイズ（1600x1200: 高画質優先）
const canvasWidth = 1600;
const canvasHeight = 1200;

// ズームレベル（0.25〜6倍）
const zoomLevel = ref(1);
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;

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
let strokePointCount = 0;

function simulatePressure(x: number, y: number): number {
	const now = Date.now();
	const dt = now - lastTime;
	strokePointCount++;

	if (dt === 0 || lastTime === 0) {
		lastX = x;
		lastY = y;
		lastTime = now;
		// 書き始めは細く
		return 0.3;
	}
	const dx = x - lastX;
	const dy = y - lastY;
	const speed = Math.sqrt(dx * dx + dy * dy) / dt;
	lastX = x;
	lastY = y;
	lastTime = now;

	// ベース筆圧: 速度ベース（速いほど細く）
	let pressure = Math.max(0.2, Math.min(0.8, 0.7 - speed * 0.3));

	// 書き始め（最初の3ポイント）はフェードイン
	if (strokePointCount <= 3) {
		pressure *= strokePointCount / 3;
	}

	return pressure;
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
	e.preventDefault();
	const touch = e.touches[0];

	// 移動モード時は描画ではなくパン操作
	if (isMoveMode.value) {
		lastPinchCenterX = touch.clientX;
		lastPinchCenterY = touch.clientY;
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
			// ズーム
			const scale = distance / lastPinchDistance;
			zoomLevel.value = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomLevel.value * scale));
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
		// 十分動いたのでストローク開始
		const startCoords = getCanvasCoords(pendingStrokeStart.x, pendingStrokeStart.y);
		const startPressure = simulatePressure(startCoords.x, startCoords.y);
		props.engine.beginStroke(startCoords.x, startCoords.y, startPressure);
		strokeStarted = true;
		pendingStrokeStart = null;
	}

	if (!strokeStarted) return;

	const { x, y } = getCanvasCoords(touch.clientX, touch.clientY);
	const pressure = simulatePressure(x, y);
	props.engine.moveStroke(x, y, pressure);

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
	lastTime = 0;
	strokePointCount = 0;
}

// --- マウスイベント ---
let isMouseDown = false;

function onMouseDown(e: MouseEvent) {
	if (e.button !== 0) return;
	isMouseDown = true;

	if (isMoveMode.value) {
		lastPinchCenterX = e.clientX;
		lastPinchCenterY = e.clientY;
		return;
	}

	const { x, y } = getCanvasCoords(e.clientX, e.clientY);
	const pressure = simulatePressure(x, y);
	props.engine.beginStroke(x, y, pressure);
}

function onMouseMove(e: MouseEvent) {
	if (isMouseDown && isMoveMode.value) {
		panX.value += e.clientX - lastPinchCenterX;
		panY.value += e.clientY - lastPinchCenterY;
		lastPinchCenterX = e.clientX;
		lastPinchCenterY = e.clientY;
		return;
	}

	const { x, y } = getCanvasCoords(e.clientX, e.clientY);

	if (isMouseDown) {
		const pressure = simulatePressure(x, y);
		props.engine.moveStroke(x, y, pressure);

		const now = Date.now();
		if (now - lastCursorEmit > 50) {
			lastCursorEmit = now;
			emit('cursorMove', x, y);
			emit('progress', props.engine.getState().currentPoints);
		}
	}
}

function onMouseUp() {
	if (!isMouseDown) return;
	isMouseDown = false;
	const stroke = props.engine.endStroke();
	if (stroke) {
		emit('strokeEnd', stroke);
	}
	lastTime = 0;
	strokePointCount = 0;
}

// --- マウスホイールズーム ---
function onWheel(e: WheelEvent) {
	const delta = e.deltaY > 0 ? -0.1 : 0.1;
	zoomLevel.value = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomLevel.value + delta));
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

defineExpose({ zoomIn, zoomOut, zoomReset, zoomLevel, setMoveMode });

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
