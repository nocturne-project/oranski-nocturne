/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * グループチャットお絵描き型定義
 * paintchatの型定義をベースに、マルチユーザー対応（userId/userName）を維持
 */

// ツールの種類（paintchatからmoveを追加）
export type ToolType = 'move' | 'pen' | 'eraser' | 'eyedropper';

// ジェスチャー状態
export type GestureState = 'none' | 'pan' | 'zoom' | 'hybrid';

// イベント種別
export type EventType = 'touchstart' | 'touchmove' | 'touchend' | 'mousedown' | 'mousemove' | 'mouseup';

// レイヤー設定
export const MAX_LAYERS = 3;

// 座標
export interface Point {
	x: number;
	y: number;
}

// 筆圧座標（paintchat互換）
export interface PressurePoint {
	x: number;
	y: number;
	pressure: number;
}

// タイムスタンプ付き座標
export interface TimedPoint extends Point {
	time: number;
}

// ストロークデータ（paintchatベース + グループチャットのuserId/userName）
export interface StrokeData {
	id: string;
	participantId: string; // paintchat互換（グループチャットではuserId）
	userId: string; // グループチャット用ユーザーID
	userName: string; // グループチャット用表示名
	points: PressurePoint[];
	color: string;
	width: number; // paintchat互換フィールド名
	strokeWidth: number; // グループチャット互換フィールド名（widthと同値）
	opacity: number;
	tool: ToolType;
	layer: number; // レイヤー番号（0=最上層, 2=最下層）
	isHardwarePressure?: boolean; // ハードウェア筆圧で描画されたか（ローカルのみ）
	timestamp: number;
}

// 描画進捗データ（リアルタイムプレビュー用）
export interface ProgressData {
	userId: string;
	userName: string;
	points: PressurePoint[];
	tool: ToolType;
	color: string;
	strokeWidth: number;
	opacity: number;
	layer: number;
	timestamp: number;
}

// カーソルデータ
export interface CursorData {
	userId: string;
	userName: string;
	x: number;
	y: number;
	timestamp: number;
}

// リモートカーソル表示用
export interface RemoteCursor {
	userId: string;
	userName: string;
	x: number;
	y: number;
	color: string;
}

// 描画エンジン状態（paintchatから移植）
export interface DrawingState {
	isDrawing: boolean;
	currentPoints: PressurePoint[];
	currentTool: ToolType;
	currentColor: string;
	currentWidth: number;
	currentOpacity: number;
}

// キャンバス描画エンジン（paintchatのCanvasEngineインターフェースを移植）
export interface CanvasEngine {
	// 初期化（メインcanvasを受け取り、レイヤーcanvasは内部で作成）
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
	setHardwarePressure(isHardware: boolean): void;
	beginStroke(x: number, y: number, pressure: number): void;
	moveStroke(x: number, y: number, pressure: number): void;
	endStroke(): StrokeData | null;
	// リモートストロークの描画
	drawRemoteStroke(stroke: StrokeData): void;
	drawRemoteProgress(participantId: string, points: PressurePoint[]): void;
	// アンドゥ・リドゥ
	undo(): StrokeData | null;
	applyRemoteUndo(strokeId: string): void;
	// ストロークキャンセル（確定せずに破棄）
	cancelStroke(): void;
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

// ツールごとの太さ記憶
export interface ToolStrokeWidths {
	pen: number;
	eraser: number;
}

// デバッグ情報
export interface DebugInfo {
	device: Record<string, any>;
	sizes: Record<string, any>;
	input: Record<string, any>;
	scales: Record<string, any>;
	transform: Record<string, any>;
	final: Record<string, any>;
	lastUpdate: string;
}

// リアルタイム座標
export interface RealtimeCoords {
	screen: string;
	canvas: string;
	isActive: boolean;
}

// 手ぶれ補正設定
export interface HandShakeCorrection {
	enabled: { value: boolean };
	level: { value: number };
	pressureSimulation: { value: boolean };
	stabilization: { value: boolean };
}

// キャンバスサイズ（固定）
export interface CanvasSize {
	name: string;
	width: number;
	height: number;
}

// 通信ログ
export interface CommunicationLog {
	timestamp: number;
	direction: 'send' | 'receive';
	type: string;
	data: any;
}

// トレースログ
export interface DrawingTraceLog {
	timestamp: number;
	type: EventType;
	screenX: number;
	screenY: number;
	canvasX: number;
	canvasY: number;
	tool: string;
	color: string;
	strokeWidth: number;
	zoomLevel: number;
	panOffset: Point;
}

// 補正レベル
export interface CorrectionLevel {
	level: number;
	name: string;
	factor: number;
	minDistance: number;
	velocitySmoothing: number;
}
