/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * グループチャットお絵描き - キャンバス描画エンジン
 * paintchatのroom.canvas.tsを移植。マルチユーザー対応（userId/userNameの保持、他ユーザーストロークの受信・描画）
 */

import { MAX_LAYERS } from './room.drawing.types.js';
import type { PressurePoint, StrokeData, DrawingState, CanvasEngine } from './room.drawing.types.js';

// アンドゥ上限（paintchat準拠: 3回）
const MAX_UNDO = 3;

// Catmull-Romスプライン補間による滑らかな曲線描画
function catmullRomPoint(
	p0: PressurePoint, p1: PressurePoint, p2: PressurePoint, p3: PressurePoint, t: number,
): PressurePoint {
	const t2 = t * t;
	const t3 = t2 * t;
	return {
		x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
		y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
		pressure: p1.pressure + (p2.pressure - p1.pressure) * t,
	};
}

// 消しゴムを白色ペンとして描画する（自分のストロークバッファ用）
// destination-outだと透明になりPNGで黒く表示されるバグ防止
function renderStrokeForMyBuffer(ctx: CanvasRenderingContext2D, stroke: StrokeData): void {
	if (stroke.tool === 'eraser') {
		const whiteStroke: StrokeData = {
			...stroke,
			tool: 'pen',
			color: '#ffffff',
			opacity: 1,
		};
		renderStroke(ctx, whiteStroke);
	} else {
		renderStroke(ctx, stroke);
	}
}

// 確定描画時にパス全体に歪み補正を適用してから補間・リサンプリングする
// smoothPasses: 移動平均フィルタの適用回数（0=歪み補正なし、指描きは入力時スムージング済みなので0）
function interpolatePoints(points: PressurePoint[], smoothPasses = 0): PressurePoint[] {
	// Step 0: パス全体の歪み補正（Apple Pencilなど入力時スムージングなしのデバイス用）
	const SMOOTH_RADIUS = 3;
	let smoothed = points.map(p => ({ ...p }));
	for (let pass = 0; pass < smoothPasses; pass++) {
		const next: PressurePoint[] = [];
		for (let i = 0; i < smoothed.length; i++) {
			let sx = 0, sy = 0, wSum = 0;
			for (let j = -SMOOTH_RADIUS; j <= SMOOTH_RADIUS; j++) {
				const idx = Math.max(0, Math.min(smoothed.length - 1, i + j));
				const w = 1 / (1 + Math.abs(j));
				sx += smoothed[idx].x * w;
				sy += smoothed[idx].y * w;
				wSum += w;
			}
			next.push({ x: sx / wSum, y: sy / wSum, pressure: smoothed[i].pressure });
		}
		smoothed = next;
	}

	// Step 1: Catmull-Rom補間で基本的なスムージング
	const coarse: PressurePoint[] = [];
	if (smoothed.length === 2) {
		for (let t = 0; t <= 1; t += 0.25) {
			coarse.push({
				x: smoothed[0].x + (smoothed[1].x - smoothed[0].x) * t,
				y: smoothed[0].y + (smoothed[1].y - smoothed[0].y) * t,
				pressure: smoothed[0].pressure + (smoothed[1].pressure - smoothed[0].pressure) * t,
			});
		}
	} else if (smoothed.length >= 3) {
		const steps = 10;
		for (let i = 0; i < smoothed.length - 1; i++) {
			const p0 = smoothed[Math.max(0, i - 1)];
			const p1 = smoothed[i];
			const p2 = smoothed[Math.min(smoothed.length - 1, i + 1)];
			const p3 = smoothed[Math.min(smoothed.length - 1, i + 2)];
			for (let step = 0; step <= steps; step++) {
				coarse.push(catmullRomPoint(p0, p1, p2, p3, step / steps));
			}
		}
	}
	if (coarse.length < 2) return coarse;

	// Step 2: 等距離リサンプリング（隣接ポイント間距離を最大0.5pxに制限）
	const MAX_SPACING = 0.5;
	const resampled: PressurePoint[] = [coarse[0]];
	for (let i = 1; i < coarse.length; i++) {
		const prev = coarse[i - 1];
		const curr = coarse[i];
		const dx = curr.x - prev.x;
		const dy = curr.y - prev.y;
		const dist = Math.sqrt(dx * dx + dy * dy);
		if (dist <= MAX_SPACING) {
			resampled.push(curr);
		} else {
			const subdivisions = Math.ceil(dist / MAX_SPACING);
			for (let j = 1; j <= subdivisions; j++) {
				const t = j / subdivisions;
				resampled.push({
					x: prev.x + dx * t,
					y: prev.y + dy * t,
					pressure: prev.pressure + (curr.pressure - prev.pressure) * t,
				});
			}
		}
	}
	return resampled;
}

