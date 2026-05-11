/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * グループチャットお絵描き - 座標変換
 * キャンバスサイズ1600x1200固定に対応、座標クランプ範囲更新
 */

import type { Point } from './room.drawing.types.js';

// 固定キャンバスサイズ（paintchat準拠）
export const CANVAS_WIDTH = 1600;
export const CANVAS_HEIGHT = 1200;

// 実際の描画可能領域を計算（アスペクト比を保持）
export function getActualDrawingArea(
	canvasEl: HTMLCanvasElement | null,
	canvasWidth: number = CANVAS_WIDTH,
	canvasHeight: number = CANVAS_HEIGHT,
): { x: number; y: number; width: number; height: number; scale: number } {
	if (!canvasEl) return { x: 0, y: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT, scale: 1 };

	const rect = canvasEl.getBoundingClientRect();
	const containerWidth = rect.width;
	const containerHeight = rect.height;

	const canvasAspect = canvasWidth / canvasHeight;
	const containerAspect = containerWidth / containerHeight;

	let actualWidth: number;
	let actualHeight: number;
	let offsetX: number;
	let offsetY: number;
	let scale: number;

	if (containerAspect > canvasAspect) {
		actualHeight = containerHeight;
		actualWidth = actualHeight * canvasAspect;
		offsetX = (containerWidth - actualWidth) / 2;
		offsetY = 0;
		scale = actualHeight / canvasHeight;
	} else {
		actualWidth = containerWidth;
		actualHeight = actualWidth / canvasAspect;
		offsetX = 0;
		offsetY = (containerHeight - actualHeight) / 2;
		scale = actualWidth / canvasWidth;
	}

	return {
		x: offsetX,
		y: offsetY,
		width: actualWidth,
		height: actualHeight,
		scale: scale,
	};
}

// スクリーン座標をキャンバス座標に変換
// getBoundingClientRectはCSS transform適用後の座標を返すため、
// zoom/panの逆変換は自動的に行われる
export function screenToCanvasCoordinates(
	clientX: number,
	clientY: number,
	canvasEl: HTMLCanvasElement | null,
	canvasWidth: number = CANVAS_WIDTH,
	canvasHeight: number = CANVAS_HEIGHT,
): Point {
	if (!canvasEl) return { x: clientX, y: clientY };

	const canvasRect = canvasEl.getBoundingClientRect();

	// canvas要素内の相対座標（CSS transform適用後）
	const canvasRelativeX = clientX - canvasRect.left;
	const canvasRelativeY = clientY - canvasRect.top;

	// transformedSize = displaySize x zoomLevel
	const transformedWidth = canvasRect.width;
	const transformedHeight = canvasRect.height;

	// 正規化座標（0-1）に変換 -> 論理キャンバス座標に変換
	const normalizedX = canvasRelativeX / transformedWidth;
	const normalizedY = canvasRelativeY / transformedHeight;

	let logicalX = normalizedX * canvasWidth;
	let logicalY = normalizedY * canvasHeight;

	// 論理キャンバス範囲内にクランプ
	logicalX = Math.max(0, Math.min(canvasWidth, logicalX));
	logicalY = Math.max(0, Math.min(canvasHeight, logicalY));

	return {
		x: Math.round(logicalX * 10) / 10,
		y: Math.round(logicalY * 10) / 10,
	};
}
