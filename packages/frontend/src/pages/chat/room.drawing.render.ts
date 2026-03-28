/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * グループチャットお絵描き - レンダリング処理
 * paintchatのCatmull-Romスプライン描画、フェードイン/アウト、連続パスをCanvasEngineに統合済み。
 * このファイルはCanvasEngine外で使用するユーティリティ関数を提供する。
 */

import type { PressurePoint } from './room.drawing.types.js';

// Catmull-Romスプライン補間（CanvasEngine内部と同じアルゴリズム）
// テストやユーティリティ用にexport
export function catmullRomPoint(
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

// 速度ベースの筆圧シミュレーション（paintchat準拠）
// 速い描画 -> 細い線、遅い描画 -> 太い線
// フェードイン: 最初の5ポイント、範囲: 0.15-0.6
export function simulatePressure(
	points: PressurePoint[],
	index: number,
): number {
	if (index === 0 || points.length < 2) return 0.5;

	const prev = points[Math.max(0, index - 1)];
	const curr = points[index];
	const dx = curr.x - prev.x;
	const dy = curr.y - prev.y;
	const speed = Math.sqrt(dx * dx + dy * dy);

	// 速度 -> 筆圧の変換
	let pressure = 0.5 - speed * 0.2;
	pressure = Math.max(0.15, Math.min(0.6, pressure));

	// 最初の5ポイントでフェードイン
	if (index < 5) {
		pressure *= (index + 1) / 6;
	}

	return pressure;
}

// 入力時のスムージング（SMOOTHING_FACTOR=0.4）
// 指描き・マウス用。Apple Pencilでは適用しない。
export const SMOOTHING_FACTOR = 0.4;

export function smoothPoint(
	current: PressurePoint,
	previous: PressurePoint,
	factor: number = SMOOTHING_FACTOR,
): PressurePoint {
	return {
		x: previous.x + (current.x - previous.x) * (1 - factor),
		y: previous.y + (current.y - previous.y) * (1 - factor),
		pressure: current.pressure,
	};
}

// 筆圧スムージング（factor=0.35）
export const PRESSURE_SMOOTHING_FACTOR = 0.35;

export function smoothPressure(
	current: number,
	previous: number,
	factor: number = PRESSURE_SMOOTHING_FACTOR,
): number {
	return previous + (current - previous) * (1 - factor);
}

// 最小移動距離フィルタ（1.5px - paintchat準拠）
export const MIN_MOVE_DISTANCE = 1.5;

export function isMinimumDistance(
	current: PressurePoint,
	previous: PressurePoint,
	minDistance: number = MIN_MOVE_DISTANCE,
): boolean {
	const dx = current.x - previous.x;
	const dy = current.y - previous.y;
	return Math.sqrt(dx * dx + dy * dy) >= minDistance;
}
