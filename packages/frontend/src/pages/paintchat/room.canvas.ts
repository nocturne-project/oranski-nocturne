/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

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
	// 初期化
	init(canvas: HTMLCanvasElement): void;
	// 描画状態
	getState(): DrawingState;
	setState(partial: Partial<DrawingState>): void;
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
	// 画像出力
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

// ストロークを描画する（自動スムージング付き）
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
		// 単一点: 円を描画
		ctx.beginPath();
		ctx.arc(points[0].x, points[0].y, stroke.width / 2, 0, Math.PI * 2);
		ctx.fillStyle = stroke.tool === 'eraser' ? 'black' : stroke.color;
		ctx.globalAlpha = stroke.tool === 'eraser' ? 1 : stroke.opacity;
		ctx.fill();
		ctx.restore();
		return;
	}

	if (points.length === 2) {
		// 2点: 直線
		ctx.beginPath();
		ctx.lineWidth = stroke.width * points[0].pressure;
		ctx.moveTo(points[0].x, points[0].y);
		ctx.lineTo(points[1].x, points[1].y);
		ctx.stroke();
		ctx.restore();
		return;
	}

	// 3点以上: Catmull-Romスプライン補間で滑らかに描画
	const steps = 8; // 補間ステップ数
	for (let i = 0; i < points.length - 1; i++) {
		const p0 = points[Math.max(0, i - 1)];
		const p1 = points[i];
		const p2 = points[Math.min(points.length - 1, i + 1)];
		const p3 = points[Math.min(points.length - 1, i + 2)];

		for (let step = 0; step < steps; step++) {
			const t = step / steps;
			const tNext = (step + 1) / steps;
			const from = catmullRomPoint(p0, p1, p2, p3, t);
			const to = catmullRomPoint(p0, p1, p2, p3, tNext);

			ctx.beginPath();
			ctx.lineWidth = stroke.width * from.pressure;
			ctx.moveTo(from.x, from.y);
			ctx.lineTo(to.x, to.y);
			ctx.stroke();
		}
	}

	ctx.restore();
}

// キャンバスエンジンの生成
export function createCanvasEngine(myParticipantId: string): CanvasEngine {
	let canvas: HTMLCanvasElement | null = null;
	let ctx: CanvasRenderingContext2D | null = null;

	// マージ済みベース画像
	let mergedImageData: ImageData | null = null;

	// ストローク履歴（アンドゥ対象）
	const strokes: StrokeData[] = [];

	// 描画状態
	const state: DrawingState = {
		isDrawing: false,
		currentPoints: [],
		currentTool: 'pen',
		currentColor: '#000000',
		currentWidth: 3,
		currentOpacity: 1.0,
	};

	// リモートの描画進行中データ
	const remoteProgress: Map<string, PressurePoint[]> = new Map();

	let strokeIdCounter = 0;

	function generateStrokeId(): string {
		return `${myParticipantId}-${Date.now()}-${strokeIdCounter++}`;
	}

	// アンドゥ対象外のストロークをフラット化して描画パフォーマンスを維持する（FR-024/FR-025）
	function doMergeOldStrokes(): string | null {
		if (!ctx || !canvas) return null;

		const myStrokes = strokes.filter(s => s.participantId === myParticipantId);
		if (myStrokes.length <= MAX_UNDO) return null;

		const offscreen = window.document.createElement('canvas');
		offscreen.width = canvas.width;
		offscreen.height = canvas.height;
		const offCtx = offscreen.getContext('2d')!;

		offCtx.fillStyle = '#ffffff';
		offCtx.fillRect(0, 0, offscreen.width, offscreen.height);

		if (mergedImageData) {
			offCtx.putImageData(mergedImageData, 0, 0);
		}

		const toMerge = strokes.filter(s => {
			if (s.participantId !== myParticipantId) return true;
			const myIdx = myStrokes.indexOf(s);
			return myIdx < myStrokes.length - MAX_UNDO;
		});

		for (const stroke of toMerge) {
			renderStroke(offCtx, stroke);
		}

		mergedImageData = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);

		for (const stroke of toMerge) {
			const idx = strokes.indexOf(stroke);
			if (idx >= 0) strokes.splice(idx, 1);
		}

		redrawAll();
		return offscreen.toDataURL('image/png');
	}

	// 全体を再描画する
	function redrawAll(): void {
		if (!ctx || !canvas) return;
		ctx.clearRect(0, 0, canvas.width, canvas.height);

		// 白い背景
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		// マージ済み画像があればまず描画
		if (mergedImageData) {
			ctx.putImageData(mergedImageData, 0, 0);
		}

		// ストロークを描画
		for (const stroke of strokes) {
			renderStroke(ctx, stroke);
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

			// 白い背景で初期化
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, 0, canvas.width, canvas.height);
		},

		getState() {
			return { ...state };
		},

		setState(partial: Partial<DrawingState>) {
			Object.assign(state, partial);
		},

		beginStroke(x: number, y: number, pressure: number) {
			state.isDrawing = true;
			state.currentPoints = [{ x, y, pressure }];
		},

		moveStroke(x: number, y: number, pressure: number) {
			if (!state.isDrawing) return;
			state.currentPoints.push({ x, y, pressure });

			// リアルタイムプレビュー描画
			if (ctx && state.currentPoints.length >= 2) {
				const pts = state.currentPoints;
				const from = pts[pts.length - 2];
				const to = pts[pts.length - 1];

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
				ctx.lineWidth = state.currentWidth * pressure;
				ctx.moveTo(from.x, from.y);
				ctx.lineTo(to.x, to.y);
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
			};

			strokes.push(stroke);
			state.currentPoints = [];

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
			// 自分の最後のストロークを削除
			for (let i = strokes.length - 1; i >= 0; i--) {
				if (strokes[i].participantId === myParticipantId) {
					const removed = strokes.splice(i, 1)[0];
					redrawAll();
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
			mergedImageData = null;
			if (ctx && canvas) {
				ctx.clearRect(0, 0, canvas.width, canvas.height);
				ctx.fillStyle = '#ffffff';
				ctx.fillRect(0, 0, canvas.width, canvas.height);
			}
		},

		redraw() {
			redrawAll();
		},

		mergeOldStrokes(): string | null {
			return doMergeOldStrokes();
		},

		toDataURL(type = 'image/png'): string {
			return canvas?.toDataURL(type) ?? '';
		},

		toMyStrokesDataURL(): string {
			if (!canvas) return '';

			// 自分のストロークのみを描画したキャンバスを生成
			const offscreen = window.document.createElement('canvas');
			offscreen.width = canvas.width;
			offscreen.height = canvas.height;
			const offCtx = offscreen.getContext('2d')!;

			// 透明背景
			offCtx.clearRect(0, 0, offscreen.width, offscreen.height);

			// 白い背景
			offCtx.fillStyle = '#ffffff';
			offCtx.fillRect(0, 0, offscreen.width, offscreen.height);

			for (const stroke of strokes) {
				if (stroke.participantId === myParticipantId) {
					renderStroke(offCtx, stroke);
				}
			}

			return offscreen.toDataURL('image/png');
		},

		dispose() {
			canvas = null;
			ctx = null;
			strokes.length = 0;
			remoteProgress.clear();
		},
	};
}
