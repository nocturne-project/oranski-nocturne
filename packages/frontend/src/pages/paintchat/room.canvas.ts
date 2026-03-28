/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { MAX_LAYERS } from './room.types.js';
import type { PressurePoint, StrokeData, ToolType } from './room.types.js';

// キャンバスの描画エンジン。自動スムージング（Catmull-Romスプライン補間）、ストロークマージを担当する。

const MAX_UNDO = 3;

export interface DrawingState {
	isDrawing: boolean;
	currentPoints: PressurePoint[];
	currentTool: ToolType;
	currentColor: string;
	currentWidth: number;
	currentOpacity: number;
}

export interface CanvasEngine {
	// 初期化（メインcanvasを受け取り、レイヤーcanvasは内部で作成する）
	init(canvas: HTMLCanvasElement): void;
	// 描画状態
	getState(): DrawingState;
	setState(partial: Partial<DrawingState>): void;
	setPressureEnabled(enabled: boolean): void;
	// レイヤー操作
	getCurrentLayer(): number;
	setCurrentLayer(layer: number): void;
	getLayerOpacity(layer: number): number;
	setLayerOpacity(layer: number, opacity: number): void;
	// ストローク操作
	beginStroke(x: number, y: number, pressure: number): void;
	moveStroke(x: number, y: number, pressure: number): void;
	endStroke(): StrokeData | null;
	// リモートストロークの描画
	drawRemoteStroke(stroke: StrokeData): void;
	drawRemoteProgress(participantId: string, points: PressurePoint[]): void;
	// アンドゥ・リドゥ
	undo(): string | null;
	applyRemoteUndo(strokeId: string): void;
	// キャンバス操作
	clear(): void;
	redraw(): void;
	// マージ（フラット化）
	mergeOldStrokes(): string | null;
	// キャンバス復元（リロード時にRedisのストロークデータから再描画）
	restoreStrokes(savedStrokes: StrokeData[], mergedImageBase64?: string | null): Promise<void>;
	// 画像出力（全レイヤーを合成）
	toDataURL(type?: string): string;
	toMyStrokesDataURL(): string;
	// 破棄
	dispose(): void;
}

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

