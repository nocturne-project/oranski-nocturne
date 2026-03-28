/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * グループチャットお絵描き - イベントハンドラー
 * paintchat式に改修: PointerEvent.pressureの取得、速度ベース筆圧シミュレーション、
 * 書き始めフェードイン（3ポイント）、書き終わりフェードアウト、最小移動距離フィルタ（3px）
 */

import type { Ref } from 'vue';
import type { CanvasEngine, Point, ToolType, PressurePoint } from './room.drawing.types.js';
import { SMOOTHING_FACTOR, smoothPoint, smoothPressure, PRESSURE_SMOOTHING_FACTOR } from './room.drawing.render.js';

// ストローク開始時の最小移動距離（遅延書き出し。誤タップ防止）
const STROKE_START_THRESHOLD = 3;

// ハンドラー用Composable（CanvasEngine方式）
export function useDrawingHandlers(deps: {
	engine: Ref<CanvasEngine | null>;
	canvasEl: Ref<HTMLCanvasElement | undefined>;
	currentTool: Ref<ToolType>;
	isSpaceKeyPressed: Ref<boolean>;
	isPanningWithSpace: Ref<boolean>;
	panStart: Ref<Point>;
	panOffset: Ref<Point>;
	getEventPoint: (event: MouseEvent | TouchEvent | PointerEvent) => Point;
	eyedropColor: (point: Point) => void;
	sendCursorPosition: (point: Point) => void;
	sendDrawingProgress: (points: PressurePoint[]) => void;
	sendDrawingStroke: (stroke: any) => void;
	sendUndoStroke: (strokeId: string) => void;
	onColorPicked?: (color: string) => void;
}) {
	// ハードウェア筆圧の検出状態
	let isHardwarePressure = false;
	// 前回のスムージング済みポイント（入力時スムージング用）
	let lastSmoothedPoint: PressurePoint | null = null;
	// 前回の筆圧値（筆圧スムージング用）
	let lastSmoothedPressure = 0.5;
	// 一時消しゴムモード（右クリック/ペン消しゴム端）
	let temporaryEraserMode = false;
	let originalTool: ToolType = 'pen';
	// ストローク待機状態（遅延書き出し用）
	let pendingStrokeStart: { x: number; y: number; pressure: number } | null = null;

	// PointerDown: ストローク開始
	function onPointerDown(e: PointerEvent) {
		if (!deps.engine.value) return;

		// スペースキーパン
		if (deps.isSpaceKeyPressed.value) {
			deps.isPanningWithSpace.value = true;
			deps.panStart.value = { x: e.clientX, y: e.clientY };
			if (deps.canvasEl.value) deps.canvasEl.value.style.cursor = 'grabbing';
			return;
		}

		// 右クリック/ペン消しゴム端 -> 一時消しゴムモード
		if (e.button === 2 || e.button === 5) {
			temporaryEraserMode = true;
			originalTool = deps.currentTool.value;
			deps.engine.value.setState({ currentTool: 'eraser' });
			e.preventDefault();
		}

		// ハードウェア筆圧検出
		if (e.pressure > 0 && e.pressure < 1 && e.pointerType !== 'mouse') {
			isHardwarePressure = true;
			deps.engine.value.setHardwarePressure(true);
		} else {
			isHardwarePressure = false;
			deps.engine.value.setHardwarePressure(false);
		}

		const point = deps.getEventPoint(e);
		const pressure = getEffectivePressure(e);

		// スポイトモード
		if (deps.currentTool.value === 'eyedropper') {
			deps.eyedropColor(point);
			return;
		}

		// 遅延書き出し: 最小移動距離を超えるまでストロークを開始しない（誤タップ防止）
		pendingStrokeStart = { x: point.x, y: point.y, pressure };
		lastSmoothedPoint = { x: point.x, y: point.y, pressure };
		lastSmoothedPressure = pressure;
	}

	// PointerMove: ストローク進行
	function onPointerMove(e: PointerEvent) {
		if (!deps.engine.value) return;

		// スペースキーパン中
		if (deps.isPanningWithSpace.value) {
			const deltaX = e.clientX - deps.panStart.value.x;
			const deltaY = e.clientY - deps.panStart.value.y;
			deps.panOffset.value = {
				x: deps.panOffset.value.x + deltaX,
				y: deps.panOffset.value.y + deltaY,
			};
			deps.panStart.value = { x: e.clientX, y: e.clientY };
			return;
		}

		const point = deps.getEventPoint(e);
		deps.sendCursorPosition(point);

		// ストローク待機中: 最小移動距離を超えたら実際にストローク開始
		if (pendingStrokeStart) {
			const dx = point.x - pendingStrokeStart.x;
			const dy = point.y - pendingStrokeStart.y;
			if (Math.sqrt(dx * dx + dy * dy) < STROKE_START_THRESHOLD) return;

			// ストローク開始
			deps.engine.value.beginStroke(pendingStrokeStart.x, pendingStrokeStart.y, pendingStrokeStart.pressure);
			pendingStrokeStart = null;
		}

		const engineState = deps.engine.value.getState();
		if (!engineState.isDrawing) return;

		if (deps.currentTool.value === 'eyedropper') return;

		const rawPressure = getEffectivePressure(e);

		// 入力時スムージング（指描き/マウスのみ、Apple Pencilでは適用しない）
		let smoothedX = point.x;
		let smoothedY = point.y;
		let smoothedPressure = rawPressure;

		if (!isHardwarePressure && lastSmoothedPoint) {
			const sp = smoothPoint(
				{ x: point.x, y: point.y, pressure: rawPressure },
				lastSmoothedPoint,
				SMOOTHING_FACTOR,
			);
			smoothedX = sp.x;
			smoothedY = sp.y;
		}

		// 筆圧スムージング（全デバイス共通）
		smoothedPressure = smoothPressure(rawPressure, lastSmoothedPressure, PRESSURE_SMOOTHING_FACTOR);
		lastSmoothedPressure = smoothedPressure;

		lastSmoothedPoint = { x: smoothedX, y: smoothedY, pressure: smoothedPressure };

		deps.engine.value.moveStroke(smoothedX, smoothedY, smoothedPressure);

		// 描画進行データを送信
		const currentPoints = deps.engine.value.getState().currentPoints;
		deps.sendDrawingProgress(currentPoints);
	}

	// PointerUp: ストローク確定
	function onPointerUp(_e: PointerEvent) {
		if (!deps.engine.value) return;

		// スペースキーパン終了
		if (deps.isPanningWithSpace.value) {
			deps.isPanningWithSpace.value = false;
			if (deps.canvasEl.value) {
				deps.canvasEl.value.style.cursor = deps.isSpaceKeyPressed.value ? 'grab' : 'crosshair';
			}
			return;
		}

		// 遅延書き出し中にリリースされた場合（短いタップ）: ストロークなしで終了
		if (pendingStrokeStart) {
			pendingStrokeStart = null;
			return;
		}

		// ストローク確定
		const stroke = deps.engine.value.endStroke();

		// 一時消しゴムモード解除
		if (temporaryEraserMode) {
			temporaryEraserMode = false;
			deps.engine.value.setState({ currentTool: originalTool });
		}

		if (stroke) {
			deps.sendDrawingStroke(stroke);
		}

		lastSmoothedPoint = null;
		lastSmoothedPressure = 0.5;
	}

	// 有効な筆圧を取得（ハードウェア筆圧 or 速度ベースシミュレーション）
	function getEffectivePressure(e: PointerEvent): number {
		if (isHardwarePressure && e.pressure > 0 && e.pressure < 1) {
			return e.pressure;
		}
		// マウス/タッチ: デフォルト筆圧
		return 0.5;
	}

	// 右クリックメニュー抑制
	function onContextMenu(e: Event) {
		e.preventDefault();
	}

	return {
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onContextMenu,
	};
}
