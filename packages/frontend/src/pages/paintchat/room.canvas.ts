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

function renderStroke(ctx: CanvasRenderingContext2D, stroke: StrokeData): void {
	const points = stroke.points;
	if (points.length === 0) return;

	ctx.save();
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';

	if (stroke.tool === 'eraser') {
		ctx.globalCompositeOperation = 'destination-out';
	} else {
		ctx.globalCompositeOperation = 'source-over';
		ctx.strokeStyle = stroke.color;
		ctx.globalAlpha = stroke.opacity;
	}

	if (points.length === 1) {
		ctx.beginPath();
		const r = Math.max(1, stroke.width * points[0].pressure / 2);
		ctx.arc(points[0].x, points[0].y, r, 0, Math.PI * 2);
		ctx.fillStyle = stroke.tool === 'eraser' ? 'black' : stroke.color;
		ctx.globalAlpha = stroke.tool === 'eraser' ? 1 : stroke.opacity;
		ctx.fill();
		ctx.restore();
		return;
	}

	// Catmull-Romで補間した全ポイントを生成
	const interpolated: PressurePoint[] = [];
	if (points.length === 2) {
		// 2点: 間を4分割
		for (let t = 0; t <= 1; t += 0.25) {
			interpolated.push({
				x: points[0].x + (points[1].x - points[0].x) * t,
				y: points[0].y + (points[1].y - points[0].y) * t,
				pressure: points[0].pressure + (points[1].pressure - points[0].pressure) * t,
			});
		}
	} else {
		// 3点以上: Catmull-Romスプライン補間
		const steps = 10;
		for (let i = 0; i < points.length - 1; i++) {
			const p0 = points[Math.max(0, i - 1)];
			const p1 = points[i];
			const p2 = points[Math.min(points.length - 1, i + 1)];
			const p3 = points[Math.min(points.length - 1, i + 2)];
			for (let step = 0; step <= steps; step++) {
				interpolated.push(catmullRomPoint(p0, p1, p2, p3, step / steps));
			}
		}
	}

	if (interpolated.length < 2) {
		ctx.restore();
		return;
	}

	// 筆圧による太さ変化を反映しつつ、隙間のない描画
	// 短いセグメントごとにlineWidthを変えて個別にstroke（lineCap: roundで接続部の隙間を防ぐ）
	for (let i = 0; i < interpolated.length - 1; i++) {
		const p0 = interpolated[i];
		const p1 = interpolated[i + 1];
		const pressure = (p0.pressure + p1.pressure) / 2;
		ctx.lineWidth = Math.max(0.5, stroke.width * pressure);
		ctx.beginPath();
		ctx.moveTo(p0.x, p0.y);
		ctx.lineTo(p1.x, p1.y);
		ctx.stroke();
	}

	ctx.restore();
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

			// このレイヤーの残りストロークを描画
			for (const stroke of strokes) {
				if ((stroke.layer ?? 0) === layer) {
					renderStroke(lctx, stroke);
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

		// 3. 描画中プレビュー（メインcanvasに直接描画。パフォーマンス優先。）
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
			ctx.beginPath();
			ctx.lineWidth = state.currentWidth * (state.currentPoints[0].pressure || 0.5);
			ctx.moveTo(state.currentPoints[0].x, state.currentPoints[0].y);
			for (let i = 1; i < state.currentPoints.length; i++) {
				ctx.lineTo(state.currentPoints[i].x, state.currentPoints[i].y);
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
		},

		getState() {
			return { ...state };
		},

		setState(partial: Partial<DrawingState>) {
			Object.assign(state, partial);
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
			state.currentPoints = [{ x, y, pressure }];
		},

		moveStroke(x: number, y: number, pressure: number) {
			if (!state.isDrawing) return;
			state.currentPoints.push({ x, y, pressure });

			// リアルタイムプレビュー: 最後の数ポイントを連続パスで描画（隙間なし）
			if (ctx && state.currentPoints.length >= 2) {
				const pts = state.currentPoints;
				// 直近の最大8ポイントを連続パスで描画
				const startIdx = Math.max(0, pts.length - 8);

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

				// 筆圧の平均でlineWidthを設定（連続パスなので統一する必要がある）
				let pressureSum = 0;
				for (let i = startIdx; i < pts.length; i++) {
					pressureSum += pts[i].pressure;
				}
				const avgPressure = pressureSum / (pts.length - startIdx);
				ctx.lineWidth = Math.max(0.5, state.currentWidth * avgPressure);

				ctx.beginPath();
				ctx.moveTo(pts[startIdx].x, pts[startIdx].y);
				for (let i = startIdx + 1; i < pts.length - 1; i++) {
					const midX = (pts[i].x + pts[i + 1].x) / 2;
					const midY = (pts[i].y + pts[i + 1].y) / 2;
					ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
				}
				ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
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

			// アンドゥ上限を超えたらバックグラウンドでマージ（FR-024/FR-025）
			const myStrokes = strokes.filter(s => s.participantId === myParticipantId);
			if (myStrokes.length > MAX_UNDO) {
				// requestAnimationFrameでバックグラウンド実行し、描画操作を妨げない
				window.requestAnimationFrame(() => {
					doMergeOldStrokes();
				});
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
			// 全レイヤーを透明度1.0で合成して出力（作業中のレイヤー透明度は反映しない）
			if (!canvas || !ctx) return '';
			const exportCanvas = window.document.createElement('canvas');
			exportCanvas.width = canvas.width;
			exportCanvas.height = canvas.height;
			const ectx = exportCanvas.getContext('2d')!;
			ectx.fillStyle = '#ffffff';
			ectx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
			for (let layer = MAX_LAYERS - 1; layer >= 0; layer--) {
				const lc = layerCanvases[layer];
				if (!lc) continue;
				ectx.globalAlpha = 1.0;
				ectx.drawImage(lc, 0, 0);
			}
			return exportCanvas.toDataURL(type);
		},

		toMyStrokesDataURL(): string {
			// 自分のストロークを全レイヤー合成して出力（白背景、opacity 1.0）
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
				ectx.globalAlpha = 1.0;
				ectx.drawImage(mc, 0, 0);
			}
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
			strokes.length = 0;
			remoteProgress.clear();
		},
	};
}