// ストロークを描画する（筆圧可変幅の滑らかな線）
// 筆圧による太さ変化は、短いセグメントごとに連続パスで描画して隙間をなくす
// 自分のストロークバッファ用: 消しゴムを白色ペンとして描画する（destination-outだと透明になりPNGで黒く表示されるバグ防止）
function renderStrokeForMyBuffer(ctx: CanvasRenderingContext2D, stroke: StrokeData): void {
	if (stroke.tool === 'eraser') {
		// 消しゴムを白色のペンストロークとして描画
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
function interpolatePoints(points: PressurePoint[]): PressurePoint[] {
	// Step 0: パス全体の歪み補正（移動平均フィルタ）
	// 入力時にはスムージングしないため、ここで完成した軌跡全体を滑らかにする
	const SMOOTH_PASSES = 3; // 適用回数（多いほど滑らか）
	const SMOOTH_RADIUS = 4; // 前後4ポイントの加重平均
	let smoothed = points.map(p => ({ ...p }));
	for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
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
	// ピクセル単位で密に配置し、円スタンプの隙間を完全に排除する
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
			// 間を補間して密にする
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
// 必ずオフスクリーンバッファ（opacity 1.0）上で呼ぶこと。直接描画するとボツボツになる。
function drawVariableWidthStroke(ctx: CanvasRenderingContext2D, interpolated: PressurePoint[], width: number, color: string, isEraser: boolean): void {
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	if (isEraser) {
		ctx.globalCompositeOperation = 'destination-out';
	} else {
		ctx.globalCompositeOperation = 'source-over';
		ctx.strokeStyle = color;
	}
	ctx.globalAlpha = 1.0;

	// 非対称エンベロープ方式の筆圧スムージング
	// 細くなる方向（筆圧低下）: 即座に反応
	// 太くなる方向（筆圧増加）: ゆっくり追従（バウンスバック防止）
	const smoothedPressures: number[] = [];
	let envPressure = interpolated[0].pressure * 0.3; // 書き始めは細く開始
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
	// オフスクリーンバッファ上(opacity 1.0)なので、lineCap:roundの重なりは見えない
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
// これにより筆圧による太さ変化を維持しつつ、半透明ストローク内の重なりボツボツを完全に排除
// bufferCanvas/bufferCtxは事前作成した一時canvasを使い回す（GC負荷削減）
function renderStroke(ctx: CanvasRenderingContext2D, stroke: StrokeData, bufferCanvas?: HTMLCanvasElement | null, bufferCtx?: CanvasRenderingContext2D | null): void {
	const points = stroke.points;
	if (points.length === 0) return;

	// 1点のみ: 円を描画
	if (points.length === 1) {
		ctx.save();
		const r = Math.max(1, stroke.width * points[0].pressure / 2);
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

	const interpolated = interpolatePoints(points);
	if (interpolated.length < 2) return;

	// 全ストローク（ペン・消しゴム共通）をオフスクリーンバッファ経由で描画
	// opacity 1.0のバッファ上でstroke()すると、同色重なりが見えないため滑らかになる
	if (bufferCanvas && bufferCtx) {
		bufferCtx.clearRect(0, 0, bufferCanvas.width, bufferCanvas.height);
		drawVariableWidthStroke(bufferCtx, interpolated, stroke.width, stroke.color, false);
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
		// フォールバック: 一時canvas作成（init前やmyStrokesバッファ等）
		const tc = window.document.createElement('canvas');
		tc.width = ctx.canvas.width;
		tc.height = ctx.canvas.height;
		const tctx = tc.getContext('2d')!;
		drawVariableWidthStroke(tctx, interpolated, stroke.width, stroke.color, false);
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

// キャンバスエンジンの生成（レイヤー対応）
export function createCanvasEngine(myParticipantId: string): CanvasEngine {
	// メインcanvas（合成結果の表示用）
	let canvas: HTMLCanvasElement | null = null;
	let ctx: CanvasRenderingContext2D | null = null;

	// レイヤーごとのオフスクリーンcanvas（各レイヤー独立）
	const layerCanvases: (HTMLCanvasElement | null)[] = [null, null, null];
	const layerCtxs: (CanvasRenderingContext2D | null)[] = [null, null, null];
	const layerOpacities: number[] = [1.0, 1.0, 1.0];

	// 現在の描画対象レイヤー
	let currentLayer = 0;

	// レイヤーごとのマージ済みベース画像
	const mergedImagePerLayer: (ImageData | null)[] = [null, null, null];

	// 自分のストローク専用オフスクリーンバッファ（レイヤーごとに分離、マージで消えない永続バッファ）
	const myLayerCanvases: (HTMLCanvasElement | null)[] = Array(MAX_LAYERS).fill(null);
	const myLayerCtxs: (CanvasRenderingContext2D | null)[] = Array(MAX_LAYERS).fill(null);
	const myMergedPerLayer: (ImageData | null)[] = Array(MAX_LAYERS).fill(null);
	// 後方互換: 旧コードから参照される箇所用
	let myStrokesCanvas: HTMLCanvasElement | null = null;
	let myStrokesCtx: CanvasRenderingContext2D | null = null;
	let myMergedImageData: ImageData | null = null;

	// 半透明ストローク用の一時canvas（使い回してGC負荷を削減）
	let tmpCanvas: HTMLCanvasElement | null = null;
	let tmpCtx: CanvasRenderingContext2D | null = null;

	// プレビュー描画のスロットリング用フラグ
	let pendingRedraw = false;

	// 筆圧ON/OFF（OFFの場合、全ポイントの筆圧を1.0固定にする）
	let pressureEnabled = true;

	// ストローク履歴（アンドゥ対象、全レイヤー共通）
	const strokes: StrokeData[] = [];

	// 描画状態
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
		return `${myParticipantId}-${Date.now()}-${strokeIdCounter++}`;
	}

	// 指定レイヤーのコンテキストを取得
	function getLayerCtx(layer: number): CanvasRenderingContext2D | null {
		if (layer < 0 || layer >= MAX_LAYERS) return null;
		return layerCtxs[layer];
	}

	// レイヤーcanvasを初期化する
	function initLayerCanvas(index: number, width: number, height: number): void {
		const c = window.document.createElement('canvas');
		c.width = width;
		c.height = height;
		const lctx = c.getContext('2d')!;
		// レイヤーは透明背景（合成時にメインcanvasの白背景の上に重ねる）
		lctx.clearRect(0, 0, width, height);
		layerCanvases[index] = c;
		layerCtxs[index] = lctx;
	}

	// レイヤー対応マージ: レイヤーごとにマージ済み画像を管理し、レイヤー順序を保持する
	function doMergeOldStrokes(): string | null {
		if (!canvas) return null;

		const myStrokes = strokes.filter(s => s.participantId === myParticipantId);
		if (myStrokes.length <= MAX_UNDO) return null;

		// マージ対象: 自分のアンドゥ対象外ストローク + 相手の全ストローク
		const toMerge = strokes.filter(s => {
			if (s.participantId !== myParticipantId) return true;
			const myIdx = myStrokes.indexOf(s);
			return myIdx < myStrokes.length - MAX_UNDO;
		});

		if (toMerge.length === 0) return null;

		// レイヤーごとにマージ
		for (let layer = 0; layer < MAX_LAYERS; layer++) {
			const lc = layerCanvases[layer];
			if (!lc) continue;
			const offscreen = window.document.createElement('canvas');
			offscreen.width = lc.width;
			offscreen.height = lc.height;
			const offCtx = offscreen.getContext('2d')!;

			// 既存のマージ済み画像があれば復元
			if (mergedImagePerLayer[layer]) {
				offCtx.putImageData(mergedImagePerLayer[layer]!, 0, 0);
			}

			// このレイヤーのマージ対象ストロークを描画
			for (const stroke of toMerge) {
				if ((stroke.layer ?? 0) === layer) {
					renderStroke(offCtx, stroke);
				}
			}

			mergedImagePerLayer[layer] = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
		}

		// 自分のストロークバッファのスナップショットも保存（レイヤーごと）
		for (let layer = 0; layer < MAX_LAYERS; layer++) {
			const mc = myLayerCanvases[layer];
			const mctx = myLayerCtxs[layer];
			if (mc && mctx) {
				myMergedPerLayer[layer] = mctx.getImageData(0, 0, mc.width, mc.height);
			}
		}

		// マージ済みストロークを配列から除去
		for (const stroke of toMerge) {
			const idx = strokes.indexOf(stroke);
			if (idx >= 0) strokes.splice(idx, 1);
		}

		redrawAll();
		return 'merged';
	}

	// 自分のストロークバッファを再構築する（アンドゥ時、レイヤーごと）
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
		// 後方互換: 旧マージ画像（レイヤー0）
		if (myMergedImageData && myLayerCtxs[0] && myLayerCanvases[0]) {
			myLayerCtxs[0]!.putImageData(myMergedImageData, 0, 0);
		}
		for (const stroke of strokes) {
			if (stroke.participantId === myParticipantId) {
				const mctx = myLayerCtxs[stroke.layer ?? 0];
				if (mctx) renderStroke(mctx, stroke);
			}
		}
	}

	// 各レイヤーを再描画し、メインcanvasに合成する
	function redrawAll(): void {
		if (!ctx || !canvas) return;

		// 1. 各レイヤーのオフスクリーンcanvasを再描画
		for (let layer = 0; layer < MAX_LAYERS; layer++) {
			const lctx = layerCtxs[layer];
			const lc = layerCanvases[layer];
			if (!lctx || !lc) continue;

			lctx.clearRect(0, 0, lc.width, lc.height);

			// マージ済み画像があればまず描画
			if (mergedImagePerLayer[layer]) {
				lctx.putImageData(mergedImagePerLayer[layer]!, 0, 0);
			}

			// このレイヤーの残りストロークを描画（一時canvasを使い回し）
			for (const stroke of strokes) {
				if ((stroke.layer ?? 0) === layer) {
					renderStroke(lctx, stroke, tmpCanvas, tmpCtx);
				}
			}
		}

		// 2. メインcanvasに合成（白背景 → レイヤー2(下) → 1 → 0(上)）
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

		// 3. 描画中プレビュー（高速1パスstroke方式。確定時にfill-based円スタンプで綺麗に再描画される）
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

		// 4. リモートの進行中描画（最上層に表示）
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

			// 白い背景で初期化
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, 0, canvas.width, canvas.height);

			// レイヤーcanvasを初期化
			for (let i = 0; i < MAX_LAYERS; i++) {
				initLayerCanvas(i, canvas.width, canvas.height);
			}

			// 自分のストローク専用バッファを初期化（レイヤーごとに透明背景）
			for (let i = 0; i < MAX_LAYERS; i++) {
				const mc = window.document.createElement('canvas');
				mc.width = canvas.width;
				mc.height = canvas.height;
				myLayerCanvases[i] = mc;
				myLayerCtxs[i] = mc.getContext('2d')!;
			}
			// 後方互換用（restoreStrokesの旧マージ画像復元等）
			myStrokesCanvas = myLayerCanvases[0];
			myStrokesCtx = myLayerCtxs[0];

			// 半透明ストローク用の一時canvasを事前作成（毎フレーム作成を避ける）
			tmpCanvas = window.document.createElement('canvas');
			tmpCanvas.width = canvas.width;
			tmpCanvas.height = canvas.height;
			tmpCtx = tmpCanvas.getContext('2d')!;
		},

		getState() {
			return { ...state };
		},

		setState(partial: Partial<DrawingState>) {
			Object.assign(state, partial);
		},

		setPressureEnabled(enabled: boolean) {
			pressureEnabled = enabled;
		},

		getCurrentLayer() {
			return currentLayer;
		},

		setCurrentLayer(layer: number) {
			if (layer >= 0 && layer < MAX_LAYERS) {
				currentLayer = layer;
			}
		},

		getLayerOpacity(layer: number): number {
			if (layer >= 0 && layer < MAX_LAYERS) return layerOpacities[layer];
			return 1.0;
		},

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

			// 誤タップ防止: 前のポイントと極端に離れている場合はストロークを切断
			if (state.currentPoints.length > 0) {
				const last = state.currentPoints[state.currentPoints.length - 1];
				const dx = x - last.x;
				const dy = y - last.y;
				const dist = Math.sqrt(dx * dx + dy * dy);
				if (dist > 200) {
					// 200px以上離れた点は誤タップとみなし、新しいストロークとして開始
					state.currentPoints = [{ x, y, pressure: p }];
					return;
				}
			}

			state.currentPoints.push({ x, y, pressure: p });

			// 高速差分プレビュー: 直近2ポイントをメインcanvasに直接描画
			// 確定時（endStroke→redrawAll）にfill-based円スタンプで綺麗に再描画される
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
				participantId: myParticipantId,
				points: [...state.currentPoints],
				color: state.currentColor,
				width: state.currentWidth,
				opacity: state.currentOpacity,
				tool: state.currentTool,
				layer: currentLayer,
			};

			strokes.push(stroke);
			state.currentPoints = [];

			// 自分のストローク専用バッファにも描画（レイヤー別、マージで消えない永続バッファ）
			if (stroke.participantId === myParticipantId) {
				const myCtx = myLayerCtxs[stroke.layer ?? 0];
				if (myCtx) renderStroke(myCtx, stroke);
			}

			// アンドゥ上限を超えたらマージ（FR-024/FR-025）
			// 同期実行: 非同期だとtoDataURL時にマージ未完了で出力がずれる
			const myStrokes = strokes.filter(s => s.participantId === myParticipantId);
			if (myStrokes.length > MAX_UNDO) {
				doMergeOldStrokes();
			}

			// 完全な再描画（スムージング適用）
			redrawAll();

			return stroke;
		},

		drawRemoteStroke(stroke: StrokeData) {
			strokes.push(stroke);
			// リモート進行中データをクリア
			remoteProgress.delete(stroke.participantId);
			redrawAll();
		},

		drawRemoteProgress(participantId: string, points: PressurePoint[]) {
			remoteProgress.set(participantId, points);
			redrawAll();
		},

		undo(): string | null {
			// 現在のレイヤーの自分の最後のストロークを削除
			for (let i = strokes.length - 1; i >= 0; i--) {
				if (strokes[i].participantId === myParticipantId && (strokes[i].layer ?? 0) === currentLayer) {
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
			// 全レイヤーcanvasもクリア
			for (let i = 0; i < MAX_LAYERS; i++) {
				const lc = layerCanvases[i];
				const lctx = layerCtxs[i];
				if (lc && lctx) lctx.clearRect(0, 0, lc.width, lc.height);
				const mc = myLayerCanvases[i];
				const mctx = myLayerCtxs[i];
				if (mc && mctx) mctx.clearRect(0, 0, mc.width, mc.height);
			}
		},

		redraw() {
			redrawAll();
		},

		// リロード時にRedisのストロークデータからキャンバスを復元する
		// Promise化して画像読み込み完了を待機し、レース条件を防止する
		async restoreStrokes(savedStrokes: StrokeData[], mergedImageBase64?: string | null) {
			// マージ済み画像があれば復元（レイヤー導入前のデータはレイヤー0として扱う）
			if (mergedImageBase64 && canvas) {
				await new Promise<void>((resolve) => {
					const img = new Image();
					img.onload = () => {
						if (!canvas) { resolve(); return; }
						const tmpCanvas = window.document.createElement('canvas');
						tmpCanvas.width = canvas.width;
						tmpCanvas.height = canvas.height;
						const tmpCtx = tmpCanvas.getContext('2d')!;
						tmpCtx.drawImage(img, 0, 0);
						mergedImagePerLayer[0] = tmpCtx.getImageData(0, 0, tmpCanvas.width, tmpCanvas.height);
						for (const stroke of savedStrokes) {
							strokes.push(stroke);
							if (stroke.participantId === myParticipantId) {
								const mctx = myLayerCtxs[stroke.layer ?? 0];
								if (mctx) renderStroke(mctx, stroke);
							}
						}
						// マージスナップショット保存
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
				// マージ済み画像なし: ストロークのみ復元
				for (const stroke of savedStrokes) {
					strokes.push(stroke);
					if (stroke.participantId === myParticipantId) {
						const mctx = myLayerCtxs[stroke.layer ?? 0];
						if (mctx) renderStroke(mctx, stroke);
					}
				}
				redrawAll();
			}
		},

		mergeOldStrokes(): string | null {
			return doMergeOldStrokes();
		},

		toDataURL(type = 'image/png'): string {
			// 出力前にレイヤーcanvasを最新状態に再描画
			if (!canvas || !ctx) return '';
			redrawAll();
			// 画面表示と同じレイヤー透明度で合成して出力（見た目通りの画像を生成）
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
			// 出力前にmyStrokesバッファを最新状態に再構築
			rebuildMyStrokesBuffer();
			// 自分のストロークを全レイヤー合成して出力（レイヤー透明度を反映）
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
			myStrokesCanvas = null;
			myStrokesCtx = null;
			myMergedImageData = null;
			tmpCanvas = null;
			tmpCtx = null;
			strokes.length = 0;
			remoteProgress.clear();
		},
	};
}
