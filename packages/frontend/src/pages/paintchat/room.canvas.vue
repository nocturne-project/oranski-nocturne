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
		:style="{ transform: `scale(${zoomLevel})`, transformOrigin: 'center center' }"
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

// キャンバスサイズ（800x600デフォルト）
const canvasWidth = 800;
const canvasHeight = 600;

// ズームレベル（0.5〜3倍）
const zoomLevel = ref(1);
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;

// 2本指ピンチズーム用の状態
let lastPinchDistance = 0;
let isPinching = false;

// 2本指ダブルタップでアンドゥ
let lastTwoFingerTapTime = 0;

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

function simulatePressure(x: number, y: number): number {
	const now = Date.now();
	const dt = now - lastTime;
	if (dt === 0 || lastTime === 0) {
		lastX = x;
		lastY = y;
		lastTime = now;
		return 0.5;
	}
	const dx = x - lastX;
	const dy = y - lastY;
	const speed = Math.sqrt(dx * dx + dy * dy) / dt;
	lastX = x;
	lastY = y;
	lastTime = now;
	// 速いほど細く、遅いほど太く
	return Math.max(0.2, Math.min(1.0, 1.0 - speed * 0.5));
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
	const { x, y } = getCanvasCoords(touch.clientX, touch.clientY);
	const pressure = simulatePressure(x, y);
	props.engine.beginStroke(x, y, pressure);
}

function onTouchMove(e: TouchEvent) {
	// 2本指ピンチズーム処理
	if (e.touches.length >= 2) {
		e.preventDefault();
		if (props.engine.getState().isDrawing) {
			props.engine.endStroke();
		}
		const dx = e.touches[0].clientX - e.touches[1].clientX;
		const dy = e.touches[0].clientY - e.touches[1].clientY;
		const distance = Math.sqrt(dx * dx + dy * dy);

		if (isPinching && lastPinchDistance > 0) {
			const scale = distance / lastPinchDistance;
			zoomLevel.value = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomLevel.value * scale));
		}
		lastPinchDistance = distance;
		isPinching = true;
		return;
	}
	e.preventDefault();
	const touch = e.touches[0];
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
	// ピンチ状態のリセット
	isPinching = false;
	lastPinchDistance = 0;

	const stroke = props.engine.endStroke();
	if (stroke) {
		emit('strokeEnd', stroke);
	}
	lastTime = 0;
}

// --- マウスイベント ---
let isMouseDown = false;

function onMouseDown(e: MouseEvent) {
	if (e.button !== 0) return;
	isMouseDown = true;
	const { x, y } = getCanvasCoords(e.clientX, e.clientY);
	const pressure = simulatePressure(x, y);
	props.engine.beginStroke(x, y, pressure);
}

function onMouseMove(e: MouseEvent) {
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
}

defineExpose({ zoomIn, zoomOut, zoomReset, zoomLevel });

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