// 可変幅ストロークをオフスクリーンバッファ上でstroke()方式で描画する
// opacity 1.0の同色stroke()重なりは視覚的に見えないため、セグメント別lineWidthが使える
function drawVariableWidthStroke(ctx: CanvasRenderingContext2D, interpolated: PressurePoint[], width: number, color: string, _isEraser: boolean): void {
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	ctx.globalCompositeOperation = 'source-over';
	ctx.strokeStyle = color;
	ctx.globalAlpha = 1.0;

	// 非対称エンベロープ方式の筆圧スムージング
	// 細くなる方向（筆圧低下）: 即座に反応 (RELEASE_RATE=0.6)
	// 太くなる方向（筆圧増加）: ゆっくり追従 (ATTACK_RATE=0.08)
	const smoothedPressures: number[] = [];
	let envPressure = interpolated[0].pressure * 0.3;
	const ATTACK_RATE = 0.08;
	const RELEASE_RATE = 0.6;
	for (let i = 0; i < interpolated.length; i++) {
		const raw = interpolated[i].pressure;
		if (raw > envPressure) {
			envPressure += (raw - envPressure) * ATTACK_RATE;
		} else {
			envPressure += (raw - envPressure) * RELEASE_RATE;
		}
		smoothedPressures.push(envPressure);
	}

	// 書き始め/書き終わりのフェードイン/フェードアウト（数珠防止）
	const FADE_POINTS = Math.min(15, Math.floor(interpolated.length * 0.1));
	for (let i = 0; i < FADE_POINTS; i++) {
		smoothedPressures[i] *= (i + 1) / (FADE_POINTS + 1);
	}
	for (let i = 0; i < FADE_POINTS; i++) {
		const idx = interpolated.length - 1 - i;
		if (idx >= 0) smoothedPressures[idx] *= (i + 1) / (FADE_POINTS + 1);
	}

	// セグメント別stroke: 各セグメントで筆圧に応じたlineWidth
	for (let i = 0; i < interpolated.length - 1; i++) {
		const p0 = interpolated[i];
		const p1 = interpolated[i + 1];
		const pressure = (smoothedPressures[i] + smoothedPressures[i + 1]) / 2;
		ctx.lineWidth = Math.max(0.5, width * pressure);
		ctx.beginPath();
		ctx.moveTo(p0.x, p0.y);
		ctx.lineTo(p1.x, p1.y);
		ctx.stroke();
	}
}

// オフスクリーンバッファ方式でストロークを描画する
// 1. 一時canvasにopacity 1.0で可変幅ストロークを描画
// 2. 対象canvasにglobalAlpha=stroke.opacityで合成
function renderStroke(ctx: CanvasRenderingContext2D, stroke: StrokeData, bufferCanvas?: HTMLCanvasElement | null, bufferCtx?: CanvasRenderingContext2D | null): void {
	const points = stroke.points;
	if (points.length === 0) return;

	const strokeWidth = stroke.width ?? stroke.strokeWidth ?? 5;

	// 1点のみ: 円を描画
	if (points.length === 1) {
		ctx.save();
		const r = Math.max(1, strokeWidth * points[0].pressure / 2);
		if (stroke.tool === 'eraser') {
			ctx.globalCompositeOperation = 'destination-out';
			ctx.globalAlpha = 1;
			ctx.fillStyle = 'black';
		} else {
			ctx.globalCompositeOperation = 'source-over';
			ctx.globalAlpha = stroke.opacity;
			ctx.fillStyle = stroke.color;
		}
		ctx.beginPath();
		ctx.arc(points[0].x, points[0].y, r, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();
		return;
	}

	// Apple Pencil: 入力時スムージングなし -> 確定時に歪み補正（1パス）
	// 指描き/マウス: 入力時スムージング済み -> 歪み補正不要（0パス）
	const smoothPasses = stroke.isHardwarePressure ? 1 : 0;
	const interpolated = interpolatePoints(points, smoothPasses);
	if (interpolated.length < 2) return;

	// 全ストロークをオフスクリーンバッファ経由で描画
	if (bufferCanvas && bufferCtx) {
		bufferCtx.clearRect(0, 0, bufferCanvas.width, bufferCanvas.height);
		drawVariableWidthStroke(bufferCtx, interpolated, strokeWidth, stroke.color, false);
		ctx.save();
		if (stroke.tool === 'eraser') {
			ctx.globalCompositeOperation = 'destination-out';
			ctx.globalAlpha = 1.0;
		} else {
			ctx.globalCompositeOperation = 'source-over';
			ctx.globalAlpha = stroke.opacity;
		}
		ctx.drawImage(bufferCanvas, 0, 0);
		ctx.restore();
	} else {
		const tc = window.document.createElement('canvas');
		tc.width = ctx.canvas.width;
		tc.height = ctx.canvas.height;
		const tctx = tc.getContext('2d')!;
		drawVariableWidthStroke(tctx, interpolated, strokeWidth, stroke.color, false);
		ctx.save();
		if (stroke.tool === 'eraser') {
			ctx.globalCompositeOperation = 'destination-out';
			ctx.globalAlpha = 1.0;
		} else {
			ctx.globalCompositeOperation = 'source-over';
			ctx.globalAlpha = stroke.opacity;
		}
		ctx.drawImage(tc, 0, 0);
		ctx.restore();
	}
}

// ユーザーIDからカーソル色を生成（HSL）
export function getUserCursorColor(userId: string): string {
	let hash = 0;
	for (let i = 0; i < userId.length; i++) {
		hash = ((hash << 5) - hash) + userId.charCodeAt(i);
		hash |= 0;
	}
	const hue = Math.abs(hash) % 360;
	return `hsl(${hue}, 70%, 50%)`;
}

// テキストコントラスト色を算出
export function getContrastColor(hslColor: string): string {
	const match = hslColor.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
	if (!match) return '#ffffff';
	const l = parseInt(match[3]);
	return l > 50 ? '#000000' : '#ffffff';
}

// キャンバスエンジンの生成（paintchatから移植、マルチユーザー対応）
export function createCanvasEngine(myUserId: string): CanvasEngine {
	let canvas: HTMLCanvasElement | null = null;
	let ctx: CanvasRenderingContext2D | null = null;

	const layerCanvases: (HTMLCanvasElement | null)[] = [null, null, null];
	const layerCtxs: (CanvasRenderingContext2D | null)[] = [null, null, null];
	const layerOpacities: number[] = [1.0, 1.0, 1.0];

	let currentLayer = 0;

	const mergedImagePerLayer: (ImageData | null)[] = [null, null, null];

	const myLayerCanvases: (HTMLCanvasElement | null)[] = Array(MAX_LAYERS).fill(null);
	const myLayerCtxs: (CanvasRenderingContext2D | null)[] = Array(MAX_LAYERS).fill(null);
	const myMergedPerLayer: (ImageData | null)[] = Array(MAX_LAYERS).fill(null);
	let myMergedImageData: ImageData | null = null;

	let tmpCanvas: HTMLCanvasElement | null = null;
	let tmpCtx: CanvasRenderingContext2D | null = null;

	let pressureEnabled = true;
	let currentStrokeIsHardwarePressure = false;

	const strokes: StrokeData[] = [];

	const state: DrawingState = {
		isDrawing: false,
		currentPoints: [],
		currentTool: 'pen',
		currentColor: '#000000',
		currentWidth: 5,
		currentOpacity: 1.0,
	};

	const remoteProgress: Map<string, PressurePoint[]> = new Map();
	let strokeIdCounter = 0;

	function generateStrokeId(): string {
		return `${myUserId}-${Date.now()}-${strokeIdCounter++}`;
	}

	function initLayerCanvas(index: number, width: number, height: number): void {
		const c = window.document.createElement('canvas');
		c.width = width;
		c.height = height;
		const lctx = c.getContext('2d')!;
		lctx.clearRect(0, 0, width, height);
		layerCanvases[index] = c;
		layerCtxs[index] = lctx;
	}

	// レイヤー対応マージ: 自分のアンドゥ対象外ストローク + 他ユーザーの全ストロークをマージ
	function doMergeOldStrokes(): string | null {
		if (!canvas) return null;

		const myStrokes = strokes.filter(s => (s.participantId ?? s.userId) === myUserId);
		if (myStrokes.length <= MAX_UNDO) return null;

		const toMerge = strokes.filter(s => {
			if ((s.participantId ?? s.userId) !== myUserId) return true;
			const myIdx = myStrokes.indexOf(s);
			return myIdx < myStrokes.length - MAX_UNDO;
		});

		if (toMerge.length === 0) return null;

		for (let layer = 0; layer < MAX_LAYERS; layer++) {
			const lc = layerCanvases[layer];
			if (!lc) continue;
			const offscreen = window.document.createElement('canvas');
			offscreen.width = lc.width;
			offscreen.height = lc.height;
			const offCtx = offscreen.getContext('2d')!;

			if (mergedImagePerLayer[layer]) {
				offCtx.putImageData(mergedImagePerLayer[layer]!, 0, 0);
			}

			for (const stroke of toMerge) {
				if ((stroke.layer ?? 0) === layer) {
					renderStroke(offCtx, stroke);
				}
			}

			mergedImagePerLayer[layer] = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
		}

		for (let layer = 0; layer < MAX_LAYERS; layer++) {
			const mc = myLayerCanvases[layer];
			const mctx = myLayerCtxs[layer];
			if (mc && mctx) {
				myMergedPerLayer[layer] = mctx.getImageData(0, 0, mc.width, mc.height);
			}
		}

		for (const stroke of toMerge) {
			const idx = strokes.indexOf(stroke);
			if (idx >= 0) strokes.splice(idx, 1);
		}

		redrawAll();
		return 'merged';
	}

	function rebuildMyStrokesBuffer(): void {
		for (let layer = 0; layer < MAX_LAYERS; layer++) {
			const mc = myLayerCanvases[layer];
			const mctx = myLayerCtxs[layer];
			if (!mc || !mctx) continue;
			mctx.clearRect(0, 0, mc.width, mc.height);
			if (myMergedPerLayer[layer]) {
				mctx.putImageData(myMergedPerLayer[layer]!, 0, 0);
			}
		}
		if (myMergedImageData && myLayerCtxs[0] && myLayerCanvases[0]) {
			myLayerCtxs[0]!.putImageData(myMergedImageData, 0, 0);
		}
		for (const stroke of strokes) {
			if ((stroke.participantId ?? stroke.userId) === myUserId) {
				const mctx = myLayerCtxs[stroke.layer ?? 0];
				if (mctx) renderStrokeForMyBuffer(mctx, stroke);
			}
		}
	}

	// 各レイヤーを再描画し、メインcanvasに合成する
	function redrawAll(): void {
		if (!ctx || !canvas) return;

		for (let layer = 0; layer < MAX_LAYERS; layer++) {
			const lctx = layerCtxs[layer];
			const lc = layerCanvases[layer];
			if (!lctx || !lc) continue;
			lctx.clearRect(0, 0, lc.width, lc.height);
			if (mergedImagePerLayer[layer]) {
				lctx.putImageData(mergedImagePerLayer[layer]!, 0, 0);
			}
			for (const stroke of strokes) {
				if ((stroke.layer ?? 0) === layer) {
					renderStroke(lctx, stroke, tmpCanvas, tmpCtx);
				}
			}
		}

		// メインcanvasに合成（白背景 -> レイヤー2(下) -> 1 -> 0(上)）
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		for (let layer = MAX_LAYERS - 1; layer >= 0; layer--) {
			const lc = layerCanvases[layer];
			if (!lc) continue;
			ctx.globalAlpha = layerOpacities[layer];
			ctx.drawImage(lc, 0, 0);
		}
		ctx.globalAlpha = 1.0;

		// 描画中プレビュー
		if (state.isDrawing && state.currentPoints.length >= 2) {
			ctx.save();
			ctx.lineCap = 'round';
			ctx.lineJoin = 'round';
			if (state.currentTool === 'eraser') {
				ctx.globalCompositeOperation = 'destination-out';
			} else {
				ctx.globalCompositeOperation = 'source-over';
				ctx.strokeStyle = state.currentColor;
				ctx.globalAlpha = state.currentOpacity;
			}
			const pts = state.currentPoints;
			const avgP = (pts[0].pressure + pts[pts.length - 1].pressure) / 2;
			ctx.lineWidth = Math.max(0.5, state.currentWidth * avgP);
			ctx.beginPath();
			ctx.moveTo(pts[0].x, pts[0].y);
			for (let i = 1; i < pts.length; i++) {
				ctx.lineTo(pts[i].x, pts[i].y);
			}
			ctx.stroke();
			ctx.restore();
		}

		// リモートの進行中描画
		for (const [, points] of remoteProgress) {
			if (points.length > 1) {
				ctx.beginPath();
				ctx.strokeStyle = '#cccccc';
				ctx.lineWidth = 2;
				ctx.globalAlpha = 0.5;
				ctx.moveTo(points[0].x, points[0].y);
				for (let i = 1; i < points.length; i++) {
					ctx.lineTo(points[i].x, points[i].y);
				}
				ctx.stroke();
				ctx.globalAlpha = 1.0;
			}
		}
	}

	return {
		init(c: HTMLCanvasElement) {
			canvas = c;
			ctx = c.getContext('2d')!;
			ctx.imageSmoothingEnabled = true;
			ctx.imageSmoothingQuality = 'high';
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, 0, canvas.width, canvas.height);

			for (let i = 0; i < MAX_LAYERS; i++) {
				initLayerCanvas(i, canvas.width, canvas.height);
			}
			for (let i = 0; i < MAX_LAYERS; i++) {
				const mc = window.document.createElement('canvas');
				mc.width = canvas.width;
				mc.height = canvas.height;
				myLayerCanvases[i] = mc;
				myLayerCtxs[i] = mc.getContext('2d')!;
			}
			tmpCanvas = window.document.createElement('canvas');
			tmpCanvas.width = canvas.width;
			tmpCanvas.height = canvas.height;
			tmpCtx = tmpCanvas.getContext('2d')!;
		},

		getState() { return { ...state }; },
		setState(partial: Partial<DrawingState>) { Object.assign(state, partial); },
		setPressureEnabled(enabled: boolean) { pressureEnabled = enabled; },
		setHardwarePressure(isHardware: boolean) { currentStrokeIsHardwarePressure = isHardware; },
		getCurrentLayer() { return currentLayer; },
		setCurrentLayer(layer: number) { if (layer >= 0 && layer < MAX_LAYERS) currentLayer = layer; },
		getLayerOpacity(layer: number): number { return (layer >= 0 && layer < MAX_LAYERS) ? layerOpacities[layer] : 1.0; },
		setLayerOpacity(layer: number, opacity: number) {
			if (layer >= 0 && layer < MAX_LAYERS) {
				layerOpacities[layer] = Math.max(0, Math.min(1, opacity));
				redrawAll();
			}
		},

		beginStroke(x: number, y: number, pressure: number) {
			state.isDrawing = true;
			const p = pressureEnabled ? pressure : 1.0;
			state.currentPoints = [{ x, y, pressure: p }];
		},

		moveStroke(x: number, y: number, pressure: number) {
			if (!state.isDrawing) return;
			const p = pressureEnabled ? pressure : 1.0;

			if (state.currentPoints.length > 0) {
				const last = state.currentPoints[state.currentPoints.length - 1];
				const dx = x - last.x;
				const dy = y - last.y;
				const dist = Math.sqrt(dx * dx + dy * dy);
				if (dist > 200) {
					state.currentPoints = [{ x, y, pressure: p }];
					return;
				}
			}

			state.currentPoints.push({ x, y, pressure: p });

			if (ctx && state.currentPoints.length >= 2) {
				const pts = state.currentPoints;
				const i = pts.length - 1;
				const p0 = pts[i - 1];
				const p1 = pts[i];
				ctx.save();
				ctx.lineCap = 'round';
				ctx.lineJoin = 'round';
				if (state.currentTool === 'eraser') {
					ctx.globalCompositeOperation = 'destination-out';
				} else {
					ctx.globalCompositeOperation = 'source-over';
					ctx.strokeStyle = state.currentColor;
					ctx.globalAlpha = state.currentOpacity;
				}
				const avgP = (p0.pressure + p1.pressure) / 2;
				ctx.lineWidth = Math.max(0.5, state.currentWidth * avgP);
				ctx.beginPath();
				ctx.moveTo(p0.x, p0.y);
				ctx.lineTo(p1.x, p1.y);
				ctx.stroke();
				ctx.restore();
			}
		},

		endStroke(): StrokeData | null {
			if (!state.isDrawing || state.currentPoints.length === 0 || !ctx || !canvas) {
				state.isDrawing = false;
				return null;
			}
			state.isDrawing = false;

			const stroke: StrokeData = {
				id: generateStrokeId(),
				participantId: myUserId,
				userId: myUserId,
				userName: '',
				points: [...state.currentPoints],
				color: state.currentColor,
				width: state.currentWidth,
				strokeWidth: state.currentWidth,
				opacity: state.currentOpacity,
				tool: state.currentTool,
				layer: currentLayer,
				isHardwarePressure: currentStrokeIsHardwarePressure,
				timestamp: Date.now(),
			};

			strokes.push(stroke);
			state.currentPoints = [];

			const myCtx = myLayerCtxs[stroke.layer ?? 0];
			if (myCtx) renderStrokeForMyBuffer(myCtx, stroke);

			const myStrokes = strokes.filter(s => (s.participantId ?? s.userId) === myUserId);
			if (myStrokes.length > MAX_UNDO) {
				doMergeOldStrokes();
			}

			redrawAll();
			return stroke;
		},

		drawRemoteStroke(stroke: StrokeData) {
			strokes.push(stroke);
			remoteProgress.delete(stroke.participantId ?? stroke.userId);
			redrawAll();
		},

		drawRemoteProgress(participantId: string, points: PressurePoint[]) {
			remoteProgress.set(participantId, points);
			redrawAll();
		},

		undo(): string | null {
			for (let i = strokes.length - 1; i >= 0; i--) {
				if ((strokes[i].participantId ?? strokes[i].userId) === myUserId && (strokes[i].layer ?? 0) === currentLayer) {
					const removed = strokes.splice(i, 1)[0];
					redrawAll();
					rebuildMyStrokesBuffer();
					return removed.id;
				}
			}
			return null;
		},

		applyRemoteUndo(strokeId: string) {
			const idx = strokes.findIndex(s => s.id === strokeId);
			if (idx >= 0) {
				strokes.splice(idx, 1);
				redrawAll();
			}
		},

		clear() {
			strokes.length = 0;
			for (let i = 0; i < MAX_LAYERS; i++) mergedImagePerLayer[i] = null;
			myMergedImageData = null;
			for (let i = 0; i < MAX_LAYERS; i++) myMergedPerLayer[i] = null;
			if (ctx && canvas) {
				ctx.clearRect(0, 0, canvas.width, canvas.height);
				ctx.fillStyle = '#ffffff';
				ctx.fillRect(0, 0, canvas.width, canvas.height);
			}
			for (let i = 0; i < MAX_LAYERS; i++) {
				const lc = layerCanvases[i];
				const lctx = layerCtxs[i];
				if (lc && lctx) lctx.clearRect(0, 0, lc.width, lc.height);
				const mc = myLayerCanvases[i];
				const mctx = myLayerCtxs[i];
				if (mc && mctx) mctx.clearRect(0, 0, mc.width, mc.height);
			}
		},

		redraw() { redrawAll(); },

		async restoreStrokes(savedStrokes: StrokeData[], mergedImageBase64?: string | null) {
			if (mergedImageBase64 && canvas) {
				await new Promise<void>((resolve) => {
					const img = new Image();
					img.onload = () => {
						if (!canvas) { resolve(); return; }
						const tc = window.document.createElement('canvas');
						tc.width = canvas.width;
						tc.height = canvas.height;
						const tctx = tc.getContext('2d')!;
						tctx.drawImage(img, 0, 0);
						mergedImagePerLayer[0] = tctx.getImageData(0, 0, tc.width, tc.height);
						for (const stroke of savedStrokes) {
							strokes.push(stroke);
							if ((stroke.participantId ?? stroke.userId) === myUserId) {
								const mctx = myLayerCtxs[stroke.layer ?? 0];
								if (mctx) renderStrokeForMyBuffer(mctx, stroke);
							}
						}
						for (let layer = 0; layer < MAX_LAYERS; layer++) {
							const mc = myLayerCanvases[layer];
							const mctx = myLayerCtxs[layer];
							if (mc && mctx) myMergedPerLayer[layer] = mctx.getImageData(0, 0, mc.width, mc.height);
						}
						redrawAll();
						resolve();
					};
					img.onerror = () => resolve();
					img.src = mergedImageBase64;
				});
			} else {
				for (const stroke of savedStrokes) {
					strokes.push(stroke);
					if ((stroke.participantId ?? stroke.userId) === myUserId) {
						const mctx = myLayerCtxs[stroke.layer ?? 0];
						if (mctx) renderStrokeForMyBuffer(mctx, stroke);
					}
				}
				redrawAll();
			}
		},

		mergeOldStrokes(): string | null { return doMergeOldStrokes(); },

		toDataURL(type = 'image/png'): string {
			if (!canvas || !ctx) return '';
			redrawAll();
			const exportCanvas = window.document.createElement('canvas');
			exportCanvas.width = canvas.width;
			exportCanvas.height = canvas.height;
			const ectx = exportCanvas.getContext('2d')!;
			ectx.fillStyle = '#ffffff';
			ectx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
			for (let layer = MAX_LAYERS - 1; layer >= 0; layer--) {
				const lc = layerCanvases[layer];
				if (!lc) continue;
				ectx.globalAlpha = layerOpacities[layer];
				ectx.drawImage(lc, 0, 0);
			}
			ectx.globalAlpha = 1.0;
			return exportCanvas.toDataURL(type);
		},

		toMyStrokesDataURL(): string {
			rebuildMyStrokesBuffer();
			if (!canvas) return '';
			const exportCanvas = window.document.createElement('canvas');
			exportCanvas.width = canvas.width;
			exportCanvas.height = canvas.height;
			const ectx = exportCanvas.getContext('2d')!;
			ectx.fillStyle = '#ffffff';
			ectx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
			for (let layer = MAX_LAYERS - 1; layer >= 0; layer--) {
				const mc = myLayerCanvases[layer];
				if (!mc) continue;
				ectx.globalAlpha = layerOpacities[layer];
				ectx.drawImage(mc, 0, 0);
			}
			ectx.globalAlpha = 1.0;
			return exportCanvas.toDataURL('image/png');
		},

		dispose() {
			canvas = null;
			ctx = null;
			for (let i = 0; i < MAX_LAYERS; i++) {
				layerCanvases[i] = null;
				layerCtxs[i] = null;
				myLayerCanvases[i] = null;
				myLayerCtxs[i] = null;
				myMergedPerLayer[i] = null;
			}
			myMergedImageData = null;
			tmpCanvas = null;
			tmpCtx = null;
			strokes.length = 0;
			remoteProgress.clear();
		},
	};
}

// テスト用にエクスポート
export { catmullRomPoint, interpolatePoints, renderStroke, drawVariableWidthStroke, MAX_UNDO };
